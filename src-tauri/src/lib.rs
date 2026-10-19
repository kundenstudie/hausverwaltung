// HAVEWA-07C — Tauri v2 Entry + Plugin-Wiring + App-Bootstrap.
//
// Architektur (07C Review-Fixes B-1, H-1, H-2):
//   - Single-Instance-Plugin (zweiter Start: Fokus auf primary)
//   - Splash sichtbar (Konfig); Main hidden (Konfig)
//   - Nach Ready: bestehendes main per get_webview_window("main") wiederverwenden,
//     auf http://127.0.0.1:<port> navigieren, anzeigen, Splash schließen
//   - On Window-Close: kontrollierter Shutdown
//       1) POST /api/shutdown mit SHUTDOWN_TOKEN (loopback)
//       2) warten auf Child-Exit (Node-Parent beendet Postgres sauber)
//       3) Fail-safe: TerminateProcess NUR auf das EIGENE Child,
//          nach Timeout, niemals nach Prozessname
//   - Navigation-Guard: on_navigation blockiert alles außer Loopback-URLs
//   - Capabilities in `capabilities/default.json` (least privilege).
//
// Kein Rekonstruieren eines Child-Handles aus PID. PID-Reuse wäre
// unsicher; das echte std::process::Child wird vom Spawn bis zum
// Shutdown gehalten.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub mod acl;
pub mod error;
pub mod navigation;
pub mod paths;
pub mod port_state;
pub mod runtime;
pub mod secrets;
pub mod shutdown;
pub mod startup;

use acl::AclRunner;
use startup::{Orchestrator, StartupConfig};

/// Globaler App-State. Hält das ECHTE Child-Handle des gespawnten
/// Node-Prozesses (nicht nur PID). Das Handle wird beim Spawn
/// erzeugt und im `AppState` abgelegt; das eigentliche Process-Spawning
/// passiert NICHT in `setup`, sondern im `Orchestrator` (siehe
/// `startup::run`) — wir reichen das Handle von dort in den State.
pub struct AppState {
    /// ECHTES Child-Handle des Node-Parent (start-runtime-with-pg.mjs).
    /// Option, weil Startup asynchron ist.
    pub runtime_child: Mutex<Option<runtime::ChildHandle>>,
    /// Shutdown-Token, der an /api/shutdown gesendet wird.
    pub shutdown_token: Mutex<Option<String>>,
    /// Loopback-Host des Backends (aus port.json).
    pub loopback_host: Mutex<Option<String>>,
    /// Port des Backends (aus port.json).
    pub loopback_port: Mutex<Option<u16>>,
    /// Shutdown bereits angefordert (Idempotenz).
    pub shutdown_requested: Mutex<bool>,
}

/// Public Entry (lib).
pub fn run() {
    if let Err(e) = run_inner() {
        // Keine Geheimnisse im Display.
        eprintln!("[havewa-desktop] FATAL: {e}");
        std::process::exit(1);
    }
}

fn run_inner() -> error::AppResult<()> {
    let cfg = StartupConfig::from_env_or_default()?;

    let state = AppState {
        runtime_child: Mutex::new(None),
        shutdown_token: Mutex::new(None),
        loopback_host: Mutex::new(None),
        loopback_port: Mutex::new(None),
        shutdown_requested: Mutex::new(false),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // KEIN Logging von argv-Inhalten (Auftrag §9 / §6).
            // Nur Fokus auf bestehendes main.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            eprintln!("[havewa-desktop] second instance ignored: focusing primary main window");
        }))
        .manage(state)
        .invoke_handler(tauri::generate_handler![])
        .setup(move |app| {
            let handle = app.handle().clone();
            let mut orch = Orchestrator::new(cfg);
            let steps: Box<dyn startup::StartupSteps> = Box::new(startup::RealSteps);
            let runner: Box<dyn AclRunner> = Box::new(acl::IcaclsRunner::new());

            // Startup-Thread: alle Side-Effects (Secrets, ACL, Spawn, Port-Wait,
            // Readiness) laufen hier. Window-Manipulationen (navigate, show,
            // close) verwenden die AppHandle, die thread-safe ist und intern
            // an den Event-Loop dispatcht.
            std::thread::spawn(move || {
                let result = orch.run(&*steps, runner.as_ref());
                match result {
                    Ok(port) => {
                        // State füllen: ECHTES Child-Handle, Token, Loopback-Info.
                        if let Some(state) = handle.try_state::<AppState>() {
                            if let Ok(mut g) = state.runtime_child.lock() {
                                *g = orch.child_handle.take();
                            }
                            if let Ok(mut g) = state.shutdown_token.lock() {
                                *g = orch.last_secrets.as_ref().map(|s| s.shutdown_token.clone());
                            }
                            if let Ok(mut g) = state.loopback_host.lock() {
                                *g = Some(port.host.clone());
                            }
                            if let Ok(mut g) = state.loopback_port.lock() {
                                *g = Some(port.port);
                            }
                        }
                        // Bestehendes hidden main wiederverwenden (B-1).
                        if let Err(e) = show_existing_main(&handle, &port.host, port.port) {
                            eprintln!("[havewa-desktop] main window show failed: {e}");
                            // Splash schließen, damit UI nicht offen bleibt.
                            if let Some(s) = handle.get_webview_window("splash") {
                                let _ = s.close();
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[havewa-desktop] startup failed: {e}");
                        // Splash mit Fehler schließen. Main nicht zeigen.
                        if let Some(s) = handle.get_webview_window("splash") {
                            let _ = s.close();
                        }
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .map_err(|_| error::AppError::PluginInit("builder.build"))?
        .run(|app_handle, event| {
            // Auftrag §8: kontrollierter Shutdown.
            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { .. },
                ..
            } = &event
            {
                if label == "main" {
                    // Synchroner Shutdown-Pfad: API-Call + Child-Wait + Fail-safe.
                    // Wir blockieren den CloseRequested-Handler bewusst, damit
                    // der Node-Child sauber herunterfahren kann, bevor Tauri
                    // das Fenster tatsächlich schließt.
                    perform_controlled_shutdown(app_handle);
                }
            }
            // Standardmäßig Exit zulassen. ExitRequested wird NICHT
            // abgefangen, damit nach erfolgreichem Shutdown Tauri normal
            // beenden kann.
        });

    Ok(())
}

/// Main-Window per Builder erstellen (Architektur B, Auftrag §3).
///
/// - main ist NICHT in tauri.conf.json definiert → kein Duplicate-Label-Risiko.
/// - Navigation-Guard (on_navigation) wird hier gesetzt → Top-Level-Navigation
///   zu Remote-Hosts ist blockiert (CSP allein reicht dafür NICHT).
/// - Erlaubt sind: about:*, http(s)://127.0.0.1[:port], http(s)://::1[:port],
///   http(s)://localhost[:port].
fn show_existing_main(
    handle: &tauri::AppHandle,
    host: &str,
    port: u16,
) -> error::AppResult<()> {
    let url = format!("http://{host}:{port}");

    let allowed_hosts: &'static [&'static str] = &["127.0.0.1", "::1", "localhost"];
    let guard = navigation::build_guard(allowed_hosts);

    let main = WebviewWindowBuilder::new(
        handle,
        "main",
        WebviewUrl::External(url.parse().map_err(|_| error::AppError::Webview("url_parse"))?),
    )
    .title("HaVeWa")
    .inner_size(1280.0, 800.0)
    .min_inner_size(960.0, 600.0)
    .resizable(true)
    .center()
    .on_navigation(guard)
    .build()
    .map_err(|_| error::AppError::Webview("build_main"))?;

    main.show().map_err(|_| error::AppError::Webview("show_main"))?;
    main.set_focus()
        .map_err(|_| error::AppError::Webview("focus_main"))?;

    // Splash schließen.
    if let Some(s) = handle.get_webview_window("splash") {
        let _ = s.close();
    }

    Ok(())
}

/// Kontrollierter Shutdown (Auftrag §8).
///
/// Sequenz:
///   1) Idempotenz-Guard: nur einmal ausführen.
///   2) SHUTDOWN_TOKEN + Loopback aus AppState holen.
///   3) POST /api/shutdown mit Token senden (202 = Erfolg).
///   4) Auf Child-Exit warten (mit Timeout).
///   5) Falls Child nicht beendet: TerminateProcess NUR auf das
///      EIGENE Child-Handle (Fail-safe).
///   6) Keine fremden Prozesse anfassen, kein kill-by-name.
fn perform_controlled_shutdown(app_handle: &tauri::AppHandle) {
    // Schritt 1: Idempotenz.
    let already = {
        if let Some(state) = app_handle.try_state::<AppState>() {
            if let Ok(mut g) = state.shutdown_requested.lock() {
                if *g {
                    true
                } else {
                    *g = true;
                    false
                }
            } else {
                true // lock failed: assume already requested, fail-safe
            }
        } else {
            true
        }
    };
    if already {
        return;
    }

    // Schritt 2: State lesen.
    let (token, host, port) = {
        let state = match app_handle.try_state::<AppState>() {
            Some(s) => s,
            None => return,
        };
        let token = state
            .shutdown_token
            .lock()
            .ok()
            .and_then(|g| g.clone());
        let host = state.loopback_host.lock().ok().and_then(|g| g.clone());
        let port = state.loopback_port.lock().ok().and_then(|g| *g);
        (token, host, port)
    };

    // Schritt 3: POST /api/shutdown.
    if let (Some(token), Some(host), Some(port)) = (token.as_deref(), host, port) {
        let url = format!("http://{host}:{port}/api/shutdown");
        match shutdown::call_shutdown_api(url, token, Duration::from_secs(5)) {
            Ok(()) => {
                eprintln!("[havewa-desktop] shutdown api accepted");
            }
            Err(e) => {
                eprintln!("[havewa-desktop] shutdown api failed: {e} (will fallback to child-wait)");
            }
        }
    } else {
        eprintln!("[havewa-desktop] shutdown api skipped: missing token/host/port");
    }

    // Schritt 4+5: auf Child-Exit warten, dann Fail-safe.
    if let Some(state) = app_handle.try_state::<AppState>() {
        if let Ok(mut guard) = state.runtime_child.lock() {
            if let Some(mut child) = guard.take() {
                // Graceful Wait + Fail-safe TerminateProcess (NUR eigenes Child).
                let _ = runtime::graceful_shutdown(&mut child, Duration::from_secs(10));
            }
        }
    }
}

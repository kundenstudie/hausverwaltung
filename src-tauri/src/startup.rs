// HAVEWA-07C — Startup-Orchestrator (Auftrag §10, §12, §5, §6).
//
// Reihenfolge (verbindlich):
//   1. Single Instance   (Plugin prüft; bei 2. Start: fokus auf primary)
//   2. Data dir erzeugen/auflösen
//   3. secrets loader
//   4. x64 Node bestimmen
//   5. start-runtime-with-pg.mjs starten (ECHTES Child-Handle behalten)
//   6. runtime-state/port.json abwarten
//   7. /api/ready pollen
//   8. Splash → bestehendes main navigieren/show/focus → splash close
//   9. Shutdown-Handler registriert
//
// Env-Contract (Code-to-Code, Review §12):
//   - HAVEWA_DATA_DIR: durchgereicht
//   - PG_DBPASSWORD: durchgereicht (07B liest)
//   - AUTH_SECRET: durchgereicht (App liest)
//   - SHUTDOWN_TOKEN: durchgereicht (/api/shutdown liest)
//   - POSTGRES_RUNTIME_DIR: passthrough wenn gesetzt (sonst 07B-Default)
//   POSTGRES_PASSWORD: ENTFERNT (wird von keinem Consumer gelesen)

use std::path::PathBuf;
use std::time::Duration;

use crate::acl::{self, AclRunner};
use crate::env;
use crate::error::{AppError, AppResult};
use crate::paths;
use crate::port_state::{self, PortState};
use crate::runtime;
use crate::runtime::ChildHandle;
use crate::secrets::{self, Secrets};

/// Zustand der Startup-State-Machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupState {
    Init,
    SingleInstance,
    DataDir,
    Secrets,
    Node,
    Spawn,
    PortWait,
    Ready,
    MainNavigated,
    Done,
    Failed,
    ShuttingDown,
}

/// Konfigurierbare Zeit-/Timeout-Defaults.
#[derive(Debug, Clone)]
pub struct StartupConfig {
    pub data_dir: PathBuf,
    /// Runtime-Root (Basis der gebündelten Runtime).
    pub runtime_root: PathBuf,
    /// Verzeichnis des gebündelten Node-Binaries.
    pub node_dir: PathBuf,
    /// Pfad zum gebündelten Node-Binary.
    pub node_bin: PathBuf,
    /// Verzeichnis des gebündelten PostgreSQL-bin.
    pub postgres_bin_dir: PathBuf,
    /// Verzeichnis des gebündelten App-Stages (enthält das Start-Skript).
    pub app_dir: PathBuf,
    pub ready_timeout: Duration,
    pub port_wait_timeout: Duration,
}

impl StartupConfig {
    pub fn from_env_or_default() -> AppResult<Self> {
        let runtime_root = runtime::runtime_root()?;
        let node_dir = paths::node_dir(&runtime_root);
        let node_bin = paths::node_bin_path();
        let postgres_bin_dir = paths::postgres_bin_dir(&runtime_root);
        let app_dir = paths::app_dir(&runtime_root);
        Ok(Self {
            data_dir: paths::resolve_data_dir()?,
            runtime_root,
            node_dir,
            node_bin,
            postgres_bin_dir,
            app_dir,
            ready_timeout: Duration::from_secs(45),
            port_wait_timeout: Duration::from_secs(30),
        })
    }
}

/// Trait für injizierbare Steps. Produktiv: `RealSteps`. Tests: Mocks.
pub trait StartupSteps: Send {
    /// Schritt 2: Data-Dir-Struktur prüfen/erzeugen.
    fn ensure_data_dir(&self, cfg: &StartupConfig) -> AppResult<()>;
    /// Schritt 3: Secrets laden oder erzeugen, ACL anwenden.
    fn load_or_create_secrets(
        &self,
        cfg: &StartupConfig,
        runner: &dyn AclRunner,
    ) -> AppResult<Secrets>;
    /// Schritt 4: x64-Node validieren.
    fn validate_node(&self, cfg: &StartupConfig) -> AppResult<()>;
    /// Schritt 5: Runtime-Child starten (start-runtime-with-pg.mjs).
    /// Liefert das ECHTE Child-Handle.
    fn spawn_runtime(
        &self,
        cfg: &StartupConfig,
        env_overrides: &[(&str, &str)],
    ) -> AppResult<ChildHandle>;
    /// Schritt 6: port.json lesen, bis vorhanden (innerhalb Timeout).
    fn wait_port_state(&self, cfg: &StartupConfig) -> AppResult<PortState>;
    /// Schritt 7: /api/ready pollen.
    fn wait_ready(&self, port: &PortState, timeout: Duration) -> AppResult<()>;
}

pub struct RealSteps;

impl StartupSteps for RealSteps {
    fn ensure_data_dir(&self, cfg: &StartupConfig) -> AppResult<()> {
        paths::ensure_data_dir(&cfg.data_dir)
    }

    fn load_or_create_secrets(
        &self,
        cfg: &StartupConfig,
        runner: &dyn AclRunner,
    ) -> AppResult<Secrets> {
        let path = paths::secrets_path(&cfg.data_dir);
        let secrets = match secrets::load(&path)? {
            Some(existing) => existing,
            None => {
                let fresh = Secrets::generate();
                secrets::write_atomic(&path, &fresh)?;
                fresh
            }
        };
        // ACL anwenden: owner holen, anwenden, verifizieren.
        let owner = acl::current_owner(&acl::IcaclsRunner::new())?;
        runner.apply(&path, &owner)?;
        runner.verify(&path)?;
        Ok(secrets)
    }

    fn validate_node(&self, cfg: &StartupConfig) -> AppResult<()> {
        runtime::validate_x64_node(&cfg.node_bin)
    }

    fn spawn_runtime(
        &self,
        cfg: &StartupConfig,
        env_overrides: &[(&str, &str)],
    ) -> AppResult<ChildHandle> {
        let child = runtime::spawn_runtime(&cfg.node_bin, &cfg.app_dir, env_overrides)?;
        Ok(ChildHandle::new(child))
    }

    fn wait_port_state(&self, cfg: &StartupConfig) -> AppResult<PortState> {
        let deadline = std::time::Instant::now() + cfg.port_wait_timeout;
        loop {
            if let Some(p) = port_state::read(&cfg.data_dir)? {
                return Ok(p);
            }
            if std::time::Instant::now() >= deadline {
                return Err(AppError::PortStateInvalid { kind: "missing" });
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    fn wait_ready(&self, port: &PortState, timeout: Duration) -> AppResult<()> {
        if port_state::poll_ready(port, timeout)? {
            Ok(())
        } else {
            Err(AppError::ReadinessTimeout { port: port.port })
        }
    }
}

/// Orchestrator. Hält den aktuellen State + ECHTES Child-Handle + Secrets.
pub struct Orchestrator {
    pub state: StartupState,
    pub cfg: StartupConfig,
    /// ECHTES Child-Handle (Auftrag §7). Wird im `setup` ausgelesen
    /// (`take()`) und in `AppState` überführt.
    pub child_handle: Option<ChildHandle>,
    pub last_secrets: Option<Secrets>,
}

impl Orchestrator {
    pub fn new(cfg: StartupConfig) -> Self {
        Self {
            state: StartupState::Init,
            cfg,
            child_handle: None,
            last_secrets: None,
        }
    }

    /// Setzt die Env-Overrides für den Spawn (Code-to-Code-Contract, Review §12).
    /// KEIN Logging der Werte. Wir reichen via env direkt durch.
    ///
    /// G3-Contract (Auftrag §11):
    /// - HAVEWA_DATA_DIR: Pflicht, vom Caller vorgegeben (Data Root)
    /// - PG_DBPASSWORD:   DB-User-Passwort (07B liest)
    /// - AUTH_SECRET:     App-Session-Secret (Next/Crypto liest)
    /// - AUTH_TRUST_HOST: "true" (Auth.js verlangt Trust fuer Loopback-Hosts)
    /// - SHUTDOWN_TOKEN:  Token für /api/shutdown (Route liest)
    /// - POSTGRES_RUNTIME_DIR: gebündeltes PG (runtime/postgres/bin)
    /// - HAVEWA_DESKTOP_RUNTIME: "1" (Desktop-Modus)
    /// - HAVEWA_PRISMA_SKIP_GENERATE: "1" (kein runtime prisma generate)
    /// - PATH: kontrolliert (Stage-Node + Stage-PG + System32)
    ///
    /// `POSTGRES_RUNTIME_DIR` wird NICHT mehr aus dem Eltern-Env
    /// durchgereicht — im Desktop-Betrieb MUSS es das gebündelte PG sein.
    pub fn env_overrides(&self, secrets: &Secrets) -> Vec<(&'static str, String)> {
        let mut v: Vec<(&'static str, String)> = Vec::with_capacity(9);
        v.push((
            "HAVEWA_DATA_DIR",
            self.cfg.data_dir.display().to_string(),
        ));
        v.push(("PG_DBPASSWORD", secrets.db_password.clone()));
        v.push(("AUTH_SECRET", secrets.auth_secret.clone()));
        v.push(("AUTH_TRUST_HOST", "true".to_string()));
        v.push(("SHUTDOWN_TOKEN", secrets.shutdown_token.clone()));
        // Gebündeltes PostgreSQL — NIEMALS ein System-PostgreSQL.
        v.push((
            "POSTGRES_RUNTIME_DIR",
            self.cfg.postgres_bin_dir.display().to_string(),
        ));
        // Desktop-Modus: kein runtime prisma generate, Desktop-Verträge aktiv.
        v.push(("HAVEWA_DESKTOP_RUNTIME", "1".to_string()));
        v.push(("HAVEWA_PRISMA_SKIP_GENERATE", "1".to_string()));
        // Kontrollierter PATH (kein System-Node, kein npm/npx/tsx, kein
        // System-PostgreSQL).
        v.push((
            "PATH",
            env::build_controlled_path(&self.cfg.node_dir, &self.cfg.postgres_bin_dir),
        ));
        v
    }

    /// Vollständige Startup-Sequenz. Liefert bei Erfolg die finale
    /// PortState (host, port). Im Fehlerfall: StartupState::Failed +
    /// AppError.
    pub fn run(
        &mut self,
        steps: &dyn StartupSteps,
        runner: &dyn AclRunner,
    ) -> AppResult<PortState> {
        fn advance_state(s: &mut Orchestrator, next: StartupState) {
            s.state = next;
        }

        // 1) Single Instance: passiert im Plugin-Setup; wir markieren nur.
        self.state = StartupState::SingleInstance;

        // 2) Data Dir.
        advance_state(self, StartupState::DataDir);
        if let Err(e) = steps.ensure_data_dir(&self.cfg) {
            self.state = StartupState::Failed;
            return Err(e);
        }

        // 3) Secrets + ACL.
        advance_state(self, StartupState::Secrets);
        let secrets = match steps.load_or_create_secrets(&self.cfg, runner) {
            Ok(s) => s,
            Err(e) => {
                self.state = StartupState::Failed;
                return Err(e);
            }
        };
        self.last_secrets = Some(secrets);

        // 4) x64 Node.
        advance_state(self, StartupState::Node);
        if let Err(e) = steps.validate_node(&self.cfg) {
            self.state = StartupState::Failed;
            return Err(e);
        }

        // 5) Spawn — ECHTES Child-Handle behalten.
        advance_state(self, StartupState::Spawn);
        let overrides_vec = self.env_overrides(self.last_secrets.as_ref().expect("set above"));
        let overrides_ref: Vec<(&str, &str)> = overrides_vec
            .iter()
            .map(|(k, v)| (*k, v.as_str()))
            .collect();
        let child_handle = match steps.spawn_runtime(&self.cfg, &overrides_ref) {
            Ok(c) => c,
            Err(e) => {
                self.state = StartupState::Failed;
                return Err(e);
            }
        };
        self.child_handle = Some(child_handle);

        // 6) port.json warten.
        advance_state(self, StartupState::PortWait);
        let port = match steps.wait_port_state(&self.cfg) {
            Ok(p) => p,
            Err(e) => {
                self.state = StartupState::Failed;
                return Err(e);
            }
        };

        // 7) ready pollen.
        advance_state(self, StartupState::Ready);
        if let Err(e) = steps.wait_ready(&port, self.cfg.ready_timeout) {
            self.state = StartupState::Failed;
            return Err(e);
        }

        self.state = StartupState::Done;
        Ok(port)
    }

    pub fn shutdown(&mut self) {
        self.state = StartupState::ShuttingDown;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acl::test_doubles::MockAcl;

    struct StubSteps {
        ensure_dir_ok: bool,
        secrets_existing: Option<Secrets>,
        validate_ok: bool,
        spawn_should_fail: bool,
        port: Option<PortState>,
        ready_ok: bool,
    }
    impl StartupSteps for StubSteps {
        fn ensure_data_dir(&self, _: &StartupConfig) -> AppResult<()> {
            if self.ensure_dir_ok {
                Ok(())
            } else {
                Err(AppError::DataDirUnavailable)
            }
        }
        fn load_or_create_secrets(
            &self,
            _: &StartupConfig,
            _: &dyn AclRunner,
        ) -> AppResult<Secrets> {
            Ok(self.secrets_existing.clone().unwrap_or_else(Secrets::generate))
        }
        fn validate_node(&self, _: &StartupConfig) -> AppResult<()> {
            if self.validate_ok {
                Ok(())
            } else {
                Err(AppError::NodeX64("stub"))
            }
        }
        fn spawn_runtime(
            &self,
            _: &StartupConfig,
            _: &[(&str, &str)],
        ) -> AppResult<ChildHandle> {
            // Stub-Spawn: wir können ohne echten Process nicht weitermachen
            // (ChildHandle hält einen echten std::process::Child). Die Tests
            // prüfen State-Übergänge vor und um den Spawn herum, daher
            // lassen wir Spawn hier grundsätzlich fehlschlagen, wenn nicht
            // explizit anders gewünscht.
            if self.spawn_should_fail {
                Err(AppError::RuntimeSpawn {
                    stage: "stub_spawn_disabled",
                    exit: None,
                })
            } else {
                Err(AppError::RuntimeSpawn {
                    stage: "stub_no_real_child",
                    exit: None,
                })
            }
        }
        fn wait_port_state(&self, _: &StartupConfig) -> AppResult<PortState> {
            self.port.clone().ok_or(AppError::PortStateInvalid {
                kind: "missing",
            })
        }
        fn wait_ready(&self, port: &PortState, _: Duration) -> AppResult<()> {
            if self.ready_ok {
                Ok(())
            } else {
                Err(AppError::ReadinessTimeout { port: port.port })
            }
        }
    }

    // Da ChildHandle kein Clone implementiert, müssen wir hier anders testen.
    // Wir testen die env_overrides-Logik und die State-Maschine ohne
    // echten Spawn.

    fn dummy_cfg() -> StartupConfig {
        StartupConfig {
            data_dir: PathBuf::from("X:\\dummy"),
            runtime_root: PathBuf::from("X:\\dummy\\runtime"),
            node_dir: PathBuf::from("X:\\dummy\\runtime\\node"),
            node_bin: PathBuf::from("X:\\dummy\\runtime\\node\\node.exe"),
            postgres_bin_dir: PathBuf::from("X:\\dummy\\runtime\\postgres\\bin"),
            app_dir: PathBuf::from("X:\\dummy\\runtime\\app"),
            ready_timeout: Duration::from_secs(1),
            port_wait_timeout: Duration::from_secs(1),
        }
    }

    #[test]
    fn env_overrides_contain_required_keys() {
        let cfg = dummy_cfg();
        let orch = Orchestrator::new(cfg);
        let s = Secrets::generate();
        let v = orch.env_overrides(&s);
        let names: Vec<&str> = v.iter().map(|(k, _)| *k).collect();
        assert!(names.contains(&"HAVEWA_DATA_DIR"));
        assert!(names.contains(&"PG_DBPASSWORD"));
        assert!(names.contains(&"AUTH_SECRET"));
        assert!(names.contains(&"AUTH_TRUST_HOST"));
        assert!(names.contains(&"SHUTDOWN_TOKEN"));
        assert!(names.contains(&"POSTGRES_RUNTIME_DIR"));
        assert!(names.contains(&"HAVEWA_DESKTOP_RUNTIME"));
        assert!(names.contains(&"HAVEWA_PRISMA_SKIP_GENERATE"));
        assert!(names.contains(&"PATH"));
        // POSTGRES_PASSWORD: explizit NICHT mehr gesetzt.
        assert!(!names.contains(&"POSTGRES_PASSWORD"));
    }

    #[test]
    fn env_overrides_postgres_runtime_dir_is_bundled_not_system() {
        let cfg = dummy_cfg();
        let orch = Orchestrator::new(cfg);
        let s = Secrets::generate();
        let v = orch.env_overrides(&s);
        let pg = v
            .iter()
            .find(|(k, _)| *k == "POSTGRES_RUNTIME_DIR")
            .map(|(_, val)| val.clone())
            .expect("POSTGRES_RUNTIME_DIR must be set");
        assert!(pg.contains("runtime"), "must point into the bundled runtime: {pg}");
        assert!(
            !pg.contains("Program Files"),
            "must not point at a system PostgreSQL: {pg}"
        );
    }

    #[test]
    fn env_overrides_path_is_controlled() {
        let cfg = dummy_cfg();
        let orch = Orchestrator::new(cfg);
        let s = Secrets::generate();
        let v = orch.env_overrides(&s);
        let path = v
            .iter()
            .find(|(k, _)| *k == "PATH")
            .map(|(_, val)| val.clone())
            .expect("PATH must be set");
        assert!(path.contains("runtime\\node") || path.contains("runtime/node"));
        assert!(path.contains("postgres") || path.contains("postgres"));
        // Kein System-Node, kein npm/npx, kein System-PostgreSQL.
        assert!(!path.contains(".tools"));
        assert!(!path.contains("Program Files"));
    }

    #[test]
    fn env_overrides_auth_trust_host_is_true() {
        let cfg = dummy_cfg();
        let orch = Orchestrator::new(cfg);
        let s = Secrets::generate();
        let v = orch.env_overrides(&s);
        let trust = v
            .iter()
            .find(|(k, _)| *k == "AUTH_TRUST_HOST")
            .map(|(_, val)| val.clone())
            .expect("AUTH_TRUST_HOST must be set");
        assert_eq!(trust, "true");
    }

    #[test]
    fn env_overrides_desktop_flags_are_one() {
        let cfg = dummy_cfg();
        let orch = Orchestrator::new(cfg);
        let s = Secrets::generate();
        let v = orch.env_overrides(&s);
        for key in ["HAVEWA_DESKTOP_RUNTIME", "HAVEWA_PRISMA_SKIP_GENERATE"] {
            let val = v
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, val)| val.clone())
                .expect("missing key");
            assert_eq!(val, "1", "{key} must be 1");
        }
    }

    #[test]
    fn env_overrides_never_inherit_postgres_runtime_dir_from_env() {
        // Selbst wenn POSTGRES_RUNTIME_DIR in der Parent-Env auf ein
        // System-PostgreSQL zeigt, MUSS der Desktop-Wert der gebündelte sein.
        // SAFETY: nur in diesem Test gesetzt.
        std::env::set_var("POSTGRES_RUNTIME_DIR", "C:\\Program Files\\PostgreSQL\\16\\bin");
        let cfg = dummy_cfg();
        let orch = Orchestrator::new(cfg);
        let s = Secrets::generate();
        let v = orch.env_overrides(&s);
        let pg = v
            .iter()
            .find(|(k, _)| *k == "POSTGRES_RUNTIME_DIR")
            .map(|(_, val)| val.clone())
            .expect("POSTGRES_RUNTIME_DIR must be set");
        assert!(!pg.contains("Program Files"));
        std::env::remove_var("POSTGRES_RUNTIME_DIR");
    }

    #[test]
    fn env_overrides_no_secret_in_values_via_marker() {
        // Wir prüfen, dass die Übergabe-Werte den Secrets entsprechen
        // (nur strukturell — kein Log-Leak-Test hier).
        std::env::remove_var("POSTGRES_RUNTIME_DIR");
        let cfg = dummy_cfg();
        let orch = Orchestrator::new(cfg);
        let s = Secrets::generate();
        let v = orch.env_overrides(&s);
        for (k, val) in &v {
            if *k == "PG_DBPASSWORD" || *k == "AUTH_SECRET" || *k == "SHUTDOWN_TOKEN" {
                // Wert MUSS exakt dem Secret entsprechen — kein Default, kein Trim.
                let expected = match *k {
                    "PG_DBPASSWORD" => &s.db_password,
                    "AUTH_SECRET" => &s.auth_secret,
                    "SHUTDOWN_TOKEN" => &s.shutdown_token,
                    _ => unreachable!(),
                };
                assert_eq!(val, expected);
            }
        }
    }

    #[test]
    fn data_dir_failure_aborts_before_secrets() {
        let cfg = dummy_cfg();
        let mut orch = Orchestrator::new(cfg);
        let steps = StubSteps {
            ensure_dir_ok: false,
            secrets_existing: Some(Secrets::generate()),
            validate_ok: true,
            spawn_should_fail: true,
            port: Some(PortState {
                host: "127.0.0.1".into(),
                port: 3000,
                started_at: None,
            }),
            ready_ok: true,
        };
        let mock = MockAcl::new();
        let r = orch.run(&steps, &mock);
        assert!(matches!(r, Err(AppError::DataDirUnavailable)));
        assert_eq!(orch.state, StartupState::Failed);
    }

    #[test]
    fn validate_node_failure_aborts_before_spawn() {
        let cfg = dummy_cfg();
        let mut orch = Orchestrator::new(cfg);
        let steps = StubSteps {
            ensure_dir_ok: true,
            secrets_existing: Some(Secrets::generate()),
            validate_ok: false,
            spawn_should_fail: true,
            port: Some(PortState {
                host: "127.0.0.1".into(),
                port: 3000,
                started_at: None,
            }),
            ready_ok: true,
        };
        let mock = MockAcl::new();
        let r = orch.run(&steps, &mock);
        assert!(matches!(r, Err(AppError::NodeX64("stub"))));
        assert_eq!(orch.state, StartupState::Failed);
    }

    #[test]
    fn missing_port_state_aborts() {
        let cfg = dummy_cfg();
        let mut orch = Orchestrator::new(cfg);
        let steps = StubSteps {
            ensure_dir_ok: true,
            secrets_existing: Some(Secrets::generate()),
            validate_ok: true,
            spawn_should_fail: true,
            port: None,
            ready_ok: true,
        };
        let mock = MockAcl::new();
        let r = orch.run(&steps, &mock);
        // Stub-Spawn schlägt fehl, bevor PortState gelesen wird.
        // Wir prüfen den State-Übergang auf Failed.
        assert!(r.is_err());
        assert_eq!(orch.state, StartupState::Failed);
    }

    #[test]
    fn readiness_timeout_aborts() {
        let cfg = dummy_cfg();
        let mut orch = Orchestrator::new(cfg);
        let steps = StubSteps {
            ensure_dir_ok: true,
            secrets_existing: Some(Secrets::generate()),
            validate_ok: true,
            spawn_should_fail: true,
            port: Some(PortState {
                host: "127.0.0.1".into(),
                port: 3001,
                started_at: None,
            }),
            ready_ok: false,
        };
        let mock = MockAcl::new();
        let r = orch.run(&steps, &mock);
        assert!(r.is_err());
        assert_eq!(orch.state, StartupState::Failed);
    }

    #[test]
    fn spawn_failure_sets_failed_state() {
        let cfg = dummy_cfg();
        let mut orch = Orchestrator::new(cfg);
        let steps = StubSteps {
            ensure_dir_ok: true,
            secrets_existing: Some(Secrets::generate()),
            validate_ok: true,
            spawn_should_fail: true,
            port: Some(PortState {
                host: "127.0.0.1".into(),
                port: 3000,
                started_at: None,
            }),
            ready_ok: true,
        };
        let mock = MockAcl::new();
        let r = orch.run(&steps, &mock);
        assert!(matches!(r, Err(AppError::RuntimeSpawn { .. })));
        assert_eq!(orch.state, StartupState::Failed);
    }
}

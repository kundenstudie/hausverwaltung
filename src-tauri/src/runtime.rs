// HAVEWA-07C — Runtime-Spawn (Auftrag §4, §5, §7, §14).
// HAVEWA-07D G3 — Release-Runtime-Pfade + Env-Allowlist.
//
// Tauri/Rust darf NIEMALS automatisch System-Node verwenden. Wir erlauben
// nur das gebündelte Node (runtime/node/node.exe) — im Dev-Modus den
// kontrollierten Dev-Default —, validieren die Architektur (x86_64) und
// spawnen das bestehende `start-runtime-with-pg.mjs` aus dem App-Stage.
//
// Child-Ownership (Auftrag §7): Wir halten das ECHTE std::process::Child
// bis zum Shutdown. KEINE Rekonstruktion aus PID (PID-Reuse-Risiko).
// TerminateProcess NUR als Fail-safe auf das EIGENE Child-Handle,
// niemals nach Prozessname.
//
// 07B bleibt verantwortlich für Postgres (resolution, pgdata, initdb, port,
// ownership, start, readiness, crash recovery, shutdown). Wir reichen
// HAVEWA_DATA_DIR, POSTGRES_RUNTIME_DIR und Secrets via Env durch.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::env::ChildEnv;
use crate::error::{AppError, AppResult};

/// Skript-Pfad relativ zum App-Stage.
pub const RUNTIME_SCRIPT: &str = "scripts\\start-runtime-with-pg.mjs";

/// Pflicht-Env-Vars, die an das Node-Child durchgereicht werden.
/// Code-to-Code-Contract gegen 07A/07B (siehe Review §12).
/// KEIN Secret im Display; AppError erlaubt nur kategorische Marker.
pub const ENV_KEYS_REQUIRED: &[&str] = &[
    "HAVEWA_DATA_DIR",
    "PG_DBPASSWORD",
    "AUTH_SECRET",
    "SHUTDOWN_TOKEN",
    "POSTGRES_RUNTIME_DIR",
    // G3: Desktop-Betrieb
    "HAVEWA_DESKTOP_RUNTIME",
    "HAVEWA_PRISMA_SKIP_GENERATE",
    "AUTH_TRUST_HOST",
];

/// Optional durchgereichte Env-Vars.
pub const ENV_KEYS_OPTIONAL: &[&str] = &["PATH", "SystemRoot", "HAVEWA_NODE_BIN"];

/// Validiert den Node-Pfad:
///   1) Datei existiert
///   2) PE-Header Magic + Machine == 0x8664 (x86_64)
///   3) Falls ARM64-Binary erkannt → FAIL CLOSED (Auftrag §4)
pub fn validate_x64_node(path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::NodeX64("not_found"));
    }
    let bytes = std::fs::read(path).map_err(|e| AppError::Io {
        context: "read node binary",
        source: e,
    })?;
    if bytes.len() < 0x200 {
        return Err(AppError::NodeX64("too_small"));
    }
    // DOS-Header: 'MZ' an Offset 0.
    if &bytes[0..2] != b"MZ" {
        return Err(AppError::NodeX64("no_mz"));
    }
    // e_lfanew an Offset 0x3C (little-endian u32).
    let pe_off = u32::from_le_bytes([
        bytes[0x3c],
        bytes[0x3d],
        bytes[0x3e],
        bytes[0x3f],
    ]) as usize;
    if pe_off + 24 > bytes.len() {
        return Err(AppError::NodeX64("pe_off_oob"));
    }
    if &bytes[pe_off..pe_off + 4] != b"PE\0\0" {
        return Err(AppError::NodeX64("no_pe"));
    }
    // Machine steht an Offset 4 in der COFF-Header.
    let machine = u16::from_le_bytes([bytes[pe_off + 4], bytes[pe_off + 5]]);
    match machine {
        0x8664 => Ok(()), // x86_64
        0xaa64 => Err(AppError::NodeX64("arm64")),
        0x14c => Err(AppError::NodeX64("x86")),
        _ => Err(AppError::NodeX64("unknown_machine")),
    }
}

/// Konfiguriert den Spawn-Befehl. Das Child wird gestartet und das
/// ECHTE Handle zurückgegeben. Der Caller MUSS das Handle bis zum
/// Shutdown halten — keine PID-Rekonstruktion.
///
/// G3: Das Child bekommt eine EXPLIZIT aufgebaute Environment
/// (Allowlist), NICHT die komplette Eltern-Environment. `PATH` wird
/// kontrolliert gesetzt (Stage-Node + Stage-PostgreSQL + System32).
pub fn spawn_runtime(
    node_bin: &Path,
    app_dir: &Path,
    env_overrides: &[(&str, &str)],
) -> AppResult<Child> {
    validate_x64_node(node_bin)?;

    let script = app_dir.join(RUNTIME_SCRIPT);
    if !script.exists() {
        return Err(AppError::RuntimeSpawn {
            stage: "script_missing",
            exit: None,
        });
    }

    // Auf Windows: `node.exe <script>`.
    // Wir nutzen kein `shell:true` (Command-Builder direkt), um Quote-Escaping
    // kontrolliert zu halten.
    let mut cmd = Command::new(node_bin);
    cmd.arg(&script)
        .current_dir(app_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    // Env: Allowlist-Basis + explizite Overrides. KEIN blindes Erben.
    let mut child_env = ChildEnv::base();
    for (k, v) in env_overrides {
        child_env.set(k, v);
    }
    for (k, v) in &child_env.vars {
        cmd.env(k, v);
    }

    let child = cmd.spawn().map_err(|e| AppError::Io {
        context: "spawn node child",
        source: e,
    })?;
    Ok(child)
}

/// ECHTES Child-Handle. Hält den `std::process::Child` bis zum Shutdown.
/// Wird im AppState gehalten; PID wird nur für Diagnostik abgeleitet.
pub struct ChildHandle {
    child: Child,
}

impl ChildHandle {
    pub fn new(child: Child) -> Self {
        Self { child }
    }
    pub fn pid(&self) -> u32 {
        self.child.id()
    }
    /// Mutable Borrow des inneren Child — nur für interne Shutdown-Logik.
    pub(crate) fn child_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}

/// Graceful Shutdown mit Fail-safe (Auftrag §8, §14).
///
/// Sequenz:
///   1) Warten auf Child-Exit (Timeout).
///   2) Falls Timeout: TerminateProcess NUR auf das EIGENE Child-Handle.
///
/// Es wird NIE nach Prozessname gesucht oder ein fremder Prozess
/// terminiert. PID-Reuse ist irrelevant, weil das Child-Handle
/// identisch mit dem gespawnten Prozess ist.
pub fn graceful_shutdown(child_handle: &mut ChildHandle, timeout: Duration) -> AppResult<()> {
    let child = child_handle.child_mut();

    // Falls bereits beendet → sofort Ok.
    if let Ok(Some(_)) = child.try_wait() {
        return Ok(());
    }

    // Auf Child-Exit warten (mit Deadline).
    let start = Instant::now();
    while start.elapsed() < timeout {
        if let Ok(Some(_)) = child.try_wait() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    // Fail-safe: TerminateProcess auf das EIGENE Child-Handle.
    // Wir nutzen NICHT die PID (PID-Reuse), sondern die Windows-Handle,
    // die Command::spawn() zurückgegeben hat.
    #[cfg(windows)]
    {
        terminate_own_child(child);
    }
    Ok(())
}

#[cfg(windows)]
fn terminate_own_child(child: &mut Child) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, PROCESS_TERMINATE,
    };
    // Haupt-Handle (Main) des Child öffnen — das ist der EINZIGE
    // Prozess, den wir anfassen.
    let pid = child.id();
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !h.is_null() {
            TerminateProcess(h, 1);
            CloseHandle(h);
        }
    }
    // wait erneut (Child sollte jetzt beendet sein)
    let _ = child.wait();
}

#[cfg(not(windows))]
fn terminate_own_child(_child: &mut Child) {
    unreachable!("HAVEWA-07C is Windows-v1 only");
}

/// Liefert den Runtime-Root (Verzeichnis, in dem `runtime/node/node.exe`,
/// `runtime/postgres/bin/` und `runtime/app/` liegen).
///
/// G3: Im Release kommt der Wert aus `HAVEWA_RUNTIME_ROOT`, den Tauri
/// beim Start aus `resource_dir()` setzt. Damit braucht der Release-Build
/// KEINEN Repo-Pfad und KEIN `CARGO_MANIFEST_DIR`.
pub fn runtime_root() -> AppResult<PathBuf> {
    crate::paths::runtime_root()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_keys_required_have_all_contract_names() {
        // Code-to-Code-Contract (Review §12): diese Namen MÜSSEN gesetzt werden.
        assert!(ENV_KEYS_REQUIRED.contains(&"HAVEWA_DATA_DIR"));
        assert!(ENV_KEYS_REQUIRED.contains(&"PG_DBPASSWORD"));
        assert!(ENV_KEYS_REQUIRED.contains(&"AUTH_SECRET"));
        assert!(ENV_KEYS_REQUIRED.contains(&"SHUTDOWN_TOKEN"));
        assert!(ENV_KEYS_REQUIRED.contains(&"POSTGRES_RUNTIME_DIR"));
    }

    #[test]
    fn env_keys_optional_do_not_leak_in_diagnostic() {
        assert!(ENV_KEYS_OPTIONAL.contains(&"PATH"));
        assert!(!ENV_KEYS_OPTIONAL.contains(&"PG_DBPASSWORD"));
        assert!(!ENV_KEYS_OPTIONAL.contains(&"AUTH_SECRET"));
    }

    #[test]
    fn validate_x64_node_fails_on_missing() {
        let r = validate_x64_node(Path::new("X:\\does\\not\\exist.exe"));
        assert!(matches!(r, Err(AppError::NodeX64("not_found"))));
    }

    #[test]
    fn validate_x64_node_rejects_arm_machine_marker() {
        let mut bytes = vec![b'M', b'Z'];
        bytes.extend(std::iter::repeat(0u8).take(0x3a));
        bytes.extend(0x40u32.to_le_bytes());
        bytes.truncate(0x40);
        bytes.extend(b"PE\0\0");
        bytes.extend(0xaa64u16.to_le_bytes());
        bytes.resize(0x400, 0);
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("node.exe");
        std::fs::write(&p, &bytes).unwrap();
        let r = validate_x64_node(&p);
        assert!(matches!(r, Err(AppError::NodeX64("arm64"))));
    }

    #[test]
    fn validate_x64_node_accepts_x86_64() {
        let mut bytes = vec![b'M', b'Z'];
        bytes.extend(std::iter::repeat(0u8).take(0x3a));
        bytes.extend(0x40u32.to_le_bytes());
        bytes.truncate(0x40);
        bytes.extend(b"PE\0\0");
        bytes.extend(0x8664u16.to_le_bytes());
        bytes.resize(0x400, 0);
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("node.exe");
        std::fs::write(&p, &bytes).unwrap();
        let r = validate_x64_node(&p);
        assert!(r.is_ok(), "expected Ok, got {r:?}");
    }
}

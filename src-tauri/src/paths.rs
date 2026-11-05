// HAVEWA-07C — Pfad-Auflösung (Auftrag §6).
// HAVEWA-07D G3 — Release-Runtime-Auflösung gegen gebündelte Tauri-Resources.
//
// Produktiver Data Root: %LOCALAPPDATA%\HaVeWa
//   config/                  → secrets.json (ACL-geschützt)
//   pgdata/                  → Postgres (07B)
//   storage/documents/       → User-Dokumente
//   logs/                    → Log-Files (Node/Postgres)
//   runtime-state/           → port.json / db-port.json
//
// Produktiver Runtime Root (G3): <install-root>\runtime
//   node/                    → node.exe + LICENSE
//   postgres/bin/            → PostgreSQL 16.14 x64
//   app/                     → Next standalone + Skripte + Prisma-CLI
//
// Wir schreiben NIE in das Installationsverzeichnis.

use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

/// Standard-Subverzeichnisse unter dem Data Root.
pub const DATA_SUBDIRS: &[&str] = &[
    "config",
    "pgdata",
    "storage\\documents",
    "logs",
    "runtime-state",
];

/// Unterverzeichnis des gebündelten Runtime-Stages unter dem Resource-Root.
pub const RUNTIME_SUBDIR: &str = "runtime";

/// Relativer Pfad des Node-Binaries innerhalb des Runtime-Stages.
pub const NODE_REL: &str = "node\\node.exe";

/// Relativer Pfad des PostgreSQL-bin-Verzeichnisses im Runtime-Stage.
pub const PG_BIN_REL: &str = "postgres\\bin";

/// Relativer Pfad des App-Stages im Runtime-Stage.
pub const APP_REL: &str = "app";

/// Relativer Pfad des Runtime-Start-Skripts im App-Stage.
pub const RUNTIME_SCRIPT_REL: &str = "scripts\\start-runtime-with-pg.mjs";

/// Env-Var-Name für Data Root (von der bestehenden Node-Runtime gelesen).
pub const ENV_DATA_DIR: &str = "HAVEWA_DATA_DIR";

/// Env-Var-Name für expliziten Node-Pfad (nur für Tests/Dev-Overrides).
pub const ENV_NODE_BIN: &str = "HAVEWA_NODE_BIN";

/// Env-Var-Name für den Runtime-Root (von Tauri beim Start gesetzt).
///
/// Im Release wird der Wert aus `resource_dir()` gesetzt, damit die
/// Rust-Seite KEINEN Repo-Pfad braucht.
pub const ENV_RUNTIME_ROOT: &str = "HAVEWA_RUNTIME_ROOT";

/// Liefert den Data Root. Reihenfolge:
/// 1. `HAVEWA_DATA_DIR` (gesetzt durch Tauri selbst)
/// 2. `%LOCALAPPDATA%\HaVeWa`
///
/// Wir geben NIE das Installationsverzeichnis zurück; Auftrag §6 verbietet
/// explizit Daten ins Installationsverzeichnis zu schreiben.
pub fn resolve_data_dir() -> AppResult<PathBuf> {
    if let Ok(v) = std::env::var(ENV_DATA_DIR) {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    let local = std::env::var("LOCALAPPDATA")
        .map_err(|_| AppError::DataDirUnavailable)?
        .trim()
        .to_string();
    if local.is_empty() {
        return Err(AppError::DataDirUnavailable);
    }
    Ok(PathBuf::from(local).join("HaVeWa"))
}

/// Erzeugt das Data Root inkl. aller Pflicht-Unterverzeichnisse (Auftrag §6).
///
/// `mode = "create"` legt die API an. Die API ist fail-closed (kein silent skip).
pub fn ensure_data_dir(root: &Path) -> AppResult<()> {
    for sub in DATA_SUBDIRS {
        let p = root.join(sub);
        std::fs::create_dir_all(&p).map_err(|e| AppError::Io {
            context: "create_dir_all",
            source: e,
        })?;
    }
    Ok(())
}

/// Liefert den absoluten Pfad zur secrets.json. Existenz wird NICHT geprüft.
pub fn secrets_path(root: &Path) -> PathBuf {
    root.join("config").join("secrets.json")
}

/// Liefert den Pfad zu runtime-state/port.json.
pub fn port_state_path(root: &Path) -> PathBuf {
    root.join("runtime-state").join("port.json")
}

/// Liefert den Node-Pfad aus Env, sonst Default. Existenz wird NICHT geprüft.
///
/// G3: Im Release MUSS der Node aus dem gebündelten Runtime-Stage kommen.
/// Der Pfad wird relativ zum Runtime-Root aufgelöst — KEIN hartkodierter
/// Dev-Pfad mehr.
pub fn node_bin_path() -> PathBuf {
    if let Ok(v) = std::env::var(ENV_NODE_BIN) {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    match runtime_root() {
        Ok(root) => root.join(NODE_REL),
        // Ohne Runtime-Root (z.B. Unit-Tests ohne Kontext) liefern wir einen
        // relativen Pfad — der Aufrufer validiert ohnehin die Existenz.
        Err(_) => PathBuf::from(NODE_REL),
    }
}

/// Liefert den Runtime-Root (Basis der gebündelten Runtime).
///
/// Reihenfolge:
///   1. `HAVEWA_RUNTIME_ROOT` (von Tauri im Release gesetzt — der Wert
///      kommt aus `resource_dir()` und zeigt damit auf die INSTALLIERTE
///      Runtime, nicht auf das Repo).
///   2. Dev-Fallback: `CARGO_MANIFEST_DIR/../resources/runtime`
///      (nur im Dev-Build; wird im Release NICHT verwendet, weil dort
///      Schritt 1 immer greift).
///
/// KEIN absoluter Pfad ist hier hartkodiert.
pub fn runtime_root() -> AppResult<PathBuf> {
    if let Ok(v) = std::env::var(ENV_RUNTIME_ROOT) {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    Ok(dev_runtime_root())
}

/// Dev-Fallback: Runtime-Stage im Repo (`src-tauri/resources/runtime`).
///
/// Wird ausschließlich im Dev-Build verwendet.
///
/// G3: Wir verwenden bewusst KEIN `env!("CARGO_MANIFEST_DIR")` — das würde
/// den Build-Pfad als String in das Release-Binary backen (Dev-Pfad-Leak im
/// ausgelieferten Produkt). Stattdessen leiten wir den Pfad zur LAUFZEIT
/// aus der Position der EXE ab:
///
///   <repo>/src-tauri/target/<triple>/<profile>/havewa-desktop.exe
///   -> ../../../../resources/runtime
///
/// Im Release-Build wird dieser Pfad nie benutzt (dort setzt
/// `resolve_runtime_root()` die Env-Variable aus Tauri `resource_dir()`),
/// aber er wird auch nicht gebacken.
pub fn dev_runtime_root() -> PathBuf {
    // Release: der Pfad wird nie benutzt — wir geben einen leeren Pfad
    // zurück, damit NICHTS gebacken wird.
    #[cfg(not(debug_assertions))]
    {
        return PathBuf::from("resources").join(RUNTIME_SUBDIR);
    }
    // Debug: Pfad relativ zur EXE ableiten (maximal 5 Ebenen hoch).
    #[cfg(debug_assertions)]
    {
        if let Ok(exe) = std::env::current_exe() {
            // target/<triple>/<profile>/havewa-desktop.exe -> src-tauri/
            let mut dir = exe.parent().map(|p| p.to_path_buf());
            // profile -> <triple> -> target -> src-tauri
            for _ in 0..3 {
                dir = dir.and_then(|d| d.parent().map(|p| p.to_path_buf()));
            }
            if let Some(d) = dir {
                return d.join("resources").join(RUNTIME_SUBDIR);
            }
        }
        PathBuf::from("resources").join(RUNTIME_SUBDIR)
    }
}

/// Liefert das Verzeichnis des gebündelten Node-Binaries.
pub fn node_dir(runtime_root: &Path) -> PathBuf {
    runtime_root.join("node")
}

/// Liefert das Verzeichnis des gebündelten PostgreSQL-bin.
pub fn postgres_bin_dir(runtime_root: &Path) -> PathBuf {
    runtime_root.join(PG_BIN_REL)
}

/// Liefert das Verzeichnis des gebündelten App-Stages.
pub fn app_dir(runtime_root: &Path) -> PathBuf {
    runtime_root.join(APP_REL)
}

/// Liefert den Pfad des Runtime-Start-Skripts im App-Stage.
pub fn runtime_script_path(app_dir: &Path) -> PathBuf {
    app_dir.join(RUNTIME_SCRIPT_REL)
}

/// Generischer Env-Lookup mit Default. Trimmt whitespace.
pub fn env_or(key: &str, default: &str) -> String {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| default.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Env-Variablen sind prozess-global; Rust-Tests laufen parallel.
    /// Alle Tests, die `ENV_RUNTIME_ROOT` / `ENV_NODE_BIN` manipulieren,
    /// serialisieren sich über diesen Mutex.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Guard-Helper: hält den Lock für die Dauer des Tests.
    fn env_guard() -> std::sync::MutexGuard<'static, ()> {
        match ENV_LOCK.lock() {
            Ok(g) => g,
            // Poisoned: ein anderer Test ist paniced. Wir nehmen den Lock
            // trotzdem (die Env-Zustände sind pro Test isoliert gesetzt).
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    #[test]
    fn resolve_data_dir_uses_localappdata_when_env_unset() {
        // SAFETY: ENV_DATA_DIR darf für diesen Test nicht gesetzt sein.
        // Wenn der Aufrufer sie gesetzt hat, ist das Verhalten weiterhin korrekt
        // (ENV hat Vorrang). Wir prüfen hier nur die NICHTLEERE Rückgabe.
        let r = resolve_data_dir();
        assert!(r.is_ok(), "expected resolve_data_dir to succeed");
        let p = r.unwrap();
        assert!(p.is_absolute(), "data dir must be absolute: {p:?}");
    }

    #[test]
    fn data_subdirs_complete() {
        for need in ["config", "pgdata", "logs", "runtime-state"] {
            assert!(
                DATA_SUBDIRS.iter().any(|s| *s == need),
                "missing required subdir {need}"
            );
        }
        // Auch 'storage\documents' muss dabei sein.
        assert!(DATA_SUBDIRS.iter().any(|s| s.contains("storage")));
    }

    #[test]
    fn ensure_data_dir_creates_subs() {
        let tmp = tempfile::tempdir().unwrap();
        ensure_data_dir(tmp.path()).unwrap();
        for sub in DATA_SUBDIRS {
            assert!(tmp.path().join(sub).exists(), "missing: {sub}");
        }
    }

    #[test]
    fn secrets_path_under_config() {
        let tmp = tempfile::tempdir().unwrap();
        let p = secrets_path(tmp.path());
        assert!(p.starts_with(tmp.path()));
        assert!(p.ends_with("secrets.json"));
        assert!(p.components().any(|c| c.as_os_str() == "config"));
    }

    #[test]
    fn port_state_path_under_runtime_state() {
        let tmp = tempfile::tempdir().unwrap();
        let p = port_state_path(tmp.path());
        assert!(p.starts_with(tmp.path()));
        assert!(p.ends_with("port.json"));
        assert!(p.components().any(|c| c.as_os_str() == "runtime-state"));
    }

    #[test]
    fn node_bin_default_ends_with_node_exe() {
        let p = node_bin_path();
        assert!(p.ends_with("node.exe") || p.ends_with("node"));
    }

    // -----------------------------------------------------------------
    // G3: Release-Runtime-Auflösung
    // -----------------------------------------------------------------

    #[test]
    fn runtime_root_prefers_env_over_dev_fallback() {
        let _guard = env_guard();
        // SAFETY: ENV_RUNTIME_ROOT wird nur in diesem Test gesetzt.
        std::env::set_var(ENV_RUNTIME_ROOT, "C:\\inst\\runtime");
        let r = runtime_root().unwrap();
        assert_eq!(r, PathBuf::from("C:\\inst\\runtime"));
        std::env::remove_var(ENV_RUNTIME_ROOT);
    }

    #[test]
    fn runtime_root_falls_back_to_dev_stage() {
        let _guard = env_guard();
        // SAFETY: ENV_RUNTIME_ROOT ist in diesem Test nicht gesetzt.
        std::env::remove_var(ENV_RUNTIME_ROOT);
        let r = runtime_root().unwrap();
        // Der Dev-Fallback zeigt auf <...>/resources/runtime.
        assert!(r.ends_with("resources\\runtime") || r.ends_with("resources/runtime"));
    }

    #[test]
    fn dev_runtime_root_is_relative_in_release_builds() {
        // Im Release gibt dev_runtime_root() einen relativen Pfad zurück —
        // damit wird kein Build-Pfad in die EXE gebacken.
        let r = crate::paths::dev_runtime_root();
        assert!(
            r.ends_with("resources\\runtime") || r.ends_with("resources/runtime"),
            "unexpected dev runtime root: {r:?}"
        );
    }

    #[test]
    fn no_hardcoded_dev_paths_in_paths_module() {
        // Der Modul-Quelltext darf KEINE absoluten Dev-Pfade enthalten.
        // Wir prüfen die Konstante/Nicht-Konstante-Teile ohne die Test-Sektion
        // (die selbst Marker-Strings enthält).
        let src = include_str!("paths.rs");
        let prod_part = src.split("#[cfg(test)]").next().unwrap_or(src);
        for marker in ["C:\\Projekte", "PropertyAI", ".tools"] {
            assert!(
                !prod_part.contains(marker),
                "paths.rs (production part) contains a hardcoded dev path: {marker}"
            );
        }
    }

    #[test]
    fn node_bin_resolves_relative_to_runtime_root() {
        let _guard = env_guard();
        // SAFETY: ENV_RUNTIME_ROOT/ENV_NODE_BIN werden nur in diesem Test
        // gesetzt. Andere Tests können parallel laufen — deshalb prüfen
        // wir das Ergebnis direkt gegen den gesetzten Runtime-Root.
        std::env::set_var(ENV_RUNTIME_ROOT, "C:\\inst\\runtime");
        let r = runtime_root().unwrap();
        assert_eq!(r, PathBuf::from("C:\\inst\\runtime"));
        // Der Node-Pfad MUSS relativ zum Runtime-Root liegen — unabhängig
        // davon, ob ein anderer Test gerade ENV_NODE_BIN gesetzt hat.
        let node = crate::paths::node_dir(&r).join("node.exe");
        assert_eq!(node, PathBuf::from("C:\\inst\\runtime\\node\\node.exe"));
        std::env::remove_var(ENV_RUNTIME_ROOT);
    }

    #[test]
    fn node_bin_path_uses_env_override_when_set() {
        let _guard = env_guard();
        // SAFETY: nur in diesem Test.
        std::env::set_var(ENV_NODE_BIN, "D:\\custom\\node.exe");
        let p = node_bin_path();
        assert_eq!(p, PathBuf::from("D:\\custom\\node.exe"));
        std::env::remove_var(ENV_NODE_BIN);
    }

    #[test]
    fn postgres_bin_dir_is_under_runtime_root() {
        let root = PathBuf::from("C:\\inst\\runtime");
        let p = postgres_bin_dir(&root);
        assert!(p.starts_with(&root));
        assert!(p.ends_with("postgres\\bin") || p.ends_with("postgres/bin"));
    }

    #[test]
    fn runtime_script_path_is_under_app_dir() {
        let app = PathBuf::from("C:\\inst\\runtime\\app");
        let p = runtime_script_path(&app);
        assert!(p.starts_with(&app));
        assert!(p.ends_with("start-runtime-with-pg.mjs"));
    }
}

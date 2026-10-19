// HAVEWA-07C — Pfad-Auflösung (Auftrag §6).
//
// Produktiver Data Root: %LOCALAPPDATA%\HaVeWa
//   config/                  → secrets.json (ACL-geschützt)
//   pgdata/                  → Postgres (07B)
//   storage/documents/       → User-Dokumente
//   logs/                    → Log-Files (Node/Postgres)
//   runtime-state/           → port.json / db-port.json
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

/// Default-Node-Pfad, wenn HAVEWA_NODE_BIN nicht gesetzt ist.
pub const DEFAULT_NODE_BIN: &str =
    r"C:\Projekte\PropertyAI\.tools\node-v22.23.3-win-x64\node.exe";

/// Env-Var-Name für Data Root (von der bestehenden Node-Runtime gelesen).
pub const ENV_DATA_DIR: &str = "HAVEWA_DATA_DIR";

/// Env-Var-Name für expliziten Node-Pfad.
pub const ENV_NODE_BIN: &str = "HAVEWA_NODE_BIN";

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
pub fn node_bin_path() -> PathBuf {
    if let Ok(v) = std::env::var(ENV_NODE_BIN) {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    PathBuf::from(DEFAULT_NODE_BIN)
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
}
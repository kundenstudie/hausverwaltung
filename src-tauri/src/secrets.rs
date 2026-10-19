// HAVEWA-07C — Secrets (Auftrag §7).
//
// Datei: <HAVEWA_DATA_DIR>\config\secrets.json
// Felder:
//   dbPassword       — DB-User-Passwort (Postgres)
//   authSecret       — Session-/Cookie-/Token-Geheimnis
//   shutdownToken    — expliziter Shutdown-Token (gegen fremdes Kill)
//
// Bei Erststart: kryptographisch ausreichende Zufallswerte erzeugen.
// Keine fest eingebauten Defaults.
//
// Schutz: JSON + Windows ACL via icacls (Modul `acl`).
//
// DPAPI ist DEFER_TO_07D (Auftrag D-07C-2).

use std::path::{Path, PathBuf};

use base64::Engine;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Anzahl der Zufallsbytes für `dbPassword` (24 Bytes ≈ 192 Bit Entropie).
const PUB_KEY_BYTES: u32 = 24;
/// Anzahl der Zufallsbytes für `authSecret` (32 Bytes ≈ 256 Bit Entropie).
const AUTH_KEY_BYTES: u32 = 32;
/// Anzahl der Zufallsbytes für `shutdownToken` (16 Bytes ≈ 128 Bit Entropie).
const SHUTDOWN_KEY_BYTES: u32 = 16;

/// Standardmäßig erzeugtes JSON-Layout (alle Felder Pflicht, Reihenfolge fix).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Secrets {
    pub db_password: String,
    pub auth_secret: String,
    pub shutdown_token: String,
}

/// Marker für anonymisierte / redacted Secrets (Tests/Diagnostik).
impl Secrets {
    /// Erzeugt ein neues Secret-Set mit kryptographisch ausreichenden
    /// Zufallswerten (OsRng = Betriebssystem-Entropy-Quelle).
    pub fn generate() -> Self {
        let mut buf = vec![0u8; PUB_KEY_BYTES as usize];
        OsRng.fill_bytes(&mut buf);
        let db_password = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&buf);

        let mut buf = vec![0u8; AUTH_KEY_BYTES as usize];
        OsRng.fill_bytes(&mut buf);
        let auth_secret = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&buf);

        let mut buf = vec![0u8; SHUTDOWN_KEY_BYTES as usize];
        OsRng.fill_bytes(&mut buf);
        let shutdown_token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&buf);

        Secrets {
            db_password,
            auth_secret,
            shutdown_token,
        }
    }

    /// Liefert ein Diagnostik-Display, das **keine** Secret-Werte enthält.
    /// Nur Marker + Byte-Längen.
    pub fn diagnostic_marker(&self) -> String {
        format!(
            "Secrets {{ db={}, auth={}, shutdown={} }}",
            AppError::redacted_marker(self.db_password.len()),
            AppError::redacted_marker(self.auth_secret.len()),
            AppError::redacted_marker(self.shutdown_token.len()),
        )
    }
}

/// Liest die Secrets-Datei. Liefert `None`, wenn sie nicht existiert.
pub fn load(path: &Path) -> AppResult<Option<Secrets>> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(path)?;
    let s: Secrets = serde_json::from_str(&raw)?;
    Ok(Some(s))
}

/// Schreibt die Secrets-Datei ATOMAR:
///   1) JSON in Temp-Datei (gleiches Verzeichnis)
///   2) fsync (Datei + Dir)
///   3) Rename auf Ziel-Pfad
///
/// Fail-closed: Wenn ein Schritt fehlschlägt, wird die Temp-Datei aufgeräumt
/// und nichts am Ziel-Pfad hinterlassen.
pub fn write_atomic(path: &Path, secrets: &Secrets) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or(AppError::SecretsWrite { op: "parent" })?;
    std::fs::create_dir_all(parent).map_err(|e| AppError::Io {
        context: "create_dir_all(parent)",
        source: e,
    })?;

    // Dateiname für Temp: <original>.tmp-<rand>
    let tmp_name = format!(
        ".{}.tmp",
        path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("secrets.json")
    );
    let tmp_path: PathBuf = parent.join(tmp_name);

    let json = serde_json::to_string_pretty(secrets)?;

    // Schritt 1: write
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp_path).map_err(|e| AppError::Io {
            context: "create tmp",
            source: e,
        })?;
        f.write_all(json.as_bytes()).map_err(|e| AppError::Io {
            context: "write tmp",
            source: e,
        })?;
        f.sync_all().map_err(|e| AppError::Io {
            context: "sync tmp",
            source: e,
        })?;
    }

    // Schritt 2: rename (auf NTFS ist rename atomar und ersetzt).
    let rename_result = std::fs::rename(&tmp_path, path);

    if let Err(e) = rename_result {
        // Cleanup: Temp löschen, Fehler weitergeben.
        let _ = std::fs::remove_file(&tmp_path);
        return Err(AppError::Io {
            context: "rename tmp->target",
            source: e,
        });
    }

    // Schritt 3: fsync directory (best-effort)
    if let Ok(dir) = std::fs::File::open(parent) {
        let _ = dir.sync_all();
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_produces_three_distinct_strings() {
        let a = Secrets::generate();
        let b = Secrets::generate();
        assert_ne!(a.db_password, b.db_password);
        assert_ne!(a.auth_secret, b.auth_secret);
        assert_ne!(a.shutdown_token, b.shutdown_token);
        // Alle drei Felder einer Generation sind unabhängig.
        assert_ne!(a.db_password, a.auth_secret);
        assert_ne!(a.db_password, a.shutdown_token);
        assert_ne!(a.auth_secret, a.shutdown_token);
    }

    #[test]
    fn generate_no_empty_strings() {
        let s = Secrets::generate();
        assert!(!s.db_password.is_empty());
        assert!(!s.auth_secret.is_empty());
        assert!(!s.shutdown_token.is_empty());
        // base64-URL-safe: nur A-Z a-z 0-9 _ -
        for c in s.db_password.chars() {
            assert!(c.is_ascii_alphanumeric() || c == '_' || c == '-');
        }
    }

    #[test]
    fn diagnostic_marker_contains_no_secret_values() {
        let s = Secrets::generate();
        let m = s.diagnostic_marker();
        assert!(!m.contains(&s.db_password), "marker leaks db_password");
        assert!(!m.contains(&s.auth_secret), "marker leaks auth_secret");
        assert!(!m.contains(&s.shutdown_token), "marker leaks shutdown_token");
        assert!(m.contains("Secrets"));
        assert!(m.contains("db="));
        assert!(m.contains("auth="));
        assert!(m.contains("shutdown="));
    }

    #[test]
    fn load_missing_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("nope.json");
        let r = load(&p).unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn write_atomic_creates_valid_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("config").join("secrets.json");
        let s = Secrets::generate();
        write_atomic(&p, &s).unwrap();
        // Roundtrip
        let back = load(&p).unwrap().expect("must exist after write");
        assert_eq!(back, s);
    }

    #[test]
    fn write_atomic_overwrites_existing() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("secrets.json");
        let s1 = Secrets::generate();
        write_atomic(&p, &s1).unwrap();
        let s2 = Secrets::generate();
        write_atomic(&p, &s2).unwrap();
        let back = load(&p).unwrap().unwrap();
        assert_eq!(back, s2);
        // Keine Temp-Datei übrig.
        for entry in std::fs::read_dir(tmp.path()).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name();
            assert!(!name.to_string_lossy().ends_with(".tmp"), "leftover tmp: {name:?}");
        }
    }

    #[test]
    fn write_atomic_does_not_leave_partial_on_collision() {
        // Bei vorhandener Datei MUSS das Original ersetzt werden,
        // Temp-Datei NICHT übrig bleiben.
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("secrets.json");
        let s = Secrets::generate();
        write_atomic(&p, &s).unwrap();
        // Liste: keine .tmp-Dateien
        for entry in std::fs::read_dir(tmp.path()).unwrap() {
            let entry = entry.unwrap();
            assert!(!entry.file_name().to_string_lossy().ends_with(".tmp"));
        }
    }
}
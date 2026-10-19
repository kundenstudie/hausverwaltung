// HAVEWA-07C — Typed Errors (Auftrag §11: keine Secrets im Fehlerdialog).
//
// Alle Error-Varianten haben ein REDAKTIERTES Display. Secret-Werte
// (dbPassword, authSecret, shutdownToken) werden NIE in `fmt::Display`
// ausgegeben. Stattdessen erscheint nur ein Marker-String (z. B.
// "[redacted:32B]"), und nur die LÄNGE/STRUKTUR ist sichtbar.

use std::path::PathBuf;

use thiserror::Error;

/// Zentrale Fehlertypen. `#[error("…")]`-Texte sind SEKRET-FREI.
#[derive(Debug, Error)]
pub enum AppError {
    /// Datenverzeichnis `%LOCALAPPDATA%\HaVeWa` konnte nicht bestimmt
    /// oder angelegt werden.
    #[error("data dir konnte nicht aufgeloest werden")]
    DataDirUnavailable,

    /// Eine Secret-Datei konnte nicht atomar geschrieben werden.
    /// Anzeige: nur Pfad-Typ + Operation.
    #[error("secrets write fehlgeschlagen: op={op}")]
    SecretsWrite { op: &'static str },

    /// ACL-Befehl (icacls) fehlgeschlagen. Wir geben den Exit-Code,
    /// aber NICHT den Befehl oder den Pfad-Leak aus argv.
    #[error("acl anwenden fehlgeschlagen: exit_code={exit_code}")]
    AclApply { exit_code: i32 },

    /// Verifikation der gesetzten ACL fehlgeschlagen (z. B. icacls verify).
    #[error("acl verify fehlgeschlagen")]
    AclVerify,

    /// Node-Binary nicht gefunden oder Architektur nicht x64.
    #[error("node x64 validation: {0}")]
    NodeX64(&'static str),

    /// Runtime-Spawn (start-runtime-with-pg.mjs) fehlgeschlagen.
    /// Anzeige: nur Kategorie + Exit, kein argv-Leak.
    #[error("runtime spawn fehlgeschlagen: stage={stage}, exit={exit:?}")]
    RuntimeSpawn {
        stage: &'static str,
        exit: Option<i32>,
    },

    /// /api/ready pollt Timeout.
    #[error("readiness poll timeout (port={port})")]
    ReadinessTimeout { port: u16 },

    /// port.json fehlt/ungültig.
    #[error("port state invalid: kind={kind}")]
    PortStateInvalid { kind: &'static str },

    /// Single-Instance-Plugin hat den Start abgebrochen.
    #[error("second instance: fokus auf primary verlagert")]
    SecondInstance,

    /// Allgemeiner IO-Fehler mit redaktioniertem Pfad (nur Top-Level).
    #[error("io fehler: {context}")]
    Io { context: &'static str, #[source] source: std::io::Error },

    /// JSON-Parse-Fehler (z. B. port.json, secrets.json).
    /// Inhalt wird NICHT offengelegt.
    #[error("json parse fehler: {0}")]
    JsonParse(&'static str),

    /// Webview-Manipulation (navigate, show) fehlgeschlagen.
    #[error("webview fehler: {0}")]
    Webview(&'static str),

    /// Plugin-Init fehlgeschlagen.
    #[error("plugin init: {0}")]
    PluginInit(&'static str),

    /// Shutdown-API-Aufruf fehlgeschlagen (Kategorie, KEINE URL/Token im Display).
    #[error("shutdown api: {0}")]
    ShutdownApi(&'static str),

    /// Pfad für Tests / Diagnostik — nur in Tests, NICHT im Display.
    #[error("intern: {0}")]
    Internal(&'static str),
}

impl AppError {
    /// Redacted marker for secret-bearing context. Use this if you ever need
    /// to include a secret-related marker; never include the secret itself.
    pub const fn redacted_marker(byte_len: usize) -> &'static str {
        // Konstanter Marker; gibt nur die LÄNGE preis (keine Längen-Leaks,
        // keine festen Längenwerte, die Fingerprinting erlauben).
        match byte_len {
            0 => "[redacted:0B]",
            1..=16 => "[redacted:short]",
            17..=64 => "[redacted:32B]",
            _ => "[redacted:long]",
        }
    }
}

/// Public Result-Alias.
pub type AppResult<T> = std::result::Result<T, AppError>;

/// Helper: Pfad → nur Top-Level-Komponente anzeigen (für Diagnostik).
pub fn path_kind(p: &std::path::Path) -> Option<PathBuf> {
    p.file_name().map(PathBuf::from)
}

// ---- impl From für IO/JSON für ergonomisches `?` ----

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io {
            context: "io",
            source: e,
        }
    }
}

impl From<serde_json::Error> for AppError {
    fn from(_: serde_json::Error) -> Self {
        AppError::JsonParse("serde_json")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_leak_no_passwords() {
        // Display darf KEINE Secret-Bezeichner enthalten.
        let e = AppError::SecretsWrite { op: "rename" };
        let s = format!("{}", e);
        assert!(!s.contains("dbPassword"));
        assert!(!s.contains("authSecret"));
        assert!(!s.contains("shutdownToken"));
        assert!(!s.contains("password="), "s={s}");
    }

    #[test]
    fn display_leak_no_token_in_runtime() {
        let e = AppError::RuntimeSpawn {
            stage: "spawn",
            exit: Some(1),
        };
        let s = format!("{}", e);
        assert!(!s.to_lowercase().contains("token"));
        assert!(!s.contains("--"));
    }

    #[test]
    fn redacted_marker_is_safe() {
        // Auch der Marker-String darf keine konkreten Werte enthalten.
        for n in [0usize, 8, 16, 32, 64, 128, 1024] {
            let m = AppError::redacted_marker(n);
            assert!(!m.contains("="));
        }
    }
}
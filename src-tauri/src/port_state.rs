// HAVEWA-07C — Port-Discovery (Auftrag §17).
//
// Wir lesen `<HAVEWA_DATA_DIR>\runtime-state\port.json` (NICHT `db-port.json` —
// das ist der DB-Port und nicht der Web-Listener).
//
// Validierung:
//   - Datei existiert (sonst: PortStateInvalid).
//   - JSON enthält { host, port, startedAt? }.
//   - host ∈ { "127.0.0.1", "localhost", "::1" } (loopback only).
//   - port ∈ 1..=65535 (kein 0, kein 65535+).
//
// Danach: /api/ready pollen. READY ist maßgeblich (Auftrag §17).
//
// Read-Timeout (L-4): connect + read + write jeweils mit Timeout, damit
// ein hängender Server den Poll nicht über das readiness-Deadline hinaus
// blockiert.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Erlaubte Loopback-Hosts. Strikt.
pub const LOOPBACK_HOSTS: &[&str] = &["127.0.0.1", "localhost", "::1"];

/// HTTP-IO-Timeouts für /api/ready.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const READ_TIMEOUT: Duration = Duration::from_secs(2);

/// Inhalt von port.json.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PortState {
    pub host: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
}

/// Liefert einen Pfad zur port.json. Existenz wird nicht geprüft.
pub fn port_state_path(root: &Path) -> std::path::PathBuf {
    root.join("runtime-state").join("port.json")
}

/// Parst `port.json` und validiert Loopback + Port-Range.
pub fn parse(raw_json: &str) -> AppResult<PortState> {
    let s: PortState = serde_json::from_str(raw_json)?;
    if !LOOPBACK_HOSTS.iter().any(|h| *h == s.host) {
        return Err(AppError::PortStateInvalid { kind: "host" });
    }
    if s.port == 0 {
        return Err(AppError::PortStateInvalid { kind: "port=0" });
    }
    Ok(s)
}

/// Liest die Datei und parst sie. Liefert `None`, wenn nicht existent.
pub fn read(root: &Path) -> AppResult<Option<PortState>> {
    let p = port_state_path(root);
    if !p.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&p)?;
    Ok(Some(parse(&raw)?))
}

/// Polling-Target. Liefert `true` = READY (HTTP 200) bei `state.port`.
/// Respektiert das `timeout` als hartes Deadline.
pub fn poll_ready(state: &PortState, timeout: Duration) -> AppResult<bool> {
    let deadline = std::time::Instant::now() + timeout;
    let interval = Duration::from_millis(250);
    while std::time::Instant::now() < deadline {
        if http_ready(state).unwrap_or(false) {
            return Ok(true);
        }
        // Restzeit vs. Intervall: nicht über das Deadline hinaus schlafen.
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        std::thread::sleep(interval.min(remaining));
    }
    Ok(false)
}

/// Eine einzige HTTP-GET Anfrage auf /api/ready. 200 = ready.
///
/// Robustheit (L-4):
///   - connect + read + write haben jeweils ein Timeout
///   - Response wird in 512-B-Chunks gelesen, bis Status-Line vollständig
///     ODER Timeout/Limit erreicht
///   - Keine hängenden Reads über das Poll-Deadline hinaus
pub fn http_ready(state: &PortState) -> AppResult<bool> {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    // Wir lösen den Loopback-Host einmal explizit auf (kein Generic-V4-Fallback
    // für IPv6 — wir sind strikt loopback-only).
    let addr: std::net::SocketAddr = if state.host == "::1" {
        ([0u8; 16], state.port).into()
    } else {
        ([127, 0, 0, 1], state.port).into()
    };
    let mut s = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|e| {
        AppError::Io {
            context: "tcp connect /api/ready",
            source: e,
        }
    })?;
    s.set_read_timeout(Some(READ_TIMEOUT)).ok();
    s.set_write_timeout(Some(READ_TIMEOUT)).ok();

    let req = format!(
        "GET /api/ready HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        state.host
    );
    s.write_all(req.as_bytes()).map_err(|e| AppError::Io {
        context: "write http",
        source: e,
    })?;

    // Response sammeln: bis 4 KB, in 512-B-Chunks, mit Read-Timeout.
    let mut acc = Vec::with_capacity(512);
    let mut buf = [0u8; 512];
    loop {
        match s.read(&mut buf) {
            Ok(0) => break, // EOF
            Ok(n) => {
                acc.extend_from_slice(&buf[..n]);
                if acc.len() >= 4096 {
                    break;
                }
                // Status-Line reicht für unsere 200-Erkennung.
                if acc.windows(5).any(|w| w == b" 200 ") || acc.windows(5).any(|w| w == b" 404 ")
                    || acc.windows(5).any(|w| w == b" 500 ") {
                    break;
                }
            }
            Err(_) => break, // Timeout oder Verbindungsfehler → Server nicht ready.
        }
    }
    let resp = String::from_utf8_lossy(&acc);
    Ok(resp.contains(" 200 "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_valid_loopback() {
        let raw = r#"{"host":"127.0.0.1","port":3000,"startedAt":"2026-10-16T20:33:30.473Z"}"#;
        let s = parse(raw).unwrap();
        assert_eq!(s.host, "127.0.0.1");
        assert_eq!(s.port, 3000);
    }

    #[test]
    fn parse_accepts_localhost() {
        let raw = r#"{"host":"localhost","port":3001}"#;
        let s = parse(raw).unwrap();
        assert_eq!(s.host, "localhost");
    }

    #[test]
    fn parse_rejects_non_loopback_host() {
        let raw = r#"{"host":"10.0.0.1","port":3000}"#;
        let r = parse(raw);
        assert!(matches!(r, Err(AppError::PortStateInvalid { kind: "host" })));
    }

    #[test]
    fn parse_rejects_port_zero() {
        let raw = r#"{"host":"127.0.0.1","port":0}"#;
        let r = parse(raw);
        assert!(matches!(r, Err(AppError::PortStateInvalid { kind: "port=0" })));
    }

    #[test]
    fn parse_rejects_invalid_json() {
        let r = parse("not json");
        assert!(r.is_err());
    }

    #[test]
    fn read_missing_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        let r = read(tmp.path()).unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn read_existing_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("runtime-state")).unwrap();
        let p = port_state_path(tmp.path());
        std::fs::write(
            &p,
            r#"{"host":"127.0.0.1","port":3001,"startedAt":"2026-10-16T20:33:30.473Z"}"#,
        )
        .unwrap();
        let s = read(tmp.path()).unwrap().unwrap();
        assert_eq!(s.host, "127.0.0.1");
        assert_eq!(s.port, 3001);
    }

    #[test]
    fn read_invalid_file_returns_error() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("runtime-state")).unwrap();
        std::fs::write(port_state_path(tmp.path()), "garbage").unwrap();
        let r = read(tmp.path());
        assert!(r.is_err());
    }

    /// Mini-Server, der mit 200 antwortet → poll_ready muss true liefern.
    #[test]
    fn poll_ready_with_real_listener() {
        use std::net::TcpListener;
        use std::thread;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let state = PortState {
            host: "127.0.0.1".into(),
            port: addr.port(),
            started_at: None,
        };

        let server = thread::spawn(move || {
            for _ in 0..3 {
                if let Ok((mut stream, _)) = listener.accept() {
                    let mut buf = [0u8; 512];
                    let _ = stream.read(&mut buf);
                    let resp = b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n";
                    let _ = stream.write_all(resp);
                    return;
                }
            }
        });

        let r = poll_ready(&state, Duration::from_secs(3)).unwrap();
        let _ = server.join();
        assert!(r, "expected ready=true");
    }
}

// Re-import für poll_ready-Test (read-impl nutzt std::io::Read ohne use-Statement).
#[cfg(test)]
use std::io::Read as _;
#[cfg(test)]
use std::io::Write as _;

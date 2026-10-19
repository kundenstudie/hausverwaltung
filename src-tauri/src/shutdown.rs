// HAVEWA-07C — Shutdown-API-Aufruf (Auftrag §8, §9).
//
// Kein zusätzliches HTTP-Crate. Raw TCP/POST auf loopback.
//
// Contract (siehe src/app/api/shutdown/route.ts in 07A-2):
//   - POST /api/shutdown
//   - Header: X-Shutdown-Token: <token>
//   - Erfolg: HTTP 202
//   - 401: token wrong
//   - 403: not loopback
//   - 404: SHUTDOWN_TOKEN env not set on server
//
// Env-Name: SHUTDOWN_TOKEN (NICHT HAVEWA_SHUTDOWN_TOKEN — Mismatch wurde
// im Review aufgedeckt).
//
// Secrets: Token wird in den Header geschrieben, NICHT geloggt.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use crate::error::{AppError, AppResult};

/// POST /api/shutdown auf loopback mit Token-Header.
///
/// Liefert Ok(()) bei HTTP 202. Andere Statuscodes oder Netzwerkfehler
/// liefern Err, werden vom Caller als „graceful misslungen → fail-safe"
/// interpretiert (Caller fällt auf Child-Wait + TerminateProcess zurück).
pub fn call_shutdown_api(url: String, token: &str, timeout: Duration) -> AppResult<()> {
    // URL parsen (minimal).
    let (host, port, path) = parse_url(&url)?;

    // Loopback-Erzwingung (Defense-in-Depth).
    if !is_loopback_host(&host) {
        return Err(AppError::Webview("shutdown_not_loopback"));
    }

    // Connect mit Timeout.
    let addr: std::net::SocketAddr = if host == "::1" {
        ([0u8; 16], port).into()
    } else {
        ([127, 0, 0, 1], port).into()
    };

    let mut stream = TcpStream::connect_timeout(&addr, timeout).map_err(|e| AppError::Io {
        context: "shutdown tcp connect",
        source: e,
    })?;
    stream.set_read_timeout(Some(timeout)).ok();
    stream.set_write_timeout(Some(timeout)).ok();

    // Request zusammenbauen. Token kommt in den Header, NICHT in den Body.
    let req = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nX-Shutdown-Token: {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).map_err(|e| AppError::Io {
        context: "shutdown write",
        source: e,
    })?;

    // Response lesen (max. 512 B — Status-Line reicht).
    let mut buf = [0u8; 512];
    let n = stream.read(&mut buf).map_err(|e| AppError::Io {
        context: "shutdown read",
        source: e,
    })?;
    let resp = String::from_utf8_lossy(&buf[..n]);

    // 202 = Erfolg.
    if resp.contains(" 202 ") {
        Ok(())
    } else if resp.contains(" 401 ") {
        Err(AppError::ShutdownApi("401_unauthorized"))
    } else if resp.contains(" 403 ") {
        Err(AppError::ShutdownApi("403_forbidden"))
    } else if resp.contains(" 404 ") {
        Err(AppError::ShutdownApi("404_not_found"))
    } else {
        // Unbekannt → fail-safe.
        let _ = resp; // explizit nicht loggen
        Err(AppError::ShutdownApi("unexpected_status"))
    }
}

fn parse_url(url: &str) -> AppResult<(String, u16, String)> {
    let rest = url
        .strip_prefix("http://")
        .ok_or(AppError::Webview("shutdown_url_scheme"))?;
    let (host_port, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let mut parts = host_port.splitn(2, ':');
    let host = parts.next().unwrap_or("").to_string();
    let port: u16 = parts
        .next()
        .map(|p| p.parse().map_err(|_| AppError::Webview("shutdown_url_port")))
        .transpose()?
        .unwrap_or(80);
    Ok((host, port, path.to_string()))
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "::1" | "localhost")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_url_full() {
        let (h, p, path) = parse_url("http://127.0.0.1:3000/api/shutdown").unwrap();
        assert_eq!(h, "127.0.0.1");
        assert_eq!(p, 3000);
        assert_eq!(path, "/api/shutdown");
    }

    #[test]
    fn parse_url_no_path() {
        let (h, p, path) = parse_url("http://127.0.0.1:3000").unwrap();
        assert_eq!(h, "127.0.0.1");
        assert_eq!(p, 3000);
        assert_eq!(path, "/");
    }

    #[test]
    fn parse_url_no_port() {
        let (h, p, path) = parse_url("http://localhost/api/x").unwrap();
        assert_eq!(h, "localhost");
        assert_eq!(p, 80);
        assert_eq!(path, "/api/x");
    }

    #[test]
    fn loopback_check() {
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("localhost"));
        assert!(!is_loopback_host("10.0.0.1"));
        assert!(!is_loopback_host("example.com"));
    }

    // Echter Loopback-Listener-Test: wir starten einen Mini-TCP-Server
    // auf 127.0.0.1, der mit 202 antwortet, und prüfen, dass der
    // Shutdown-Call das akzeptiert.
    #[test]
    fn call_shutdown_api_accepts_202() {
        use std::net::TcpListener;
        use std::thread;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{addr}/api/shutdown");

        let server = thread::spawn(move || {
            // Ein einziger Request.
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 512];
                let _ = stream.read(&mut buf);
                let resp = b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n";
                let _ = stream.write_all(resp);
            }
        });

        let r = call_shutdown_api(url, "test-token", Duration::from_secs(2));
        let _ = server.join();
        assert!(r.is_ok(), "expected Ok, got {r:?}");
    }

    #[test]
    fn call_shutdown_api_rejects_401() {
        use std::net::TcpListener;
        use std::thread;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{addr}/api/shutdown");

        let server = thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 512];
                let _ = stream.read(&mut buf);
                let resp = b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n";
                let _ = stream.write_all(resp);
            }
        });

        let r = call_shutdown_api(url, "bad", Duration::from_secs(2));
        let _ = server.join();
        assert!(matches!(r, Err(AppError::ShutdownApi("401_unauthorized"))));
    }
}

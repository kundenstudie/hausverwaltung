// HAVEWA-07C — Navigation-Guard (Auftrag §12 / §13).
//
// CSP allein blockiert NICHT zuverlässig Top-Level-Navigation.
// Wir setzen daher einen expliziten on_navigation-Predicate:
//
//   erlaubt:
//     - about:blank, about:splash (interne Tauri-URLs für Splash-Window)
//     - http://127.0.0.1:<port>  (Loopback-Backend)
//
//   verboten:
//     - alles andere (http/https remote, file:, javascript:, data:, ...)
//
// Testbar als reine Funktion `is_allowed_url`.

use crate::error::{AppError, AppResult};

/// Erlaubte URL-Schemes für interne Tauri-URLs.
const INTERNAL_SCHEMES: &[&str] = &["about:"];

/// Predicate: ist die URL als Top-Level-Navigation erlaubt?
///
/// Akzeptiert:
///   - `about:` (Tauri-interne Splash-URLs)
///   - `http://127.0.0.1:<port>` (Loopback-Backend)
///   - `http://[::1]:<port>` (IPv6-Loopback, eckige Klammern)
///
/// Alles andere wird abgelehnt. Insbesondere:
///   - http(s)://remote-host
///   - file:, javascript:, data:, blob:
pub fn is_allowed_url(url: &str, allowed_loopback_hosts: &[&str]) -> bool {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return false;
    }

    // 1) Interne Tauri-URLs (about:)
    for scheme in INTERNAL_SCHEMES {
        if trimmed.starts_with(scheme) {
            return true;
        }
    }

    // 2) Loopback http(s) — strikt nur die erlaubten Hosts.
    //    IPv6-Hosts kommen in eckigen Klammern: [::1]:3000.
    if let Some(rest) = trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("https://"))
    {
        let host_port = rest.split('/').next().unwrap_or("");
        // IPv6: [::1] oder [::1]:port
        let host = if let Some(stripped) = host_port.strip_prefix('[') {
            // Bis zum nächsten ']' lesen.
            stripped.split(']').next().unwrap_or("")
        } else {
            // IPv4 oder Hostname: bis zum ersten ':'
            host_port.split(':').next().unwrap_or("")
        };
        return allowed_loopback_hosts.iter().any(|h| *h == host);
    }

    false
}

/// Convenience: Default-Allowed-Hosts für die produktive Runtime
/// (Loopback-only, IPv4 + IPv6).
pub fn default_allowed_loopback_hosts() -> &'static [&'static str] {
    &["127.0.0.1", "::1", "localhost"]
}

/// Baut einen Navigation-Guard-Callback für Tauri v2 (`Fn(&tauri::Url)`).
/// Nutzt `is_allowed_url` und blockiert alles andere.
///
/// `allowed_hosts` werden vom Caller vorgegeben (typisch: 127.0.0.1).
pub fn build_guard(
    allowed_hosts: &'static [&'static str],
) -> impl Fn(&tauri::Url) -> bool + Send + Sync + 'static {
    move |url: &tauri::Url| is_allowed_url(url.as_str(), allowed_hosts)
}

/// Parst einen Loopback-URL-String und liefert (host, port).
/// Wird für die Konfiguration des Navigation-Guards verwendet.
pub fn parse_loopback_url(url: &str) -> AppResult<(String, u16)> {
    // Minimal-Parser: http://host:port, http://[::1]:port, oder http://host
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .ok_or(AppError::Webview("url_scheme"))?;
    let host_port = rest.split('/').next().unwrap_or("");
    // IPv6: [::1]:port
    if let Some(stripped) = host_port.strip_prefix('[') {
        let end = stripped
            .find(']')
            .ok_or(AppError::Webview("url_ipv6_unterminated"))?;
        let host = &stripped[..end];
        let after = &stripped[end + 1..];
        let port: u16 = if let Some(p) = after.strip_prefix(':') {
            p.parse().map_err(|_| AppError::Webview("url_port"))?
        } else {
            80
        };
        return Ok((host.to_string(), port));
    }
    let mut parts = host_port.splitn(2, ':');
    let host = parts.next().unwrap_or("").to_string();
    let port: u16 = parts
        .next()
        .map(|p| p.parse().map_err(|_| AppError::Webview("url_port")))
        .transpose()?
        .unwrap_or(80);
    Ok((host, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hosts() -> &'static [&'static str] {
        default_allowed_loopback_hosts()
    }

    #[test]
    fn allows_about_blank() {
        assert!(is_allowed_url("about:blank", hosts()));
        assert!(is_allowed_url("about:splash", hosts()));
    }

    #[test]
    fn allows_loopback_http() {
        assert!(is_allowed_url("http://127.0.0.1:3000", hosts()));
        assert!(is_allowed_url("http://127.0.0.1:3000/path", hosts()));
        assert!(is_allowed_url("http://localhost:3000", hosts()));
        assert!(is_allowed_url("http://[::1]:3000", hosts()));
    }

    #[test]
    fn rejects_remote_http() {
        assert!(!is_allowed_url("http://example.com", hosts()));
        assert!(!is_allowed_url("http://192.168.1.1", hosts()));
        assert!(!is_allowed_url("https://evil.com/path", hosts()));
    }

    #[test]
    fn rejects_dangerous_schemes() {
        assert!(!is_allowed_url("file:///etc/passwd", hosts()));
        assert!(!is_allowed_url("javascript:alert(1)", hosts()));
        assert!(!is_allowed_url("data:text/html,<script>", hosts()));
        assert!(!is_allowed_url("blob:http://127.0.0.1/abc", hosts()));
    }

    #[test]
    fn rejects_empty() {
        assert!(!is_allowed_url("", hosts()));
    }

    #[test]
    fn parse_loopback_url_ok() {
        let (h, p) = parse_loopback_url("http://127.0.0.1:3000").unwrap();
        assert_eq!(h, "127.0.0.1");
        assert_eq!(p, 3000);
    }

    #[test]
    fn parse_loopback_url_no_port() {
        let (h, p) = parse_loopback_url("http://127.0.0.1").unwrap();
        assert_eq!(h, "127.0.0.1");
        assert_eq!(p, 80);
    }

    #[test]
    fn parse_loopback_url_bad_scheme() {
        assert!(parse_loopback_url("https://evil.com").is_ok()); // scheme ok, host parsed
        assert!(parse_loopback_url("ftp://x").is_err());
    }
}

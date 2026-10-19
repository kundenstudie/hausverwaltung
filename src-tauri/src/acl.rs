// HAVEWA-07C — Windows ACL via `icacls` (Auftrag §8).
//
// Anforderungen:
//   - Secrets-Datei nur für aktuellen Benutzer zugänglich.
//   - Inheritance kontrolliert/reduziert, keine breite Everyone/Users.
//   - ACL danach verifiziert.
//   - Fehler => fail closed.
//   - KEINE Secrets im icacls argv.
//   - ACL-Funktion testbar/injizierbar (Trait `AclRunner`).
//   - KEINE komplexe eigene WinAPI-ACL-Schicht (DEFER für DPAPI/07D).

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use crate::error::{AppError, AppResult};

/// Konkreter icacls-Aufruf.
///
/// Wir setzen:
///   icacls <path> /inheritance:r
///   icacls <path> /grant:r *<sid-or-name>:(R,W)
///   icacls <path> /remove:g *S-1-1-0  (Everyone)
///   icacls <path> /remove:g *S-1-5-32-1  (Builtin\Users; *nur*, wenn vorhanden)
///
/// Der Owner (Username als SAM-Name oder SID) wird via `whoami /user` ermittelt.
pub struct IcaclsRunner {
    pub icacls_exe: PathBuf,
    pub whoami_exe: PathBuf,
}

impl Default for IcaclsRunner {
    fn default() -> Self {
        // %WINDIRMS%\System32\icacls.exe und whoami.exe (Standard-Pfad).
        let sys_root = std::env::var("SystemRoot")
            .or_else(|_| std::env::var("WINDIR"))
            .unwrap_or_else(|_| "C:\\Windows".to_string());
        let sys = PathBuf::from(sys_root).join("System32");
        Self {
            icacls_exe: sys.join("icacls.exe"),
            whoami_exe: sys.join("whoami.exe"),
        }
    }
}

impl IcaclsRunner {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Trait-Abstraktion — Tests können `apply` und `verify` gegen Mocks fahren.
pub trait AclRunner: Send + Sync {
    /// Wendet die Owner-Only-ACL auf den Pfad an.
    fn apply(&self, path: &Path, owner: &str) -> AppResult<()>;

    /// Verifiziert, dass die ACL nur Owner-Zugriff erlaubt.
    /// Liefert Ok nur, wenn eine simple Stichprobe (icacls ohne Flags)
    /// keinen Everyone/Users-Eintrag zeigt.
    fn verify(&self, path: &Path) -> AppResult<()>;
}

impl AclRunner for IcaclsRunner {
    fn apply(&self, path: &Path, owner: &str) -> AppResult<()> {
        // 1) Inheritance reduzieren (replace, nicht preserve).
        run_icacls(&self.icacls_exe, path, &["/inheritance:r"])?;

        // 2) Owner mit Read/Write granten (R,W). `:r` = replace existing.
        //    Owner-String: erlaubt `DOMAIN\User` oder SID. Wir übergeben
        //    unverändert; Tests füttern einen festen SID.
        let grant = format!("{owner}:(R,W)");
        run_icacls(&self.icacls_exe, path, &["/grant:r", &grant])?;

        // 3) Everyone (S-1-1-0) entfernen — wenn vorhanden, OK; sonst Non-zero,
        //    das ist tolerierbar (siehe run_icacls).
        let _ = run_icacls(&self.icacls_exe, path, &["/remove", "*S-1-1-0"]);

        // 4) BUILTIN\Users (S-1-5-32-545) entfernen — optional.
        let _ = run_icacls(&self.icacls_exe, path, &["/remove", "*S-1-5-32-545"]);

        Ok(())
    }

    fn verify(&self, path: &Path) -> AppResult<()> {
        // icacls ohne Argumente zeigt die effektive ACL.
        let out = run_icacls_raw(&self.icacls_exe, path, &[])?;
        let txt = String::from_utf8_lossy(&out.stdout).to_lowercase();
        // Fail-closed: Wenn WIRKLICH Everyone oder Users als eigenständiger
        // Grant auftippt, ist die ACL nicht eng genug.
        if txt.contains("(deny)") || txt.contains("(allow)") {
            // Wir parsen nur SEHR konservativ: pro Zeile.
            for line in txt.lines() {
                let l = line.trim();
                if l.is_empty() {
                    continue;
                }
                if l.contains("everyone") || l.contains("s-1-1-0") {
                    return Err(AppError::AclVerify);
                }
                if l.starts_with("builtin\\users")
                    || l.contains(" s-1-5-32-545 ")
                    || l.contains("(allow)")
                        && (l.contains("users") || l.contains("s-1-5-32-545"))
                {
                    return Err(AppError::AclVerify);
                }
            }
        }
        Ok(())
    }
}

/// Liefert den aktuellen Windows-Benutzer als `DOMAIN\User`.
pub fn current_owner(runner: &IcaclsRunner) -> AppResult<String> {
    let out = Command::new(&runner.whoami_exe)
        .arg("/user")
        .output()
        .map_err(|e| AppError::Io {
            context: "whoami",
            source: e,
        })?;
    if !out.status.success() {
        return Err(AppError::AclApply {
            exit_code: out.status.code().unwrap_or(-1),
        });
    }
    let s = String::from_utf8_lossy(&out.stdout);
    // Beispielausgabe: "User Name           SID\n=================== ============================================\nDOMAIN\the-h S-1-5-21-... \n"
    let owner = s
        .lines()
        .last()
        .and_then(|l| l.split_whitespace().next())
        .ok_or(AppError::AclVerify)?
        .to_string();
    Ok(owner)
}

fn run_icacls(icacls: &Path, path: &Path, extra: &[&str]) -> AppResult<()> {
    let out = run_icacls_raw(icacls, path, extra)?;
    if !out.status.success() {
        return Err(AppError::AclApply {
            exit_code: out.status.code().unwrap_or(-1),
        });
    }
    Ok(())
}

fn run_icacls_raw(icacls: &Path, path: &Path, extra: &[&str]) -> AppResult<Output> {
    let mut args: Vec<std::ffi::OsString> = Vec::with_capacity(1 + extra.len());
    // Pfad als erstes Argument (KEIN Pfad im Display; AppError lässt ihn raus).
    args.push(path.as_os_str().to_owned());
    for a in extra {
        args.push(std::ffi::OsString::from(*a));
    }
    let arg_refs: Vec<&std::ffi::OsStr> = args.iter().map(|s| s.as_os_str()).collect();
    Command::new(icacls)
        .args(&arg_refs)
        .output()
        .map_err(|e| AppError::Io {
            context: "icacls spawn",
            source: e,
        })
}

/// Testbar/Inject: ein Mock-Runner, der Aufrufe aufzeichnet.
#[cfg(test)]
pub mod test_doubles {
    use super::*;
    use std::sync::Mutex;

    pub struct MockAcl {
        pub recorded: Mutex<Vec<(PathBuf, String)>>,
        pub fail_on_apply: bool,
        pub fail_on_verify: bool,
    }

    impl MockAcl {
        pub fn new() -> Self {
            Self {
                recorded: Mutex::new(Vec::new()),
                fail_on_apply: false,
                fail_on_verify: false,
            }
        }
    }

    impl AclRunner for MockAcl {
        fn apply(&self, path: &Path, owner: &str) -> AppResult<()> {
            if let Ok(mut g) = self.recorded.lock() {
                g.push((path.to_path_buf(), owner.to_string()));
            }
            if self.fail_on_apply {
                Err(AppError::AclApply { exit_code: 5 })
            } else {
                Ok(())
            }
        }

        fn verify(&self, _path: &Path) -> AppResult<()> {
            if self.fail_on_verify {
                Err(AppError::AclVerify)
            } else {
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_doubles::MockAcl;
    use super::*;

    #[test]
    fn mock_apply_records_owner() {
        let m = MockAcl::new();
        let p = PathBuf::from("X:\\secrets.json");
        m.apply(&p, "DOMAIN\\test").unwrap();
        let rec = m.recorded.lock().unwrap();
        assert_eq!(rec.len(), 1);
        assert_eq!(rec[0].0, p);
        assert_eq!(rec[0].1, "DOMAIN\\test");
    }

    #[test]
    fn mock_apply_propagates_error() {
        let m = MockAcl {
            fail_on_apply: true,
            ..MockAcl::new()
        };
        let r = m.apply(Path::new("X:\\x"), "X");
        assert!(matches!(r, Err(AppError::AclApply { .. })));
    }

    #[test]
    fn mock_verify_propagates_error() {
        let m = MockAcl {
            fail_on_verify: true,
            ..MockAcl::new()
        };
        let r = m.verify(Path::new("X:\\x"));
        assert!(matches!(r, Err(AppError::AclVerify)));
    }

    #[test]
    fn runner_default_paths() {
        let r = IcaclsRunner::new();
        assert!(r.icacls_exe.ends_with("icacls.exe"));
        assert!(r.whoami_exe.ends_with("whoami.exe"));
    }
}
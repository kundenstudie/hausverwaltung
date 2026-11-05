// HAVEWA-07D G3 — Env-Allowlist für Desktop-Child-Prozesse.
//
// Problem: `std::process::Command` erbt per Default die KOMPLETTE
// Eltern-Environment. Im Desktop-Betrieb heißt das: ein fremdes
// `DATABASE_URL`, `NODE_OPTIONS`, `SEED_DEMO`, `POSTGRES_*` oder
// `NEXT_*` aus der aufrufenden Shell könnten das Produktverhalten
// beeinflussen.
//
// Strategie (Auftrag §12):
//   - Wir bauen die Child-Environment EXPLIZIT auf (kein `env_clear` +
//     Raten), sondern übernehmen eine kurze Allowlist aus dem Eltern-Env
//     und setzen danach die Produktwerte.
//   - Windows-kritische Basisvariablen (SystemRoot, TEMP, ...) werden
//     übernommen, damit das Windows-CreateProcess nicht bricht.
//   - PATH wird für die Produkt-Runtime kontrolliert gesetzt (nur
//     Stage-Node + Stage-PostgreSQL, KEIN System-PostgreSQL, KEIN
//     System-Node, KEIN npm/npx/tsx).
//
// KEIN Secret wird hier erzeugt — nur weitergereicht. Die Secrets
// selbst kommen aus `secrets.rs` (persistent, ACL-geschützt).

use std::path::{Path, PathBuf};

/// Basis-Variablen, die Windows für Prozessstart/IO braucht.
///
/// Reihenfolge irrelevant, Inhalt kritisch: ohne `SystemRoot` findet
/// Windows u.a. die System-DLLs nicht.
pub const ENV_WINDOWS_BASE: &[&str] = &[
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "LOCALAPPDATA",
    "APPDATA",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramData",
    "ComSpec",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "PATHEXT",
    "USERNAME",
    "USERDOMAIN",
    "COMPUTERNAME",
    "PUBLIC",
];

/// Variablen, die wir NIEMALS aus dem Eltern-Env übernehmen.
///
/// Grund: sie würden entweder das Produktverhalten verändern
/// (Dev-Overrides) oder fremde Installationen referenzieren.
pub const ENV_DENY: &[&str] = &[
    // Dev-/Build-Overrides
    "NODE_OPTIONS",
    "NODE_ENV",
    "NEXT_PRIVATE_STANDALONE_CONFIG",
    "NEXT_PRIVATE_OUTPUT_TRACE_ROOT",
    "NEXT_PUBLIC_APP_VERSION",
    "NEXT_PUBLIC_APP_BUILD",
    "NEXT_PUBLIC_APP_SHA",
    "TURBOPACK",
    // Datenbank / Postgres aus fremder Umgebung
    "DATABASE_URL",
    "DATABASE_URL_TEST",
    "PGPASSWORD",
    "PGHOST",
    "PGPORT",
    "PGUSER",
    "PGDATABASE",
    "PGDATA",
    "PGSSLMODE",
    "PGSERVICE",
    "PGOPTIONS",
    "POSTGRES_PASSWORD",
    "POSTGRES_USER",
    "POSTGRES_HOST",
    "POSTGRES_PORT",
    "POSTGRES_DB",
    // Demo-Seed (darf im Produkt nicht aktiv sein)
    "SEED_DEMO",
    // Prisma-Overrides
    "PRISMA_SCHEMA_ENGINE_BINARY",
    "PRISMA_QUERY_ENGINE_BINARY",
    "PRISMA_MIGRATION_ENGINE_BINARY",
    "PRISMA_CLI_QUERY_ENGINE_TYPE",
    "PRISMA_GENERATE_SKIP_AUTOINSTALL",
    "PRISMA_GENERATE_NO_ENGINE",
    "PRISMA_CLIENT_ENGINE_TYPE",
    "PRISMA_HIDE_UPDATE_MESSAGE",
    // Node-Toolchain-Overrides
    "HAVEWA_NODE_BIN",
    "HAVEWA_PRISMA_SKIP_GENERATE",
    "HAVEWA_DESKTOP_RUNTIME",
    "HAVEWA_DISABLE_SCHEDULER",
    "AUTH_SECRET",
    "AUTH_TRUST_HOST",
    "AUTH_URL",
    "NEXTAUTH_SECRET",
    "NEXTAUTH_URL",
    "SHUTDOWN_TOKEN",
    "PG_DBPASSWORD",
    "POSTGRES_RUNTIME_DIR",
    "HAVEWA_DATA_DIR",
];

/// Produktvariablen, die wir IMMER setzen (unabhängig vom Eltern-Env).
///
/// Reihenfolge = Priorität. Werte werden vom Caller geliefert.
pub const ENV_PRODUCT_REQUIRED: &[&str] = &[
    "HAVEWA_DATA_DIR",
    "HAVEWA_DESKTOP_RUNTIME",
    "HAVEWA_PRISMA_SKIP_GENERATE",
    "AUTH_SECRET",
    "AUTH_TRUST_HOST",
    "PG_DBPASSWORD",
    "SHUTDOWN_TOKEN",
    "POSTGRES_RUNTIME_DIR",
];

/// Baut die Basis-Allowlist aus dem Eltern-Environment.
///
/// `PATH` wird bewusst NICHT übernommen — der Caller setzt einen
/// kontrollierten PATH (siehe `build_controlled_path`).
pub fn build_base_env() -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for key in ENV_WINDOWS_BASE {
        if let Ok(v) = std::env::var(key) {
            if !v.is_empty() {
                out.push(((*key).to_string(), v));
            }
        }
    }
    // Alles andere, was im Eltern-Env stand und nicht auf der Deny-Liste
    // ist, übernehmen wir NICHT — nur die Basis-Liste ist sicher genug.
    out
}

/// Baut einen kontrollierten PATH für die Produkt-Runtime.
///
/// Enthält:
///   1) Stage-Node-Verzeichnis   (runtime/node)
///   2) Stage-PostgreSQL-Verzeichnis (runtime/postgres/bin)
///   3) das System-Windows-Verzeichnis (SystemRoot\System32) — nötig für
///      DLL-Auflösung von System-Komponenten (z.B. `bcrypt.dll`).
///
/// NICHT enthalten: System-Node, npm/npx/tsx, System-PostgreSQL.
pub fn build_controlled_path(node_dir: &Path, pg_bin_dir: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();
    parts.push(node_dir.display().to_string());
    parts.push(pg_bin_dir.display().to_string());
    // System32 fuer System-DLLs (kein Node, kein PG).
    if let Ok(system_root) = std::env::var("SystemRoot") {
        parts.push(
            PathBuf::from(&system_root)
                .join("System32")
                .display()
                .to_string(),
        );
    }
    parts.join(";")
}

/// Repräsentiert ein fertiges Child-Environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildEnv {
    pub vars: Vec<(String, String)>,
}

impl ChildEnv {
    /// Erzeugt die Basis-Allowlist ohne PATH.
    pub fn base() -> Self {
        ChildEnv {
            vars: build_base_env(),
        }
    }

    /// Setzt (oder überschreibt) eine Variable.
    pub fn set(&mut self, key: &str, value: &str) {
        if value.is_empty() {
            return;
        }
        let k = key.to_string();
        if let Some(slot) = self.vars.iter_mut().find(|(existing, _)| *existing == k) {
            slot.1 = value.to_string();
        } else {
            self.vars.push((k, value.to_string()));
        }
    }

    /// Setzt eine Variable nur, wenn sie noch nicht gesetzt ist.
    pub fn set_if_absent(&mut self, key: &str, value: &str) {
        if self.get(key).is_none() {
            self.set(key, value);
        }
    }

    /// Liest eine Variable.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.vars
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// Prüft, ob eine Variable gesetzt ist.
    pub fn contains(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// Anzahl der gesetzten Variablen.
    pub fn len(&self) -> usize {
        self.vars.len()
    }

    /// Ob keine Variable gesetzt ist.
    pub fn is_empty(&self) -> bool {
        self.vars.is_empty()
    }

    /// Entfernt eine Variable (fail-closed beim Scrubbing).
    pub fn remove(&mut self, key: &str) {
        self.vars.retain(|(k, _)| k != key);
    }
}

/// Setzt die Produktvariablen für den Desktop-Betrieb.
///
/// Pflichtwerte (Auftrag §11):
///   - HAVEWA_DATA_DIR        = Data Root (persistent, getrennt vom Install-Root)
///   - HAVEWA_DESKTOP_RUNTIME = "1"
///   - HAVEWA_PRISMA_SKIP_GENERATE = "1"
///   - AUTH_SECRET            = persistentes Secret
///   - AUTH_TRUST_HOST        = "true"
///   - PG_DBPASSWORD          = persistentes Secret
///   - SHUTDOWN_TOKEN         = persistentes Secret
///   - POSTGRES_RUNTIME_DIR   = Stage-PostgreSQL bin
///   - PATH                   = kontrolliert
pub fn apply_product_env(
    env: &mut ChildEnv,
    data_dir: &Path,
    node_dir: &Path,
    pg_bin_dir: &Path,
    auth_secret: &str,
    db_password: &str,
    shutdown_token: &str,
) {
    env.set("HAVEWA_DATA_DIR", &data_dir.display().to_string());
    env.set("HAVEWA_DESKTOP_RUNTIME", "1");
    env.set("HAVEWA_PRISMA_SKIP_GENERATE", "1");
    env.set("AUTH_SECRET", auth_secret);
    // Auth.js verlangt fuer Loopback-Hosts einen Trust-Hinweis, sonst
    // "UntrustedHost: Host must be trusted" (in G2 live bewiesen).
    env.set("AUTH_TRUST_HOST", "true");
    env.set("PG_DBPASSWORD", db_password);
    env.set("SHUTDOWN_TOKEN", shutdown_token);
    env.set("POSTGRES_RUNTIME_DIR", &pg_bin_dir.display().to_string());
    // Kontrollierter PATH: Stage-Node + Stage-PG + System32.
    env.set("PATH", &build_controlled_path(node_dir, pg_bin_dir));
    // NODE_ENV explizit production — nicht aus der Shell erben.
    env.set("NODE_ENV", "production");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_env_has_no_deny_listed_keys() {
        let env = ChildEnv::base();
        for k in ENV_DENY {
            assert!(
                !env.contains(k),
                "base env must not inherit denied key {k}"
            );
        }
    }

    #[test]
    fn base_env_has_no_path() {
        // PATH wird kontrolliert gesetzt, nicht geerbt.
        let env = ChildEnv::base();
        assert!(!env.contains("PATH"));
        assert!(!env.contains("Path"));
    }

    #[test]
    fn deny_list_covers_critical_dev_overrides() {
        for k in [
            "NODE_OPTIONS",
            "DATABASE_URL",
            "SEED_DEMO",
            "PRISMA_CLI_QUERY_ENGINE_TYPE",
            "POSTGRES_RUNTIME_DIR",
            "AUTH_SECRET",
            "PG_DBPASSWORD",
            "SHUTDOWN_TOKEN",
            "HAVEWA_DATA_DIR",
        ] {
            assert!(ENV_DENY.contains(&k), "missing deny entry {k}");
        }
    }

    #[test]
    fn product_env_sets_all_required_keys() {
        let mut env = ChildEnv::base();
        apply_product_env(
            &mut env,
            Path::new("C:\\data"),
            Path::new("C:\\inst\\runtime\\node"),
            Path::new("C:\\inst\\runtime\\postgres\\bin"),
            "auth-secret",
            "db-password",
            "shutdown-token",
        );
        for k in ENV_PRODUCT_REQUIRED {
            assert!(env.contains(k), "missing product env key {k}");
        }
        assert_eq!(env.get("HAVEWA_DESKTOP_RUNTIME"), Some("1"));
        assert_eq!(env.get("HAVEWA_PRISMA_SKIP_GENERATE"), Some("1"));
        assert_eq!(env.get("AUTH_TRUST_HOST"), Some("true"));
        assert_eq!(env.get("AUTH_SECRET"), Some("auth-secret"));
        assert_eq!(env.get("PG_DBPASSWORD"), Some("db-password"));
        assert_eq!(env.get("SHUTDOWN_TOKEN"), Some("shutdown-token"));
        assert_eq!(
            env.get("HAVEWA_DATA_DIR"),
            Some("C:\\data")
        );
        assert_eq!(
            env.get("POSTGRES_RUNTIME_DIR"),
            Some("C:\\inst\\runtime\\postgres\\bin")
        );
    }

    #[test]
    fn controlled_path_contains_stage_dirs_and_system32_but_no_system_node() {
        let p = build_controlled_path(
            Path::new("C:\\inst\\runtime\\node"),
            Path::new("C:\\inst\\runtime\\postgres\\bin"),
        );
        assert!(p.contains("C:\\inst\\runtime\\node"));
        assert!(p.contains("C:\\inst\\runtime\\postgres\\bin"));
        assert!(p.contains("System32"));
        // Kein System-Node, kein System-PostgreSQL.
        assert!(!p.contains(".tools"));
        assert!(!p.contains("Program Files"));
    }

    #[test]
    fn product_env_does_not_leak_dev_overrides() {
        let mut env = ChildEnv::base();
        // Simuliert: Eltern-Env hatte NODE_OPTIONS (wird nicht geerbt).
        apply_product_env(
            &mut env,
            Path::new("C:\\data"),
            Path::new("C:\\n"),
            Path::new("C:\\p"),
            "s1",
            "s2",
            "s3",
        );
        assert!(!env.contains("NODE_OPTIONS"));
        assert!(!env.contains("SEED_DEMO"));
        assert!(!env.contains("DATABASE_URL"));
    }

    #[test]
    fn set_overwrites_existing() {
        let mut env = ChildEnv::base();
        env.set("FOO", "a");
        env.set("FOO", "b");
        assert_eq!(env.get("FOO"), Some("b"));
        // Der Wert kommt genau einmal vor (kein Duplikat).
        let count = env.vars.iter().filter(|(k, _)| k == "FOO").count();
        assert_eq!(count, 1);
    }

    #[test]
    fn set_if_absent_keeps_existing() {
        let mut env = ChildEnv::base();
        env.set("FOO", "a");
        env.set_if_absent("FOO", "b");
        assert_eq!(env.get("FOO"), Some("a"));
    }

    #[test]
    fn remove_drops_key() {
        let mut env = ChildEnv::base();
        env.set("FOO", "a");
        env.remove("FOO");
        assert!(!env.contains("FOO"));
    }

    #[test]
    fn empty_values_are_not_set() {
        let mut env = ChildEnv::base();
        env.set("FOO", "");
        assert!(!env.contains("FOO"));
    }
}

//! Settings. Each `S3BROWSER_*` setting is read from the environment (a `.env`
//! in the working directory is loaded first) and falls back to
//! `~/.s3browser/config.toml`. Secrets also fall back to files in that
//! directory; the encryption key never comes from config.toml.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;

use anyhow::{Context, bail};
use log::warn;
use serde::Serialize;

use crate::paths::AppPaths;

pub const BIND_ENV_VAR: &str = "S3BROWSER_BIND";
pub const LOGIN_PASSWORD_ENV_VAR: &str = "S3BROWSER_LOGIN_PASSWORD";
pub const PRESIGNED_URL_TTLS_ENV_VAR: &str = "S3BROWSER_PRESIGNED_URL_TTLS";
pub const SEARCH_WHITELIST_ENV_VAR: &str = "S3BROWSER_SEARCH_WHITELIST_HOSTS";
pub const ENCRYPTION_KEY_ENV_VAR: &str = "S3BROWSER_ENCRYPTION_KEY";
pub const SEED_TEST_ITEMS_ENV_VAR: &str = "FEATURE_SEED_TEST_ITEMS";

/// The settings config.toml may hold.
const CONFIG_FILE_KEYS: [&str; 4] = [
    BIND_ENV_VAR,
    LOGIN_PASSWORD_ENV_VAR,
    PRESIGNED_URL_TTLS_ENV_VAR,
    SEARCH_WHITELIST_ENV_VAR,
];

const MIN_LOGIN_PASSWORD_LEN: usize = 16;
const MIN_ENCRYPTION_KEY_LEN: usize = 32;
const DEFAULT_PRESIGNED_URL_TTLS: &str = "1h,1d";
/// AWS SigV4 presigned URLs live at most 7 days.
pub const MAX_TTL_SECONDS: u64 = 7 * 24 * 60 * 60;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtlOption {
    pub ttl: u64,
    pub short_label: String,
    pub long_label: String,
}

pub struct Config {
    pub paths: AppPaths,
    /// Environment value, else config.toml value, for each of `CONFIG_FILE_KEYS`.
    values: HashMap<&'static str, String>,
    encryption_key_env: Option<String>,
    pub seed_test_items: bool,
}

impl Config {
    pub fn load(paths: AppPaths) -> anyhow::Result<Self> {
        let config_path = paths.config();
        let file = match std::fs::read_to_string(&config_path) {
            Ok(text) => Some(text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e).with_context(|| format!("failed to read {}", config_path.display())),
        };
        Self::resolve(paths, file.as_deref(), |key| std::env::var(key).ok())
    }

    pub(crate) fn resolve(paths: AppPaths, file: Option<&str>, env: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let file_values = match file {
            Some(text) => parse_config_file(text, &paths.config())?,
            None => HashMap::new(),
        };
        let mut values = HashMap::new();
        for key in CONFIG_FILE_KEYS {
            // A variable that is set wins even when empty, as it does over a `.env`.
            if let Some(value) = env(key).or_else(|| file_values.get(key).cloned()) {
                values.insert(key, value);
            }
        }
        Ok(Self {
            paths,
            values,
            encryption_key_env: env(ENCRYPTION_KEY_ENV_VAR),
            seed_test_items: matches!(env(SEED_TEST_ITEMS_ENV_VAR).as_deref(), Some("true" | "1")),
        })
    }

    fn value(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }

    pub fn bind(&self) -> Option<&str> {
        self.value(BIND_ENV_VAR)
    }

    pub fn login_password(&self) -> anyhow::Result<String> {
        let password = match self.value(LOGIN_PASSWORD_ENV_VAR).filter(|v| !v.is_empty()) {
            Some(password) => Some(password.to_string()),
            None => read_secret_file(&self.paths.login_password(), MIN_LOGIN_PASSWORD_LEN),
        };
        match password {
            Some(password) if password.chars().count() >= MIN_LOGIN_PASSWORD_LEN => Ok(password),
            _ => bail!(
                "Login password not configured. Please either:\n  \
                 1. Set {LOGIN_PASSWORD_ENV_VAR} environment variable ({MIN_LOGIN_PASSWORD_LEN}+ characters), or\n  \
                 2. Create {} with a {MIN_LOGIN_PASSWORD_LEN}+ character password",
                self.paths.login_password().display()
            ),
        }
    }

    pub fn encryption_key_source(&self) -> anyhow::Result<String> {
        let key = match self
            .encryption_key_env
            .as_deref()
            .filter(|v| v.chars().count() >= MIN_ENCRYPTION_KEY_LEN)
        {
            Some(key) => Some(key.to_string()),
            None => read_secret_file(&self.paths.encryption_key(), MIN_ENCRYPTION_KEY_LEN),
        };
        match key {
            Some(key) => Ok(key),
            None => bail!(
                "Encryption key not configured. Please either:\n  \
                 1. Set {ENCRYPTION_KEY_ENV_VAR} environment variable ({MIN_ENCRYPTION_KEY_LEN}+ characters), or\n  \
                 2. Create {} with a {MIN_ENCRYPTION_KEY_LEN}+ character key\n\n\
                 Generate a key with: openssl rand -hex 32",
                self.paths.encryption_key().display()
            ),
        }
    }

    /// The presigned URL lifetimes offered in the UI. Invalid entries are
    /// dropped with a warning; duplicates are a startup error.
    pub fn presigned_url_ttl_options(&self) -> anyhow::Result<Vec<TtlOption>> {
        let raw = self.value(PRESIGNED_URL_TTLS_ENV_VAR).map(str::trim).filter(|v| !v.is_empty());
        let (options, duplicates) = parse_ttls(raw.unwrap_or(DEFAULT_PRESIGNED_URL_TTLS));
        if !duplicates.is_empty() {
            let noun = if duplicates.len() == 1 { "entry" } else { "entries" };
            let list = duplicates.into_iter().collect::<Vec<_>>().join(", ");
            bail!("{PRESIGNED_URL_TTLS_ENV_VAR} contains duplicate {noun}: {list}");
        }
        if options.is_empty() {
            if let Some(raw) = raw {
                warn!(
                    "presignedUrls: {PRESIGNED_URL_TTLS_ENV_VAR}=\"{raw}\" yielded no valid entries; \
                     falling back to defaults \"{DEFAULT_PRESIGNED_URL_TTLS}\""
                );
            }
            return Ok(parse_ttls(DEFAULT_PRESIGNED_URL_TTLS).0);
        }
        Ok(options)
    }

    /// Lowercased endpoint hosts for which search and indexing are enabled.
    pub fn search_whitelist_hosts(&self) -> HashSet<String> {
        self.value(SEARCH_WHITELIST_ENV_VAR)
            .unwrap_or_default()
            .split(',')
            .map(|entry| entry.trim().to_lowercase())
            .filter(|entry| !entry.is_empty())
            .collect()
    }
}

fn parse_config_file(text: &str, path: &Path) -> anyhow::Result<HashMap<String, String>> {
    let table: toml::Table = toml::from_str(text).with_context(|| format!("Failed to parse {}", path.display()))?;
    let mut values = HashMap::new();
    for (key, value) in table {
        if !CONFIG_FILE_KEYS.contains(&key.as_str()) {
            warn!("config.toml: ignoring unknown key \"{key}\"");
            continue;
        }
        let toml::Value::String(value) = value else {
            bail!("config.toml: key \"{key}\" must be a string");
        };
        values.insert(key, value);
    }
    Ok(values)
}

fn read_secret_file(path: &Path, minimum_length: usize) -> Option<String> {
    let value = match std::fs::read_to_string(path) {
        Ok(value) => value.trim().to_string(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            warn!("Failed to read {}: {e}", path.display());
            return None;
        }
    };
    if value.chars().count() >= minimum_length {
        return Some(value);
    }
    warn!(
        "{} exists but contains less than {minimum_length} characters",
        path.display()
    );
    None
}

fn parse_ttl_entry(entry: &str) -> Option<TtlOption> {
    let trimmed = entry.trim();
    if trimmed.is_empty() {
        return None;
    }
    let invalid = || warn!("presignedUrls: ignoring invalid TTL entry \"{trimmed}\"");
    let Some((digits, unit)) = trimmed.split_at_checked(trimmed.len() - 1) else {
        invalid();
        return None;
    };
    let (seconds_per_unit, unit_name) = match unit {
        "h" => (60 * 60, "hour"),
        "d" => (60 * 60 * 24, "day"),
        "w" => (60 * 60 * 24 * 7, "week"),
        _ => {
            invalid();
            return None;
        }
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        invalid();
        return None;
    }
    let value: Option<u64> = digits.parse().ok();
    if value == Some(0) {
        invalid();
        return None;
    }
    // An unparseable run of digits overflowed u64, so it exceeds the cap too.
    let ttl = value.and_then(|v| v.checked_mul(seconds_per_unit)).filter(|ttl| *ttl <= MAX_TTL_SECONDS);
    let (Some(value), Some(ttl)) = (value, ttl) else {
        warn!("presignedUrls: ignoring TTL \"{trimmed}\" exceeds AWS SigV4 maximum of 7 days");
        return None;
    };
    let suffix = if value == 1 { "" } else { "s" };
    Some(TtlOption {
        ttl,
        short_label: trimmed.to_string(),
        long_label: format!("{value} {unit_name}{suffix}"),
    })
}

/// Parsed options in order, and the sorted set of duplicated labels.
fn parse_ttls(source: &str) -> (Vec<TtlOption>, BTreeSet<String>) {
    let mut options: Vec<TtlOption> = Vec::new();
    let mut duplicates = BTreeSet::new();
    for option in source.split(',').filter_map(parse_ttl_entry) {
        if options.iter().any(|o| o.short_label == option.short_label) {
            duplicates.insert(option.short_label);
        } else {
            options.push(option);
        }
    }
    (options, duplicates)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_with(file: Option<&str>, env: &[(&str, &str)]) -> anyhow::Result<Config> {
        let env: HashMap<String, String> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Config::resolve(AppPaths::new("/nonexistent/.s3browser"), file, |key| env.get(key).cloned())
    }

    fn labels(options: &[TtlOption]) -> Vec<(&str, u64, &str)> {
        options
            .iter()
            .map(|o| (o.short_label.as_str(), o.ttl, o.long_label.as_str()))
            .collect()
    }

    #[test]
    fn ttl_defaults_and_parsing() {
        let config = config_with(None, &[]).unwrap();
        assert_eq!(
            labels(&config.presigned_url_ttl_options().unwrap()),
            [("1h", 3600, "1 hour"), ("1d", 86400, "1 day")]
        );

        let config = config_with(None, &[(PRESIGNED_URL_TTLS_ENV_VAR, " 6h, 2d,1w ,8d, 1d2h, 0h, x, ")]).unwrap();
        assert_eq!(
            labels(&config.presigned_url_ttl_options().unwrap()),
            [("6h", 21600, "6 hours"), ("2d", 172800, "2 days"), ("1w", 604800, "1 week")]
        );
    }

    #[test]
    fn ttl_all_invalid_falls_back_and_duplicates_fail() {
        let config = config_with(None, &[(PRESIGNED_URL_TTLS_ENV_VAR, "8d,nope")]).unwrap();
        assert_eq!(config.presigned_url_ttl_options().unwrap().len(), 2);

        let config = config_with(None, &[(PRESIGNED_URL_TTLS_ENV_VAR, "1h,1h,1d,1d,2d")]).unwrap();
        let error = config.presigned_url_ttl_options().unwrap_err().to_string();
        assert_eq!(error, "S3BROWSER_PRESIGNED_URL_TTLS contains duplicate entries: 1d, 1h");

        let config = config_with(None, &[(PRESIGNED_URL_TTLS_ENV_VAR, "99999999999999999999999h")]).unwrap();
        assert_eq!(config.presigned_url_ttl_options().unwrap().len(), 2);
    }

    #[test]
    fn env_wins_over_config_file_and_unknown_keys_are_ignored() {
        let file = r#"
            S3BROWSER_BIND = ":9000"
            S3BROWSER_SEARCH_WHITELIST_HOSTS = "From.File, other.host"
            S3BROWSER_ENCRYPTION_KEY = "never read from the config file at all"
            SOMETHING_ELSE = "x"
        "#;
        let config = config_with(Some(file), &[(BIND_ENV_VAR, ":8080")]).unwrap();
        assert_eq!(config.bind(), Some(":8080"));
        assert_eq!(
            config.search_whitelist_hosts(),
            HashSet::from(["from.file".to_string(), "other.host".to_string()])
        );
        assert!(config.encryption_key_source().is_err());
    }

    #[test]
    fn config_file_values_must_be_strings() {
        let error = config_with(Some("S3BROWSER_PRESIGNED_URL_TTLS = 1"), &[]).err().unwrap().to_string();
        assert!(error.contains("must be a string"), "{error}");
        assert!(config_with(Some("not = [valid"), &[]).is_err());
    }

    #[test]
    fn secrets_require_minimum_lengths() {
        let config = config_with(None, &[(LOGIN_PASSWORD_ENV_VAR, "short")]).unwrap();
        assert!(config.login_password().is_err());
        let config = config_with(None, &[(LOGIN_PASSWORD_ENV_VAR, "0123456789abcdef")]).unwrap();
        assert_eq!(config.login_password().unwrap(), "0123456789abcdef");

        let key = "k".repeat(32);
        let config = config_with(None, &[(ENCRYPTION_KEY_ENV_VAR, &key)]).unwrap();
        assert_eq!(config.encryption_key_source().unwrap(), key);
        let config = config_with(None, &[(ENCRYPTION_KEY_ENV_VAR, "too-short")]).unwrap();
        assert!(config.encryption_key_source().is_err());
    }

    #[test]
    fn secrets_fall_back_to_files() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(dir.path());
        std::fs::write(paths.login_password(), "file-password-0123\n").unwrap();
        std::fs::write(paths.encryption_key(), format!("{}\n", "e".repeat(40))).unwrap();
        let config = Config::resolve(paths, None, |_| None).unwrap();
        assert_eq!(config.login_password().unwrap(), "file-password-0123");
        assert_eq!(config.encryption_key_source().unwrap(), "e".repeat(40));
    }

    #[test]
    fn seed_flag_and_empty_whitelist() {
        let config = config_with(None, &[(SEED_TEST_ITEMS_ENV_VAR, "1")]).unwrap();
        assert!(config.seed_test_items);
        assert!(config.search_whitelist_hosts().is_empty());
        assert!(!config_with(None, &[(SEED_TEST_ITEMS_ENV_VAR, "yes")]).unwrap().seed_test_items);
    }
}

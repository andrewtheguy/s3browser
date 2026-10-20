use std::path::{Path, PathBuf};

use anyhow::Context;

/// Everything persistent lives in one directory, `~/.s3browser` by default.
#[derive(Clone, Debug)]
pub struct AppPaths {
    pub dir: PathBuf,
}

impl AppPaths {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn from_home() -> anyhow::Result<Self> {
        let home = dirs::home_dir().context("could not determine the home directory")?;
        Ok(Self::new(home.join(".s3browser")))
    }

    pub fn db(&self) -> PathBuf {
        self.dir.join("s3browser.db")
    }

    pub fn index_db(&self) -> PathBuf {
        self.dir.join("s3browser-index.db")
    }

    pub fn encryption_key(&self) -> PathBuf {
        self.dir.join("encryption.key")
    }

    pub fn login_password(&self) -> PathBuf {
        self.dir.join("login.password")
    }

    pub fn config(&self) -> PathBuf {
        self.dir.join("config.toml")
    }

    pub fn server_lock(&self) -> PathBuf {
        self.dir.join("s3browser.lock")
    }

    pub fn index_lock(&self) -> PathBuf {
        self.dir.join("s3browser-index.lock")
    }

    /// Create the directory owner-only (0700) if it is missing.
    pub fn ensure_dir(&self) -> anyhow::Result<()> {
        create_private_dir(&self.dir).with_context(|| format!("failed to create {}", self.dir.display()))
    }
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

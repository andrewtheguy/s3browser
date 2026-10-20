use std::fs::{File, OpenOptions, TryLockError};
use std::path::Path;

use anyhow::{Context, bail};

/// An exclusive advisory lock on a file, held until dropped. The server and
/// the indexer each take their own, so a second copy of either refuses to start.
pub struct FileLock {
    _file: File,
}

impl FileLock {
    pub fn acquire(path: &Path) -> anyhow::Result<Self> {
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(path)
            .with_context(|| format!("failed to open {}", path.display()))?;
        match file.try_lock() {
            Ok(()) => Ok(Self { _file: file }),
            Err(TryLockError::WouldBlock) => {
                bail!("Another s3browser process is already running ({})", path.display())
            }
            Err(TryLockError::Error(e)) => Err(e).with_context(|| format!("failed to lock {}", path.display())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_lock_on_the_same_file_fails_until_the_first_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");
        let first = FileLock::acquire(&path).unwrap();
        let error = FileLock::acquire(&path).err().unwrap().to_string();
        assert!(error.contains("already running"), "{error}");
        drop(first);
        FileLock::acquire(&path).unwrap();
    }
}

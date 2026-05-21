from pathlib import Path

APP_DIR = Path.home() / ".s3browser"
DB_PATH = APP_DIR / "s3browser.db"
INDEX_DB_PATH = APP_DIR / "s3browser-index.db"
ENCRYPTION_KEY_PATH = APP_DIR / "encryption.key"
LOGIN_PASSWORD_PATH = APP_DIR / "login.password"
CONFIG_PATH = APP_DIR / "config.toml"
SERVER_LOCK_FILE = APP_DIR / "s3browser.lock"
INDEX_LOCK_FILE = APP_DIR / "s3browser-index.lock"


def ensure_app_dir() -> None:
    APP_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)

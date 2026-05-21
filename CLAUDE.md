no backward compatibility of any kind because the project is private
frontend code lives in `frontend/`; the Python package lives in `s3browser/` at the repo root
use bun instead of npm for frontend commands
use javascript for frontend logic and python for backend logic uv for Python backend commands
run `cd frontend && bun run lint --reporter=rdjson` and `cd frontend && npx tsc` after frontend/javascript related changes
run uv run ruff check, uv run ruff format --check, and uv run basedpyright after Python backend changes
the package version lives only in `pyproject.toml`; `s3browser/__init__.py` reads it via `importlib.metadata` and `frontend/package.json` has no version field
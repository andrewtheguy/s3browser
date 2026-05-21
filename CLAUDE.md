use bun instead of npm for frontend commands
use uv for Python backend commands
run bun run lint and npx tsc -b tsconfig.app.json after frontend/javascript related changes
run uv run ruff check, uv run ruff format --check, and uv run basedpyright after Python backend changes
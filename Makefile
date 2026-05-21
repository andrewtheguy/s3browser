.PHONY: dev build lint typecheck check

# Run backend (uvicorn with reload) and frontend (Vite) together.
# Ctrl-C kills both.
dev:
	@trap 'kill 0' INT TERM EXIT; \
	uv run s3browser server --bind localhost:3001 --reload & \
	(cd frontend && bun run dev) & \
	wait

build:
	cd frontend && bun run build
	uv build --out-dir dist-python

lint:
	cd frontend && bun run lint

typecheck:
	cd frontend && npx tsc -b tsconfig.app.json

check:
	uv run ruff check
	uv run ruff format --check
	uv run basedpyright

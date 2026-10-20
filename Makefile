.PHONY: dev build lint typecheck check e2e

# Run the backend and the Vite dev server together. Ctrl-C kills both.
dev:
	@trap 'kill 0' INT TERM EXIT; \
	cargo run -- server --bind 127.0.0.1:8170 & \
	(cd frontend && bun run dev) & \
	wait

# Release binary with the frontend embedded (build.rs runs `bun run build`).
build:
	cargo build --release

lint:
	cd frontend && bun run lint

typecheck:
	cd frontend && bun run typecheck

check:
	cargo clippy --all-targets -- -D warnings
	cargo test

e2e:
	./scripts/e2e.sh

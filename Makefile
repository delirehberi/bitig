# Bitig monorepo tasks.
# Every target loads the Node version from .nvmrc when nvm is available
# (local machines); in CI, Node is provisioned by the workflow instead.

SHELL := /bin/bash
.SHELLFLAGS := -e -o pipefail -c
.DEFAULT_GOAL := help

NVM_SCRIPT := $(HOME)/.nvm/nvm.sh

# D1 database name from apps/worker/wrangler.jsonc (d1_databases[].database_name).
D1_DATABASE := bitig-db

NODE_ENV_SETUP := if [ -s "$(NVM_SCRIPT)" ]; then source "$(NVM_SCRIPT)" && nvm use --silent; fi;

# Local Nostr relay for test-nostr-relay. Override NAK with a full path if nak is not on PATH.
NAK ?= nak
NOSTR_RELAY_HOST := localhost
NOSTR_RELAY_PORT := 10547
NOSTR_RELAY_URL := ws://$(NOSTR_RELAY_HOST):$(NOSTR_RELAY_PORT)
# Startup wait: attempts x interval = 5 seconds.
NOSTR_RELAY_WAIT_ATTEMPTS := 50
NOSTR_RELAY_WAIT_INTERVAL := 0.1
NOSTR_RELAY_PROBE := (exec 3<>/dev/tcp/$(NOSTR_RELAY_HOST)/$(NOSTR_RELAY_PORT)) 2>/dev/null

# Local Worker credentials; the browser tests sign in with them.
WORKER_DEV_VARS := apps/worker/.dev.vars

.PHONY: help install dev migrate-local migrate-remote build test test-nostr-relay e2e lint typecheck check deploy clean

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-18s %s\n", $$1, $$2}'

install: ## Install workspace dependencies from the lockfile
	@$(NODE_ENV_SETUP) pnpm install --frozen-lockfile

dev: migrate-local ## Run the worker (wrangler dev) and web app (vite) together
	@$(NODE_ENV_SETUP) pnpm run dev

migrate-local: ## Apply pending D1 migrations to the local (miniflare) database
	@$(NODE_ENV_SETUP) pnpm --filter @bitig/worker exec wrangler d1 migrations apply $(D1_DATABASE) --local

build: ## Build every package and app
	@$(NODE_ENV_SETUP) pnpm run build

test: ## Run all test suites
	@$(NODE_ENV_SETUP) pnpm run test

# Not part of `check`/CI: needs nak. The port probe refuses to run against a relay
# this target did not start, and the trap stops the relay even when tests fail.
test-nostr-relay: ## Run the Nostr adapter against a local nak relay
	@if $(NOSTR_RELAY_PROBE); then echo "Port $(NOSTR_RELAY_PORT) is already in use; stop that process first." >&2; exit 1; fi
	@$(NODE_ENV_SETUP) \
	$(NAK) serve --hostname $(NOSTR_RELAY_HOST) --port $(NOSTR_RELAY_PORT) >/dev/null 2>&1 & relay_pid=$$!; \
	trap 'kill $$relay_pid 2>/dev/null || true' EXIT; \
	for _ in $$(seq $(NOSTR_RELAY_WAIT_ATTEMPTS)); do $(NOSTR_RELAY_PROBE) && break; sleep $(NOSTR_RELAY_WAIT_INTERVAL); done; \
	if ! $(NOSTR_RELAY_PROBE); then echo "nak relay did not start on $(NOSTR_RELAY_URL)." >&2; exit 1; fi; \
	BITIG_NOSTR_RELAY_URL=$(NOSTR_RELAY_URL) pnpm --filter @bitig/storage-nostr exec vitest run src/nostr-storage.relay.test.ts; \
	echo "Events stored on the relay, by kind (30331 project, 30332 task, 5 deletion):"; \
	$(NAK) req -k 30331 -k 30332 -k 5 $(NOSTR_RELAY_URL) 2>/dev/null | jq -s -c 'group_by(.kind) | map({kind: .[0].kind, count: length})'

# Not part of `check`/CI: drives Chromium against `make dev` (Playwright starts it,
# or reuses one already running) and writes to the local D1 database.
e2e: ## Run browser lifecycle tests against the local dev stack
	@if [ ! -f "$(WORKER_DEV_VARS)" ]; then echo "$(WORKER_DEV_VARS) is missing; it provides BASIC_AUTH_USER/BASIC_AUTH_PASS." >&2; exit 1; fi
	@$(NODE_ENV_SETUP) set -a && source "$(WORKER_DEV_VARS)" && set +a && \
	pnpm --filter @bitig/web exec playwright install chromium && \
	pnpm --filter @bitig/web exec playwright test

lint: ## Lint the whole workspace
	@$(NODE_ENV_SETUP) pnpm run lint

typecheck: ## Typecheck the whole workspace (tsc -b)
	@$(NODE_ENV_SETUP) pnpm run typecheck

check: lint typecheck test build ## Run everything CI runs

cli: ## Run local CLI (e.g. make cli ARGS="tasks list")
	@$(NODE_ENV_SETUP) node apps/cli/dist/bitig.js $(ARGS)

mcp: ## Run STDIO MCP server
	@$(NODE_ENV_SETUP) node apps/cli/dist/bitig.js mcp

migrate-remote: ## Apply pending D1 migrations to the production database
	@$(NODE_ENV_SETUP) pnpm --filter @bitig/worker exec wrangler d1 migrations apply $(D1_DATABASE) --remote

# Migrations run first so the schema is in place before new code goes live.
deploy: migrate-remote ## Apply remote migrations, build the web app and deploy the worker
	@$(NODE_ENV_SETUP) pnpm --filter @bitig/web run build && pnpm --filter @bitig/worker run deploy

clean: ## Remove build output and caches
	@rm -rf apps/*/dist packages/*/dist apps/*/.tsbuild packages/*/.tsbuild apps/*/.wrangler



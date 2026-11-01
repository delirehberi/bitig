# Bitig monorepo tasks.
# Every target loads the Node version from .nvmrc when nvm is available
# (local machines); in CI (CI is set), Node is provisioned by the workflow instead.
# nvm must be skipped there: runner images ship nvm without Node 26, so `nvm use` exits 3.

SHELL := /bin/bash
.SHELLFLAGS := -e -o pipefail -c
.DEFAULT_GOAL := help

NVM_SCRIPT := $(HOME)/.nvm/nvm.sh

# D1 database name from apps/worker/wrangler.jsonc (d1_databases[].database_name).
D1_DATABASE := bitig-db

NODE_ENV_SETUP := if [ -z "$$CI" ] && [ -s "$(NVM_SCRIPT)" ]; then source "$(NVM_SCRIPT)" && nvm use --silent; fi;

# Local Worker credentials; the browser tests sign in with them.
WORKER_DEV_VARS := apps/worker/.dev.vars

.PHONY: help install dev migrate-local migrate-remote build test e2e lint typecheck check deploy clean

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

# Not part of `check`/CI: drives Chromium against `make dev` (Playwright starts it,
# or reuses one already running) and writes to the local D1 database.
e2e: ## Run browser lifecycle tests against the local dev stack
	@if [ ! -f "$(WORKER_DEV_VARS)" ]; then echo "$(WORKER_DEV_VARS) is missing; it provides BASIC_AUTH_USER/BASIC_AUTH_PASS and SESSION_SECRET." >&2; exit 1; fi
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



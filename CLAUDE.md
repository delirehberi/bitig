# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Bitig is a task/project manager for humans and AI agents. A pnpm monorepo (`packages/*`, `apps/*`) where all business logic and UI talk to storage only through the `StorageProvider` interface (`packages/core/src/storage/provider.ts`). Three backends: local Markdown files, Cloudflare D1, and Nostr relays.

## Commands

Always go through the Makefile (it loads Node from `.nvmrc` — Node 26, pnpm 11). Do not prepend `nvm use` to `make`.

- `make install` — `pnpm install --frozen-lockfile`
- `make check` — lint + typecheck + test + build (same as CI)
- `make lint` — `eslint . --max-warnings=0` (strictTypeChecked; warnings fail)
- `make typecheck` — `tsc -b` over the root project references
- `make build` — builds all packages, then the worker last
- `make test` — `pnpm -r run test` (Vitest in every package)
- `make dev` — `wrangler dev` (worker) + `vite` (web) in parallel
- `make cli ARGS="tasks list"` / `make mcp` — run the built CLI / STDIO MCP server from `apps/cli/dist/bitig.js`
- `make deploy` — builds web, then `wrangler deploy` for the worker

Single package / single test (run outside make, so load nvm in the same command):

    source ~/.nvm/nvm.sh && nvm use && pnpm --filter @bitig/storage-markdown exec vitest run src/layout.test.ts
    source ~/.nvm/nvm.sh && nvm use && pnpm --filter @bitig/core exec vitest run -t "test name"

Build before testing the worker: its Vitest runtime (`@cloudflare/vitest-plugin`) loads `apps/web/dist` as static assets via `apps/worker/wrangler.jsonc`. CI runs build before test for this reason.

D1 schema changes: edit `packages/storage-d1/src/schema.ts`, then `pnpm --filter @bitig/storage-d1 run generate` (drizzle-kit) to add a migration in `packages/storage-d1/migrations/` (the worker's `migrations_dir` points there). After changing worker bindings, regenerate types with `pnpm --filter @bitig/worker run types`.

## Architecture

Dependency direction: `core` ← storage adapters / `api-client` / `mcp-tools` ← apps.

- `packages/core` — domain types, Zod schemas, errors (`NotFoundError`, `ValidationError`), canonical sorting (`compareProjects`, `compareTasks`), an in-memory provider, and `@bitig/core/testing`. Must stay environment-neutral: no Node APIs, DOM, or Workers globals, because it is bundled into browser, Worker, and CLI.
- Storage adapters each implement `StorageProvider`:
  - `storage-markdown` — filesystem behind `FileSystemPort`; Node implementation lives only under `src/node` (exported as `@bitig/storage-markdown/node`, typechecked by the separate `tsconfig.node.json`). Paths are identity: `<dataDir>/<projectId>/_project.yaml` and `<projectId>/<taskId>.md`; IDs are never written inside files. Uses file locking.
  - `storage-d1` — Drizzle ORM over D1; timestamps stored as integers, ISO strings in the domain.
  - `storage-nostr` — addressable events (kind 30331 projects, 30332 tasks), NIP-44 self-encryption for private tasks, NIP-09 deletion. Spec: `docs/nostr-spec.md`.
  - `api-client` — `ApiStorage`, a `StorageProvider` over the worker's REST API.
- `packages/mcp-tools` — single MCP tool registration shared by both MCP transports, plus `.bitig` workspace-link discovery.
- `apps/cli` — commander CLI + STDIO MCP server on `MarkdownStorage`; bundled by esbuild (`build.mjs`) into `dist/bitig.js`. Follows XDG dirs (data/config/runtime lock); see README for override precedence.
- `apps/worker` — Hono app built by `createApp()` in `src/index.ts`; injects `config` and `storage` per request (tests pass a `storageFactory`). Routes in `src/routes/`: REST under `/api/*` (session cookie from `/api/auth/login` or Basic Auth, CORS allowlist, CSRF, rate limiting), Streamable HTTP MCP at `/mcp` (Bearer token). Bindings validated by Zod in `src/config.ts` (`ALLOWED_ORIGINS`, `BASIC_AUTH_USER`, `BASIC_AUTH_PASS`, `SESSION_SECRET`, `MCP_AUTH_TOKEN`; local values in `.dev.vars`). Also serves the web SPA from `../web/dist`.
- `apps/web` — React 19 + Vite + Tailwind 4 dashboard using Hallmark design tokens; URL routing via a small History API router in `src/routing/` (`/`, `/projects`, `/tasks?project=`, `/login`); picks `ApiStorage` (Cloudflare mode) or `NostrStorage` (Nostr mode).

### Contract tests
Every adapter must pass `runStorageContractSuite(name, factory)` from `@bitig/core/testing` (see `*.contract.test.ts` / `*.contract.spec.ts`). The factory receives a `TestRuntime` (deterministic clock + ID generator) that the adapter must use. Adapter-specific behavior goes in `*.extra.test.ts`. A change to `StorageProvider` semantics means updating the contract suite and all adapters (memory, markdown, d1, nostr, api-client).

## TypeScript conventions
`tsconfig.base.json` enables `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, and `allowImportingTsExtensions`. Use `import type` for types (lint-enforced). Packages export `src/*.ts` directly (no build step for libraries); only `cli`, `web`, and `worker` produce bundles.

## Docs vs code
README and `docs/architecture.md` are partly stale. Trust the code: Node 26 is required (not 20), and the real MCP tools are those registered in `packages/mcp-tools/src/register.ts` (e.g. `add_task`, not `create_task`; there is no `get_project`).

Further docs: `docs/architecture.md`, `docs/security.md`, `docs/interop-and-backup.md`, `docs/nostr-spec.md`. The roadmap and open work live in Bitig itself (project linked via `.bitig`), not in Markdown files.

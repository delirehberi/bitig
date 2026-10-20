# Contributing to Bitig

Thank you for your interest in contributing to Bitig! This document outlines the setup, architecture constraints, and verification workflow for contributors.

## Prerequisites

- **Node.js** `>= 26` (see `.nvmrc`)
- **pnpm** `>= 11` (`corepack enable` or `npm install -g pnpm`)

## Getting Started

1. Clone the repository and install dependencies:
   ```bash
   git clone https://github.com/delirehberi/bitig.git
   cd bitig
   make install
   ```

2. Run the full verification suite (lint, typecheck, tests, and build):
   ```bash
   make check
   ```

3. Start the local Cloudflare Worker + React web dashboard development stack:
   ```bash
   make dev
   ```

## Architecture & Coding Standards

Before opening a pull request, please review [`docs/architecture.md`](./docs/architecture.md):

- **Strict TypeScript:** Zero `any`, `exactOptionalPropertyTypes: true`, and `noUncheckedIndexedAccess: true` are enforced across the entire workspace.
- **Runtime Isolation:** `@bitig/core` must remain 100% environment-neutral (no Node `fs`/`path`, DOM, or Cloudflare Worker globals).
- **Storage Provider Contract:** Any change to `StorageProvider` or domain entities must update and pass the shared contract suite in `@bitig/core/testing` across all adapters (`InMemoryStorage`, `MarkdownStorage`, `D1Storage`, `NostrStorage`, and `ApiStorage`).
- **Validation at Boundaries:** All inputs crossing storage, CLI, MCP, or HTTP boundaries must be validated with `@bitig/core` Zod schemas.

## Quality Gate

Every pull request must pass `make check` with zero warnings or errors:

- `make lint` — Runs ESLint across all packages and apps (`--max-warnings=0`).
- `make typecheck` — Runs `tsc -b` across the TypeScript project references.
- `make test` — Runs Vitest unit and contract test suites across all workspace packages.
- `make build` — Builds all packages and apps.

## Submitting Changes

1. Create a focused branch from `master`.
2. Add or update unit/contract tests covering your changes.
3. Run `make check` locally and verify everything passes.
4. Open a pull request with a clear description of the problem and solution.


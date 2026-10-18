# Bitig Architecture & Design System

## 1. Monorepo Structure

Bitig is organized as a pnpm monorepo with strict TypeScript typing, environment-neutral core packages, and specialized runtime applications.

```
bitig/
  packages/
    core/              Domain entities, Zod schemas, StorageProvider contract, in-memory double
    storage-markdown/  MarkdownStorage (FileSystemPort, FileLock, YAML frontmatter codec)
    storage-d1/        D1Storage (Drizzle ORM schema, SQL migrations, D1 driver)
    storage-nostr/     NostrStorage (Nostr-tools, NIP-44 crypto, RelayManager, tombstone resolver)
    mcp-tools/         MCP tool definitions and schema registrations
    api-client/        ApiStorage (HTTP REST StorageProvider client)
  apps/
    worker/            Cloudflare Worker (Hono REST API, HTTP MCP, D1 binding, static asset hosting)
    web/               React + Vite dashboard with Hallmark design tokens
    cli/               Local CLI commands and STDIO MCP server
```

---

## 2. Dependency Hierarchy & Runtime Isolation

The architecture enforces strict runtime boundaries:

1. **`packages/core`** is environment-neutral:
   - Does not import Node APIs (`fs`, `path`, `os`, `child_process`).
   - Does not import DOM or browser-specific globals.
   - Does not import Cloudflare Workers runtime globals.
   - Bundles safely into browser apps, edge Workers, and CLI executables.

2. **Storage Adapters** depend only on `@bitig/core`:
   - `storage-markdown` abstracts the filesystem behind `FileSystemPort`.
   - `storage-d1` interacts with D1 via Drizzle ORM.
   - `storage-nostr` manages relay pools and cryptographic signers.

3. **Applications** consume storage through the `StorageProvider` interface:
   - `apps/cli` instantiates `MarkdownStorage`.
   - `apps/worker` instantiates `D1Storage`.
   - `apps/web` instantiates `ApiStorage` (Cloudflare mode) or `NostrStorage` (Nostr mode).

---

## 3. StorageProvider Contract Design

All storage backends implement a unified interface:

```typescript
export interface StorageProvider {
  // Projects
  getProjects(opts?: OperationOptions): Promise<Project[]>;
  getProject(id: string, opts?: OperationOptions): Promise<Project | null>;
  createProject(input: CreateProjectInput, opts?: OperationOptions): Promise<Project>;
  updateProject(id: string, patch: UpdateProjectInput, opts?: OperationOptions): Promise<Project>;
  deleteProject(id: string, opts?: OperationOptions): Promise<void>;

  // Tasks
  getTasks(filter?: TaskFilter, opts?: OperationOptions): Promise<Task[]>;
  getTask(id: string, opts?: OperationOptions): Promise<Task | null>;
  saveTask(input: CreateTaskInput, opts?: OperationOptions): Promise<Task>;
  updateTask(id: string, patch: UpdateTaskInput, opts?: OperationOptions): Promise<Task>;
  deleteTask(id: string, opts?: OperationOptions): Promise<void>;
  completeTask(id: string, opts?: OperationOptions): Promise<Task>;

  // Interoperability & Bundles
  exportProject(id: string, opts?: OperationOptions): Promise<ProjectBundle>;
  importProject(bundle: ProjectBundle, opts?: OperationOptions): Promise<Project>;
  exportAll(opts?: OperationOptions): Promise<BackupBundle>;
  importBackup(backup: BackupBundle, opts?: OperationOptions): Promise<void>;
}
```

Every adapter is verified against `@bitig/core/testing` contract test suite, ensuring:
- Standardized `NotFoundError` and `ValidationError` semantics.
- Identical canonical sorting (`compareProjects` and `compareTasks`).
- Strict signal cancellation (`AbortSignalLike`) support.
- Immutability of returned copies.

---

## 4. MCP (Model Context Protocol) Architecture

Bitig exposes unified MCP tools across two distribution channels:

1. **Local STDIO Server (`apps/cli`):**
   - Activated via `bitig mcp` or `make mcp`.
   - Communicates over standard input/output with MCP desktop clients (e.g. Claude Desktop, Cursor).
   - Backed directly by `MarkdownStorage`.

2. **Remote Streamable HTTP Server (`apps/worker`):**
   - Mounted at `/mcp`.
   - Protected by Bearer token authentication and edge rate limiting.
   - Backed by Cloudflare D1 storage.

### Unified Tool Suite:
- `list_projects`: Lists all projects.
- `create_project`: Creates a new project.
- `list_tasks`: Lists tasks filtered optionally by `projectId`.
- `add_task`: Adds a task to a project.
- `complete_task`: Marks a task as completed.
- `update_task`: Updates task attributes.
- `delete_task`: Deletes a task.

---

## 5. Product Scope

Bitig (Turkic for "record/document") is a flexible, edge-ready task and project manager. Every task belongs to a project. Core logic and UI are separated from storage by the `StorageProvider` interface.

### Storage modes
1. **Local (Markdown as DB):** offline, no network. Projects are directories; tasks are `.md` files (YAML frontmatter + body). Node `fs` for CLI/desktop; File System Access API in the browser (Chromium only).
2. **Cloudflare (Hono + D1):** relational storage via Drizzle ORM, web dashboard, HTTP Basic Auth.
3. **Nostr (decentralized):** browser-only SPA using `nostr-tools` with NIP-07 login. The Worker is not involved in this mode.

MCP is available in every mode: STDIO (local CLI) and Streamable HTTP (Cloudflare). The web UI picks its provider at runtime from the deployment's `STORAGE_MODE` Worker var, which `GET /health` reports: `ApiStorage` (Cloudflare), `NostrStorage` (Nostr), or a local adapter (local web; currently an in-memory placeholder until the FS Access API adapter lands). Users cannot switch modes in the UI, and mode-specific controls are gated by feature flags derived from the mode (`apps/web/src/domain/features.ts`).

### Non-goals (initial release)
- Real-time multi-user collaboration, OAuth for MCP, mobile apps, a Worker-side Nostr relay proxy.

---

## 6. Domain Model

- `Project`: `id`, `name`, `description`, `kind`, `createdAt`, `updatedAt`.
  - `kind`: `paid | hobby | open_source | personal | internal`; defaults to `hobby`, cannot be cleared.
- `Task`: `id`, `projectId`, `title`, `description`, `status`, `createdAt`, `updatedAt`, `isPublic`, plus optional `dueDate`, `priority`, `labels`, `order`.
- `status`: `todo | in_progress | done | archived`.
- `priority`: `trivial | low | medium | high | urgent` (lowest to highest).
- `dueDate`: calendar date `YYYY-MM-DD` (no time or timezone).
- Timestamps: ISO 8601 UTC strings in the domain; stored as integers in D1.
- **ID strategy:** domain IDs are opaque strings (UUIDv7 or user-defined slug identifiers).
  - Markdown: directory name is `<projectId>`, task filename is `<taskId>.md`. IDs and project IDs are derived from the filesystem path and omitted from file frontmatter/body.
  - D1: ID is the primary key.
  - Nostr: ID is the `d` tag.
- `isPublic` is meaningful only in Nostr mode (public vs encrypted). In other modes it is stored but has no effect and defaults to `false`.
- `deleteProject` cascades to tasks (D1: FK `ON DELETE CASCADE`; Markdown: remove directory; Nostr: NIP-09 deletion of project and task events).

---

## 7. Security Checklist

- Basic Auth: secrets via `wrangler secret`, constant-time comparison, rate limiting, HTTPS only.
- Dashboard NIP-07 against the Worker (if ever enabled) requires server-verified signing (NIP-98 or signed challenge), a session cookie and a pubkey allowlist. NIP-07 alone is not authentication.
- MCP: Bearer token only; no credentials in logs.
- Private Nostr tasks: encrypted content; note that tags are visible to relays.
- Input validation with zod at every boundary; path traversal protection in `MarkdownStorage`.

See `docs/security.md` for details.

---

## 8. Risks

- File System Access API is Chromium-only; Firefox/Safari need CLI or download/upload fallback.
- Nostr relays may drop or reorder events; conflict resolution is last-write-wins and can lose edits.

---

## 9. Roadmap

The roadmap (phases P0–P7) and all follow-up work are tracked as tasks in Bitig itself, labeled `roadmap` and by phase (`P0`…`P7`), not in Markdown files.


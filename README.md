# Bitig

Bitig (Old Turkic for *record* or *document*) is a flexible, edge-ready task and project manager designed for humans and AI agents. It uses local-first Markdown storage for the CLI and Cloudflare D1 for the deployed dashboard.

## Features

- **Local Markdown Storage:** Plaintext `.md` files and YAML metadata on disk. Path-as-identity (`<projectId>/<taskId>.md`), no database required.
- **Unix & XDG Base Directory Standard:** Clean separation of user data, configuration, and runtime locks following Unix best practices.
- **Model Context Protocol (MCP):** First-class STDIO MCP server (`bitig mcp`) and remote HTTP MCP endpoint exposing 24 annotated tools for AI agents.
- **Workspace Linking:** Automatic project binding via `.bitig` in workspace root directories.
- **Ticket Codes:** Every task gets a short code like `BIT-12` (project key + number) that works wherever a task ID does.
- **Strict & Type-Safe:** 100% strict TypeScript, comprehensive contract test suites, zero `any`.

---

## Architecture & Packages

```
bitig/
  packages/
    core/              Domain types, Zod schemas, StorageProvider, contract tests
    storage-markdown/  MarkdownStorage engine (fs abstraction, YAML frontmatter, locking)
    mcp-tools/         MCP tool definitions, schema annotations, .bitig discovery
    storage-d1/        D1 / Drizzle ORM storage adapter
    api-client/        StorageProvider implementation over Hono REST API
  apps/
    cli/               Local CLI (`bitig`) and STDIO MCP server (`bitig mcp`)
    worker/            Cloudflare Workers API + remote HTTP MCP
    web/               React dashboard (Hallmark design system)
```

---

## Directory & File Layout

Bitig follows the **XDG Base Directory Specification**:

| Target | Path | Override Priority |
| :--- | :--- | :--- |
| **Data Directory** | `~/.local/share/bitig/` (`$XDG_DATA_HOME/bitig`) | `--data-dir` > `$BITIG_DATA_DIR` > `config.yaml` > XDG default |
| **Config File** | `~/.config/bitig/config.yaml` (`$XDG_CONFIG_HOME/bitig/config.yaml`) | `--config` > `$BITIG_CONFIG` > XDG default |
| **Runtime Lock** | `/run/user/<uid>/bitig/` (`$XDG_RUNTIME_DIR/bitig/`) | Falls back to `<dataDir>/.bitig.lock` |

### Storage Structure

```
~/.local/share/bitig/
  ├── bitig/
  │   ├── _project.yaml
  │   ├── 019253ec-5a1e-7230-a89e-0123456789ab.md
  │   └── setup-mcp.md
  └── personal/
      ├── _project.yaml
      └── renew-domain.md
```

- Each directory name is the `projectId`.
- `_project.yaml` contains project metadata (`name`, `description`, `kind`, `createdAt`, `updatedAt`).
- `<taskId>.md` contains YAML frontmatter (`title`, `status`, `priority`, `dueDate`, `labels`, `createdAt`, `updatedAt`) and Markdown body description.
- `<taskId>.comments/<commentId>.md` holds one comment each: frontmatter (`authorType`, `author`, `createdAt`) and the comment as the Markdown body.
- `<taskId>.attachments/<attachmentId>.meta.yaml` and `<attachmentId>.bin` store attachment metadata (`name`, `mimeType`, `size`, `createdAt`, `createdBy`) and raw bytes (in Cloudflare mode, metadata lives in D1 `attachments` and blobs in R2 `ATTACHMENTS`).
- Redundant IDs are not stored inside file contents; paths are identity.

---

## Installation & Setup

### Prerequisites

- Node.js >= 26
- pnpm >= 11

### Build from Source

```bash
git clone https://github.com/delirehberi/bitig.git
cd bitig
pnpm install
make build
```

Link the CLI globally or add `apps/cli/dist` to your `PATH`:

```bash
cd apps/cli && pnpm link --global
```

---

## CLI Usage

### Inspect Resolved Paths

```bash
bitig paths
```

### Initialize a Project Link in a Workspace

Creates a `.bitig` file in the current workspace or specified directory:

```bash
bitig init . --project-id my-project
```

### Project Management

```bash
# List projects (TSV table or JSON)
bitig projects list
bitig projects list --json

# Create a project
bitig projects create "Bitig Development" --id bitig --kind open_source --description "Task manager for edge and local"

# Show project details and links
bitig projects show bitig

# Link outside resources (repository, issue_tracker, design, documentation, other); positions are 1-based
bitig projects link add bitig https://github.com/acme/bitig --type repository --label GitHub
bitig projects link edit bitig 1 --label "GitHub (main)"
bitig projects link remove bitig 1

# Update a project
bitig projects update bitig --name "Bitig (Core)" --kind hobby

# Delete a project (cascades to all project tasks)
bitig projects delete bitig
```

### Task Management

```bash
# List tasks (auto-detects project from .bitig if in a linked workspace)
bitig tasks list
bitig tasks list --project bitig --status todo

# Create a task (reads description from --description, stdin -, or $EDITOR)
bitig tasks create "Implement MCP Server" --project bitig --priority urgent --due 2026-10-15

# Get task details
bitig tasks get 019253ec-5a1e-7230-a89e-0123456789ab

# Update task status, priority, or labels
bitig tasks update 019253ec-5a1e-7230-a89e-0123456789ab --status in_progress --labels "mcp,cli"

# Subtasks (checklist); positions are 1-based, progress shows as (2/5) in lists
bitig tasks item add 019253ec-5a1e-7230-a89e-0123456789ab "Write release notes"
bitig tasks item check 019253ec-5a1e-7230-a89e-0123456789ab 1
bitig tasks item move 019253ec-5a1e-7230-a89e-0123456789ab 3 1

# Needs a human: flag what the task waits on a person for, list those tasks, clear once answered
bitig tasks update BIT-12 --needs-human "Approve the schema change"
bitig tasks list --needs-human
bitig tasks update BIT-12 --clear-needs-human

# Approval: tasks agents add over MCP, and tasks webhooks create, wait for you to approve them
bitig tasks list --awaiting-approval
bitig tasks approve BIT-12

# Dependencies: a task waiting on unfinished tasks cannot be started or completed until they are done or archived.
# You can override it; the override is recorded in the task's activity. Agents (MCP) cannot.
bitig tasks add "Signup" --depends-on BIT-12,BIT-13   # by code or ID; update replaces the list
bitig tasks update BIT-14 --clear-depends-on
bitig tasks done BIT-14 --override-blocked

# Comments: context agents keep on a task, and answers people give (oldest first, Markdown)
bitig tasks comment add BIT-12 "Use the staging key"     # no text opens $EDITOR, '-' reads stdin
bitig tasks comment add BIT-12 - --agent --author claude < notes.md
bitig tasks comment list BIT-12
bitig tasks comment delete 019253ec-7b2f-7a10-9c3d-0123456789ab

# Mark task as completed
bitig tasks complete 019253ec-5a1e-7230-a89e-0123456789ab

# Delete a task
bitig tasks delete 019253ec-5a1e-7230-a89e-0123456789ab
```

### Ticket Codes

Each project has a key (`BIT`, derived from the first letters of its name unless you pass `--key`), and each task gets the next number in its project. Together they form the task's code, `BIT-12`, which the CLI and MCP tools accept anywhere a task ID goes; a project key works wherever a project ID goes.

```bash
bitig projects create "Bitig" --key BIT
bitig tasks add "Write release notes" --project BIT   # Created task BIT-1
bitig tasks done bit-1

# Projects and tasks created before ticket codes: give them a key and number (oldest first). Safe to rerun.
bitig tasks backfill-codes
```

Numbers are never reused while their task exists. Deleting the newest task frees its number for the next one. Moving a task to another project gives it the next number there. Changing a project's key renames every code in it.

### Export, Import, Backup & Restore

Bitig enables data portability between Markdown and D1:

```bash
# Export a project and all its tasks to a JSON bundle
bitig export <projectId>
bitig export <projectId> --file my-project-backup.json

# Import a project bundle into active storage
bitig import my-project-backup.json

# Create full system backup of all projects and tasks
bitig backup
bitig backup --file bitig-full-backup.json

# Restore full system backup
bitig restore bitig-full-backup.json
```

---

## MCP Server Configuration

Bitig includes a built-in STDIO MCP server for AI coding assistants (Claude Desktop, Cursor, Antigravity, Gemini CLI, Cline, etc.).

### Configuration Example

Add the server to your assistant's MCP configuration (`mcpServers`):

```json
{
  "mcpServers": {
    "bitig": {
      "command": "bitig",
      "args": ["mcp"]
    }
  }
}
```

Or run against an explicit data directory:

```json
{
  "mcpServers": {
    "bitig": {
      "command": "bitig",
      "args": ["mcp", "--data-dir", "/path/to/custom/tasks"]
    }
  }
}
```

### MCP Tools Provided

1. `list_projects` - List all projects.
2. `create_project` - Create a project (optionally with a `key` for ticket codes).
3. `update_project` - Update a project's name, description, kind, links or key.
4. `delete_project` - Delete a project and its tasks.
5. `list_tasks` - List tasks with their codes, optionally for one project (ID or key) only those that need a human (`needsHuman: true`), only those awaiting approval (`pendingApproval: true`), or only blocked ones (`blocked: true`). A task waiting on unfinished dependencies carries their codes in `blockedBy`.
6. `get_task` - Retrieve a task by ID or code (`BIT-12`), with its comments, attachments, the tasks it mentions (`#BIT-12` in its text or comments) and the tasks that mention it (`mentions`, `mentionedIn`), and the tasks it depends on and that depend on it (`dependsOn`, `dependents`), each as `{ id, code, title, status }`. REST: `GET /api/tasks/:id/links` gives the mention links.
7. `add_task` - Add a task to a project (ID or key), optionally with `dependsOn` (task IDs or codes). The task awaits a person's approval (`pendingApproval: true`): agents cannot move it to `in_progress` or `done`, or approve it, until a person approves it in the web dashboard, with `bitig tasks approve`, or via REST `PATCH /api/tasks/:id` with `{ "pendingApproval": null }`.
8. `update_task` - Update a task's fields, or move it to another project. `dependsOn` (IDs or codes) replaces the dependency list; `null` or `[]` clears it. Agents set `needsHuman` to what they need from a person (a decision, an approval, access); `null` clears it. Moving a task to `in_progress` or `done` is refused while it awaits approval or a task it depends on is unfinished.
9. `complete_task` - Mark a task done (refused while the task awaits approval or a task it depends on is unfinished). People can override the dependency block from the web dashboard, the CLI (`--override-blocked`) or REST (`?overrideBlocked=true` on `PATCH /api/tasks/:id` and `POST /api/tasks/:id/complete`); agents cannot.
10. `delete_task` - Delete a task.
11. `backfill_ticket_codes` - Key older projects and number their tasks.
12. `list_comments` - List a task's comments, oldest first.
13. `add_comment` - Comment on a task (marked as written by an agent unless `authorType` says `human`).
14. `delete_comment` - Delete a comment.
15. `save_checkpoint` - Save or overwrite a structured execution checkpoint (`stepIndex`, `status`, `stateSnapshot`) for a task.
16. `resume_from_checkpoint` - Retrieve the latest checkpoint (and full checkpoint list) for a task.
17. `list_attachments` - List a task's file attachments (metadata only, oldest first).
18. `get_attachment` - Retrieve an attachment by ID (`content` as UTF-8 text for Markdown/text files, `data` as Base64 + `downloadUrl` for images and binary files).
19. `add_attachment` - Attach a file (`content` text or `data` Base64) to a task.
20. `delete_attachment` - Delete a task attachment by ID.
21. `list_webhooks` - List incoming webhooks configured for projects.
22. `create_webhook` - Create an incoming webhook endpoint (`generic`, `sentry`, `github`, or `linear`) for a project.
23. `update_webhook` - Update a webhook's name, provider, enabled state, field mapping, defaults, or rotate its secret token.
24. `delete_webhook` - Delete an incoming webhook.

### Bundled Agent Skill (`bitig-planning`)

Bitig ships with an agent skill at [`skills/bitig-planning/SKILL.md`](./skills/bitig-planning/SKILL.md) that teaches AI coding assistants to record plans, roadmaps, and code-review findings directly in Bitig via MCP instead of scattering `TODO.md` or `ROADMAP.md` files across repositories.

Symlink it into your agent's skills directory:

```bash
# Claude Code
mkdir -p ~/.claude/skills
ln -s "$(pwd)/skills/bitig-planning" ~/.claude/skills/bitig-planning

# Shared agents directory (~/.agents/skills)
mkdir -p ~/.agents/skills
ln -s "$(pwd)/skills/bitig-planning" ~/.agents/skills/bitig-planning
```

### Workspace Auto-Linking for Agents

When working inside a codebase with an AI assistant:
1. The assistant checks for a `.bitig` file at the repository root.
2. If absent, the assistant prompts to create one or links to an existing project ID.
3. Once linked, tasks default to the workspace project without needing to pass `projectId` repeatedly.

---

## Configuration File (`config.yaml`)

You can configure default settings in `~/.config/bitig/config.yaml`:

```yaml
# Override the data storage directory
data_dir: ~/.local/share/bitig

# Default project ID when not inside a linked workspace
default_project: bitig
```

---

## Development & Testing

```bash
# Run linting, typechecking, and tests
make check

# Individual commands
make test       # Runs vitest across all packages
make test TEST_FILTER=@bitig/worker # Runs one package without unrelated suites
make test TEST_FILTER=@bitig/web TEST_ARGS=src/components/settings # Focused tests
make typecheck  # Runs tsc --noEmit
make lint       # Runs oxlint / eslint
make build      # Builds all packages and bundles apps/cli
```

---

## Multi-User & Authentication (Cloudflare Mode)

In Cloudflare (`D1`) mode, Bitig supports multi-user accounts and multi-organisation tenancy:

- **Organisations & Roles:** Every project, task, comment, checkpoint, attachment, and webhook belongs to an organisation. Each member has an `owner`, `editor`, or `viewer` role, and project keys (`BIT`) are unique per organisation.
- **Open Registration & One-Time Email Codes:** Visitors can sign up at `/register` and sign in at `/login` using 6-digit verification codes sent via **Cloudflare Email Sending** (`send_email` binding `EMAIL` in `apps/worker/wrangler.jsonc` and `EMAIL_FROM`). Newly registered users without an organisation are guided through onboarding to create their first organisation before entering the workspace.
- **Bootstrap Admin & Default Organisation:** Set `BOOTSTRAP_ADMIN_EMAIL` and `SESSION_SECRET` on the Worker. On startup, the Worker ensures the bootstrap admin user and a `default` organisation exist and migrates any pre-multi-user projects into that organisation.
- **Server-Side Sessions & Per-User Access Tokens:** Browser sessions are stored in D1 (`sessions`) and presented via `__Host-bitig_session`. Users can issue per-user personal access tokens (`btg_...`) scoped to an organisation in **Settings → Sessions & API Tokens** (`/settings/security`) and pass `X-Bitig-Org: <slug>` when calling `/api/*` or `/mcp`.
- **Nostr Identity:** Anyone with a NIP-07 extension can register and sign in on `/login` as an ordinary user. Keys in `NOSTR_AUTH_PUBKEYS` become platform admins and owners of the default organisation. On sign-in the Worker fills empty profile fields (display name, avatar, verified NIP-05) from the key's Nostr profile. Users can repeat this with **Fetch my profile from Nostr** on the Edit Profile page. Set `NOSTR_PROFILE_RELAYS` (comma-separated `wss://` URLs) to choose which relays are queried. Nostr relay storage is retired; see [the migration guide](./docs/interop-and-backup.md#retiring-nostr-storage) before upgrading an older deployment.

---

## License

MIT

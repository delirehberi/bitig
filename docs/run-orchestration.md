# Run orchestration: task levels, AI router, parallel umbrella children, and work queues

Bitig orchestrates coding sessions on connected T3 Code hosts across three dimensions (#BIT-183, #BIT-197):

1. **Model and reasoning effort per task** — organisation-defined task levels mapped to T3 models and options, per-task run profiles (`manual`, `agent`, or `router`), and an optional per-organisation AI router that suggests a level, effort, and touched paths when a task is approved or planned.
2. **Parallel child tasks under an umbrella session** — server-enforced path-overlap and serial-path checks, a configurable per-project parallel cap, child worktrees branched from the umbrella's integration worktree, a single consolidated batch resume, and tracked branch merges (`report_child_merge`).
3. **Cross-project work queues from a dashboard prompt (#BIT-197)** — deterministic and AI-router prompt parsing, plan previews with wave estimates and inline task approvals, automatic per-lane queue umbrellas (`parentId`) for multi-task project lanes, and a background dispatcher governed by a per-host parallel run cap (`maxParallelRuns`).

For connecting T3 hosts and registering project folders, see [`t3-hosts.md`](t3-hosts.md). For authentication, encryption, and RBAC details, see [`security.md`](security.md#6b-t3-code-access-from-bitig-oauth-mcp-client).

---

## 1. Task levels and how a model is resolved

### Task levels (`org_run_levels`)

Each organisation maintains its own ordered list of task levels (from lowest/fastest to highest/deepest reasoning). Every level has:

- `key` — lowercase slug identifier (e.g. `cheap`, `standard`, `strong`, or custom keys like `fast`, `balanced`, `deep`).
- `label` — human-facing display name.
- `description` — "when to use" guidance shown to people in the UI, to planning agents via `list_run_levels`, and to the AI router in its rubric.
- `order` — zero-based rank used to order levels and determine the next level up (`nextLevelUp`).
- `selection` — the mapped T3 model selection (`providerInstanceId`, `model`, and optional `options` such as `effort` or `reasoningEffort`), with an organisation-wide default binding (`hostId: null`) and optional per-host overrides (`hostId: "<host-id>"`).

New organisations are seeded with three default levels: `cheap`, `standard`, and `strong`.

### Task run profiles (`task_run_profiles`)

Each task can carry a run profile stored in D1 (`task_run_profiles`):

- `level` — level key from the organisation's level list.
- `effort` — optional effort override (e.g. `low`, `medium`, `high`, `max`) applied to the mapped model's effort option (`effort`, `reasoningEffort`, or `thinkingEffort`) when supported by that model on the target host.
- `selection` — optional explicit `{ providerInstanceId, model, options }` override on the task profile.
- `touches` — relative repository path globs the task modifies (e.g. `["packages/core/src/**"]`).
- `parallelSafe` — whether the task may run concurrently alongside sibling tasks with non-overlapping `touches`.
- `source` — who set the profile: `"manual"`, `"agent"`, or `"router"`.
- `reason` — brief explanation for the chosen level and touched paths.
- `confidence` — router confidence (`0..1`) when set by the AI router.

### Resolution order on every launch

Whenever Bitig launches a T3 session — from the **Start in T3** dialog (`POST /api/tasks/:id/t3-run`), the `/t3 run` comment command, MCP `start_t3_thread`, an umbrella child batch (`start_ready_children` or `POST /api/tasks/:id/children/start-ready`), or when replaying a queued offline launch — it resolves the model selection in strict order:

| Priority | Rule | `modelSource` | Behaviour |
| --- | --- | --- | --- |
| 1a | Explicit model in launch call or Start dialog (`providerInstanceId` + `model` + `options`) | `explicit_model` | Uses the caller's exact model selection for this run. |
| 1b | Explicit `level` in launch call or Start dialog | `explicit_level` | Resolves the level's mapped model on the target host (or org default binding). |
| 2a | Task run profile's explicit model (`profile.selection`) | `profile_model` | Uses the explicit model saved on the task's run profile. |
| 2b | Task run profile's level (`profile.level` + optional `profile.effort`) | `profile_level` | Resolves the profile's level on the target host and applies `profile.effort` when supported. |
| 3 | Project default level (`project_run_settings.default_run_level`) | `project_default_level` | Uses the project's default level when the task has no profile (or its profile failed to resolve). |
| 4 | Nothing configured | `default` | Sends no `modelSelection`; T3 Code uses its own host default. |

**Fall-through and `skippedReason`:** If a referenced level key no longer exists, or if that level has no model mapped for the target host (neither a host-specific binding nor an organisation-wide default binding), Bitig records a human-readable `skippedReason` (for example, `Level "low" (profile_level) has no model mapped`) and falls through to the next rule in the table.

The resolved `providerInstanceId`, `model`, `modelOptions`, `modelSource`, `levelKey`, and `skippedReason` are stored on `agent_runs` (and `t3_run_requests` while offline) and returned by `GET /api/tasks/:id/run-profile`, `GET /api/tasks/:id/t3-run`, and MCP `get_task`.

---

## 2. Configuring levels and their model map

Organisation owners configure task levels and their model mappings in **Settings → Organisation → Task Levels** (or via `GET` / `PUT /api/orgs/:id/run-levels`). Organisation `editor`s and `viewer`s can read levels (`GET /api/orgs/:id/run-levels` and MCP `list_run_levels`), while mutations require the `owner` role (`403` for non-owners).

1. **Add, rename, describe, and reorder levels:**
   - Each level requires a unique `key` (`[a-z0-9][a-z0-9_-]{0,31}`), a `label`, and a `description` explaining which tasks belong on that level.
   - An organisation must keep at least one level.
2. **Map each level to a T3 model and options:**
   - Bitig reads available providers, models, and supported option values (such as `effort` or `reasoningEffort`) from the connected host's `orchestrator_capabilities` (`GET /api/t3/capabilities`).
   - Owners can set an organisation-wide default model binding (`hostId: null`) for each level and optionally override the binding on specific hosts (`hostId: "<host-id>"`).
   - On save (`PUT /api/orgs/:id/run-levels`), the Worker validates every mapped `(providerInstanceId, model, options)` tuple against the cached or live `orchestrator_capabilities` of the target host and rejects unsupported models or option values with `400`.
3. **Removing a level that is in use:**
   - If tasks (`task_run_profiles.level`) or projects (`project_run_settings.default_run_level`) still reference a level key being removed, `PUT /api/orgs/:id/run-levels` requires `replacementKeys: { "<removedKey>": "<survivingKey>" }` (or `defaultReplacementKey`).
   - Bitig atomically migrates all affected task profiles and project default levels to the replacement key in the same transaction. Omitting a replacement for an in-use level is rejected with `400`.

---

## 3. Setting up the AI router (endpoint, model, token)

The AI router (`RunProfileRouter`) suggests a task's `level`, `effort`, `touches`, `parallelSafe` flag, `reason`, and `confidence` by calling an HTTP endpoint configured per organisation. Nothing account-specific or model-specific is hard-coded in Bitig; the router is disabled until an organisation owner configures it.

### Configuring the router in Settings

In **Settings → Organisation → AI Router** (or via `GET` / `PUT` / `DELETE /api/orgs/:id/ai-router`, owner-only):

1. **Endpoint URL (`baseUrl`):**
   - Must be an `https://` URL without embedded credentials or query strings.
   - Validated against SSRF: `localhost`, loopback (`127.0.0.0/8`, `::1`), RFC 1918 private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16`, `fe80::/10`), unique-local (`fc00::/7`), single-label hostnames, and `.local` / `.internal` domains are rejected with `400`.
2. **API style (`apiStyle`):**
   - `"cloudflare-run"` (default) — posts chat `messages` with a JSON-schema `response_format` to `<baseUrl>/<model>` (for example, `https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/run` with a chat model such as `@cf/meta/llama-3.1-8b-instruct`). Do not use it for Clef: Clef is not a chat model and answers HTTP 400 (`required properties at '/' are 'model,state,questions'`).
   - `"cloudflare-clef"` — for Clef decision models (`@cf/cloudflare/clef` or `@cf/cloudflare/clef-flash`). Posts `{ model, state, questions }` to the same `<baseUrl>/<model>` URL. The level (and the effort, when the levels offer two or more) are `choice` questions over the task state, and the answer's own `confidence` is the suggestion confidence. Clef cannot write free text, so the suggestion has `touches: []`, `parallelSafe: false` and a `reason` generated from the answer probabilities, so the router never enables parallel runs. A model other than `clef` or `clef-flash` is rejected, and at least two run levels are required.
   - `"openai"` — posts to `<baseUrl>/chat/completions` with `{ model, messages, response_format }` (for example, a Cloudflare AI Gateway `/compat` endpoint or any OpenAI-compatible provider). Switching between direct Workers AI and an AI Gateway requires changing settings only.
3. **Model ID (`model`):**
   - The model identifier passed to the endpoint (for example, `@cf/cloudflare/clef` with the `cloudflare-clef` style).
4. **API token (`apiToken`):**
   - Encrypted at rest in D1 (`org_ai_router_settings.encrypted_api_token` + `token_iv`) using Web Crypto `AES-256-GCM` keyed by `T3_ENCRYPTION_KEY`.
   - Write-only in the UI and REST API: `GET` and `PUT` responses never return the plaintext or ciphertext token, exposing only `hasToken`, `tokenStatus` (`"set"` or `"not set"`), and `tokenLast4`.
   - Pass `clearToken: true` or `apiToken: null` on `PUT /api/orgs/:id/ai-router` to clear the stored token, or `DELETE /api/orgs/:id/ai-router` to remove router settings entirely.
5. **Enabled switch (`enabled`) and Test connection (`POST /api/orgs/:id/ai-router/test`):**
   - **Test connection** sends a minimal probe using the organisation's current level rubric and the stored (or form-supplied) token, returning `{ ok, status, latencyMs, suggestion?, error? }`. Any upstream error string is scrubbed so the bearer token is never echoed back.

### What the router reads and returns

- **Inputs sent to the endpoint:** The task's `title`, `description`, `checklist` item texts, `labels`, the project's configured `serialPaths`, and a compact top-level repository directory map, together with a dynamically generated rubric listing the organisation's ordered levels (`key`, `label`, `description`) and supported effort values per level.
- **Never sent:** Task comments, attachments, secrets, or T3 model names. The router chooses a **task level** and optional **effort**, never a model name.
- **Output validation:** The router requests structured JSON output (`{ level, effort?, touches, parallelSafe, reason, confidence }`). If the HTTP call fails, times out, returns malformed JSON, picks an unknown `level` or an `effort` unsupported by that level, or reports `confidence < 0.5`, Bitig stores nothing and the task falls back to the project's default level.
- **When the router runs:**
  - **Automatically on approval:** When a task awaiting approval (`pendingApproval: true`) is approved (`PATCH /api/tasks/:id` with `{ pendingApproval: null }`) and has no existing run profile, Bitig triggers the router in the background (`onlyWhenUnprofiled: true`). Approval never fails if the router is unreachable.
  - **On demand:** Click **Suggest** on a task (`POST /api/tasks/:id/run-profile/suggest`) or call MCP `suggest_run_profile({ taskId })`.

---

## 4. How to override the router

Run profile sources follow a strict precedence hierarchy:

```
manual (person)  >  agent (planning / umbrella agent)  >  router (AI router)
```

1. **Person sets a profile (`source: "manual"`):**
   - In the task detail modal's **Run Profile** section (or via `PUT /api/tasks/:id/run-profile`), a person can pick a `level`, `effort`, explicit model `selection`, `touches`, `parallelSafe`, and `reason`.
   - A `manual` profile **always wins** and is locked: neither an agent (`add_task` / `update_task` with `runProfile`) nor the AI router (on approval or on-demand `suggest_run_profile` / `POST /api/tasks/:id/run-profile/suggest`) can overwrite a `manual` profile.
   - Clicking **Reset** (`DELETE /api/tasks/:id/run-profile`) removes the manual profile so agent or router profiles can be applied again.
2. **Agent sets a profile (`source: "agent"`):**
   - When an agent breaks work into tasks with MCP `add_task` or `update_task`, passing `runProfile: { level, effort?, touches, parallelSafe?, reason? }` stores the profile with `source: "agent"`.
   - An `agent` profile overwrites a `router` profile, and the AI router never overwrites an `agent` profile. A person can still override an `agent` profile at any time (`PUT /api/tasks/:id/run-profile`), promoting it to `manual`.
3. **One-off launch override (`explicit_model` / `explicit_level`):**
   - Picking a level or model in the **Start in T3** dialog (`POST /api/tasks/:id/t3-run`), passing `level` / `model` / `options` to MCP `start_t3_thread`, or using `/t3 run level=<key>` in a comment overrides the resolved model for that single run without overwriting the task's stored `task_run_profiles` record.

---

## 5. Declaring touched paths, serial paths, and the parallel cap

When an umbrella task delegates work to child tasks, the server — not the agent — checks whether siblings may run at the same time.

### Declared touched paths (`touches` and `parallelSafe`)

- Each child task's `runProfile.touches` lists normalized relative repository path globs (for example, `["packages/core/src/**"]` or `["apps/web/src/components/tasks/**"]`).
- Two path globs overlap (`pathsOverlap` in `@bitig/core`) if any file could match both globs (for example, `packages/core/**` and `packages/core/src/**` overlap, whereas `packages/core/src/**` and `apps/web/src/**` are disjoint).
- **Conservative solo default:** A task with **no declared `touches`** (empty array or no run profile) is assumed to touch anything in the repository and **must run alone**. Likewise, a task with `parallelSafe: false` always runs alone.

### Project serial paths (`serialPaths`)

- Each project configures `serialPaths` in **Project Details → Run Settings** (`GET` / `PUT` / `PATCH /api/projects/:id/run-settings` or `/api/t3/projects/:projectId/run-settings`).
- By default, Bitig seeds `DEFAULT_BITIG_SERIAL_PATHS`:
  - `packages/storage-d1/migrations/**`
  - `apps/worker/test/**`
  - `packages/storage-d1/src/t3-store.test.ts`
  - `pnpm-lock.yaml`
- Any task whose declared `touches` overlap a project `serialPaths` pattern is treated as a **solo task**: it can only start when no sibling is running, and once picked it closes the batch so no other sibling runs alongside it.

### The parallel cap (`maxParallelChildren`)

- Each project has a `maxParallelChildren` setting (`1..10`, default `3`), editable in **Project Details → Run Settings**.
- At most `maxParallelChildren` child sessions may run concurrently under one umbrella task. Calling `start_ready_children({ parentTaskId, max })` or `POST /api/tasks/:id/children/start-ready` with `{ max }` applies `min(max, maxParallelChildren)`.

### Server-side parallel gate and skip reasons

A child task can start alongside siblings (via `start_ready_children`, `POST /api/tasks/:id/children/start-ready`, or `start_t3_thread` with `parentTaskId`) only when all of the following hold:

1. The umbrella session is active and has reported clean git metadata (`branch`, `headSha`, `worktreePath`, `dirty: false`).
2. The child is approved (`!pendingApproval`), is not waiting on a person (`!needsHuman`), and has no unfinished dependencies other than the umbrella parent itself (`!blocked`).
3. The number of currently running children is below `maxParallelChildren`.
4. The child uses `workspaceStrategy: "worktree"` (passing `"root"` with `parentTaskId` is refused).
5. Neither the candidate child nor any currently running sibling has empty `touches`, `parallelSafe: false`, or overlaps `serialPaths` (unless no other sibling is running and the candidate runs as a solo batch of 1).
6. The candidate child's `touches` do not overlap any running or already-picked sibling's `touches`.

When a child is skipped during batch selection or refused on direct launch, Bitig returns the exact `reason` (`unapproved`, `blocked`, `cap_reached`, `running_solo_sibling`, `no_touches`, `not_parallel_safe`, `touches_serial_path`, `overlaps_running`, `overlaps_picked`) along with `blockingTaskCode` and `overlappingPath`.

---

## 5b. Explicit task hierarchy (`parentId`), `HIERARCHY_MODE`, and legacy migration (#BIT-195)

Umbrella parent-child containment is an **explicit** same-project, acyclic, single-parent relationship on `Task.parentId` — distinct from `dependsOn` (ordering prerequisites), `#BIT-x` mentions (cross-references), checklist items, and historical run ancestry:

- **Explicit mode (`HIERARCHY_MODE="explicit"`, default):**
  - `GET /health` exposes `hierarchyMode` (`"explicit"` or `"legacy"`).
  - Umbrella children come solely from `task.parentId === umbrellaTaskId` (plus persisted `agent_run_children` records for run execution tracking).
  - Passing `parentTaskId` to `start_t3_thread` validates that the child task's `parentId` already equals `parentTaskId` (refusing unattached tasks even if they mention or depend on the umbrella).
  - UI badges, sidebars, and **Parent / Children** hierarchy panels do not infer containment from `dependsOn`, mentions, checklist `#BIT-x` entries, or `"Umbrella:"` title markers.
- **Legacy rollback mode (`HIERARCHY_MODE="legacy"`):**
  - Restores read-time fallback child inference (explicit `Umbrella:` markers, checklist mentions, and recorded run ancestry) for pre-cutoff workspaces.
- **Per-run `hierarchyMode` snapshot:**
  - Each `agent_runs` record snapshots `hierarchyMode` when started. An umbrella run started in `"legacy"` mode keeps resolving its active child batch under `"legacy"` rules until completion even if `HIERARCHY_MODE` flips to `"explicit"`.
- **Active-delegation mutation guards:**
  - While an umbrella session has an active child delegation (`agent_run_children.state === "running"` or active `waiting_subagent` run), changing/clearing a child's `parentId`, moving the parent or child to another project, or deleting the parent/child task is rejected with `409 Conflict`.
- **Read-only legacy inventory & human-confirmed import (`editor+`):**
  - `GET /api/tasks/hierarchy/inventory` (MCP `list_legacy_hierarchy_inventory`) inspects pre-cutoff umbrella candidates and returns `{ candidates, conflicts, summary }` with provenance (`run_ancestry`, `checklist`, `umbrella_marker`) without modifying any tasks.
  - `POST /api/tasks/hierarchy/import` (MCP `import_explicit_hierarchy`, `editor` or `owner` role) applies only explicitly selected `(childTaskId, parentTaskId)` links, never overwrites an existing `parentId`, and rejects cross-project or cycle candidates. People can review and import candidates in **Settings → Task Hierarchy**.

---

## 6. Worktree, branch, and merge flow

Umbrella orchestration uses isolated git worktrees and branches so parallel children never step on each other or on the root checkout:

```
master / main
  └── bitig/BIT-183  (umbrella worktree — integration branch)
        ├── bitig/BIT-184  (child 1 worktree, batch 1) ──┐
        └── bitig/BIT-185  (child 2 worktree, batch 1) ──┴─► umbrella merges in task order,
                                                             runs `make check`, calls
                                                             `report_child_merge`, removes
                                                             child worktrees/branches
        └── bitig/BIT-186  (child 3 worktree, batch 2, branched from updated BIT-183 HEAD)
```

1. **Umbrella integration branch:** The umbrella session works in its own worktree on a single integration branch `bitig/<umbrella-code>` (for example, `bitig/BIT-183`).
2. **Commit and report clean metadata first:** Before launching any child tasks, the umbrella session commits its own changes and calls `report_t3_git_metadata` with `branch`, `headSha`, `worktreePath`, and `dirty: false`. Child launches are refused if the umbrella has not reported its worktree metadata or has uncommitted tracked changes (`dirty: true`).
3. **Child worktrees branch from the umbrella head:** When `start_ready_children` (or `start_t3_thread` with `parentTaskId`) launches a child, Bitig passes `workspaceStrategy: { type: "worktree", baseRef: "<umbrella-branch>", branch: "bitig/<child-code>", startFromOrigin: false }` and instructs the child session to verify that its worktree is on `bitig/<child-code>` based on the umbrella's `headSha`. Each child launches with its own resolved model selection and effort.
4. **Child commit discipline:** Each child works only inside its own worktree and declared `touches`, commits on `bitig/<child-code>`, **never merges** into the umbrella branch or default branch, **never opens a pull request**, reports its `branch`, `headSha`, `changedPaths`, and `diffStat` via `report_t3_git_metadata`, posts its final comment, and calls `complete_task`.
5. **Waiting and single batch resume (`agent_run_children`):**
   - While children run, the umbrella run state is `waiting_subagent` and each child in the batch is tracked in `agent_run_children` (`running | done | failed | stopped | needs_human`).
   - When one child finishes (or fails, is stopped, or sets `needsHuman`) while siblings in the batch are still `running`, Bitig records that child's terminal state and keeps the umbrella waiting without interrupting the remaining siblings.
   - Once **every** child in the batch has ended, Bitig resumes the umbrella thread **once** with a single consolidated message ordered by canonical task `order`. For each child, the message includes its outcome, branch, head commit SHA, diff stat, any **out-of-bounds path warning** (files in `changedPaths` or checkpoint `modifiedArtifacts` that fell outside the child's declared `touches`), checklist status, latest checkpoint, and final comment.
6. **Merging in task order and recording merges (`report_child_merge`):**
   - When resumed, the umbrella merges each `done` child branch (`bitig/<child-code>`) into `bitig/<umbrella-code>` in task `order`, paying special attention to any child flagged with an out-of-bounds path warning.
   - After each merge, the umbrella resolves any safe conflicts, runs `make check`, calls `report_child_merge({ parentTaskId: "<umbrella-code>", childTaskId: "<child-code>", mergedSha: "<integration-head-sha>" })`, and removes the merged child's worktree and branch (`git worktree remove` and `git branch -d bitig/<child-code>`).
   - Before starting the next batch, the umbrella calls `report_t3_git_metadata` with its new `headSha` and `dirty: false` so the next batch of children branches from the merged integration state.
7. **One pull request at the end:** Once all child tasks are `done` and merged into `bitig/<umbrella-code>`, the umbrella opens a single pull request from the integration branch, reports `pullRequestUrls` via `report_t3_git_metadata`, posts its final summary comment, and completes the umbrella task.

---

## 7. Dashboard work queues (#BIT-197)

In Cloudflare (`D1`) mode, the **Start work** prompt at the top of the **Overview** dashboard turns a free-text prompt (such as `Start BIT-92 to BIT-102, WOR-1 and KMZ-3`) into a reviewed, cross-project work queue (`work_queues` and `work_queue_items`). When no T3 host is connected, the prompt renders a **Connect T3** link to Settings instead of the form.

### Two-stage prompt parsing

Submitting the prompt (**Plan** or `Cmd+Enter` / `Ctrl+Enter` → `POST /api/work-queue/plan`) runs a two-stage parser:

1. **Stage 1 — Deterministic parser (`parseWorkQueuePrompt` in `@bitig/core`):**
   - **Codes:** Case-insensitive project key (`2..10` alphanumeric characters starting with a letter) plus task number (`1..999_999_999`), optionally prefixed with `#` and separated by `-` or whitespace (`BIT-92`, `bit-92`, `#BIT-092`, `Bit 92`). Leading zeros are stripped (`KMZ-03` → `KMZ-3`), and numbers `< 1` are ignored with a warning.
   - **Known-key guard:** Space-separated references (`Bit 92`) match **only** when the key belongs to a non-archived project in the organisation; otherwise the word is treated as ordinary prose. Hyphenated unknown keys (`KOM-03`) are never guessed silently: they are returned in `unknownKeys` with up to `3` ranked suggestions (project name prefix or initials first, then key prefix, then edit distance `<= 2`).
   - **Ranges:** Inclusive ranges (`BIT-92 to BIT-102`, `BIT-92..102`, `BIT-92-102`, `BIT-92 through` / `thru` / `till` / `until 102`, or `BIT-92 to 102` sharing the leading key). Cross-project ranges (`BIT-1 to WOR-2`) and backwards ranges (`BIT-10 to BIT-5`) emit a warning and keep only their two endpoints instead of expanding across projects. Single ranges truncate at `50` items (`MAX_WORK_QUEUE_ITEMS`), and total emitted items after deduplication and exclusions are capped at `50`.
   - **Lists and exclusions:** Commas, `and`, `&`, `plus`, newlines, and semicolons separate items. Exclusion keywords (`except`, `but not`, `other than`, `excluding`, `without`, `minus`) drop matching codes from the selection and carry across list connectors until a newline, `;`, `.`, or non-stopword word resets exclusion mode.
   - **Unparsed words:** Any remaining non-stopword tokens are returned in `unparsed`.
2. **Stage 2 — AI router fallback (`parseWorkQueuePromptWithFallback`):**
   - Invoked **only** when the prompt is non-empty and Stage 1 either matched zero codes or left meaningful words in `unparsed` (skipped when explicit `items` are supplied from preview chip edits, or when `prompt.length > 2,000` characters).
   - Calls the organisation's configured AI router HTTP endpoint (`8 s` timeout; supports `"cloudflare-run"` and `"openai"` chat styles — `"cloudflare-clef"` is skipped as unsupported). No T3 thread or scratch T3 project is used.
   - Sends `{ projects: [{ key, name }], text }` as data and validates the response against `{ codes: string[], ranges: [{ key, from, to }] }`. The validated output is re-serialised and passed back through `parseWorkQueuePrompt` together with the original prompt so the model can never invent project keys, bypass exclusions, or exceed `MAX_WORK_QUEUE_ITEMS`.
   - If the router is disabled, unreachable, times out, or returns invalid JSON/schema, planning never blocks: Bitig returns the Stage 1 deterministic result with a warning (`fallback: "router_unavailable"` or `"failed"`).

### Classification, routing, and approvals from the preview

For each parsed code, `planWorkQueue` classifies live task state:

| `classification` | Preview status | Queued on confirm? |
| --- | --- | --- |
| `ready` | Ready | Yes |
| `after_queued_task` | After `<blocker>` (unfinished dependency is also queued in this batch) | Yes (waits in queue) |
| `needs_approval` | Needs approval (**Approve `<CODE>`** checkbox + **Approve all**) | Only if ticked by a person |
| `waits_on_unqueued_task` | Waits on `<blocker>` (not queued), with **Add `<blocker>`** button | No (until blocker added) |
| `already_running` | Already running (`status === "in_progress"` or active `agent_runs`) | No |
| `already_queued` | Already queued (occupies an active entry in an open queue) | No |
| `done` | Done (`done` or `archived`) | No |
| `not_found` | `<CODE>` doesn't exist (e.g. gap in a range) | No |
| `project_not_connected` | Project has no T3 mapping, with **Map it in Projects** link | No |
| `needs_person` | Waiting on you (`needsHuman` set on task) | No |
| `folded` | Folded under `<UMBRELLA>` (both an umbrella and its child were listed) | No (umbrella runs it) |
| `unlisted_parent` | Part of `<PARENT>` (task already has an unlisted `parentId`), with **Queue `<PARENT>` instead** button | No (never re-parented) |
| `dependency_cycle` | Cyclic `dependsOn` chain among listed tasks | No |

**Decision engine & preview overrides:**
- During `POST /api/work-queue/plan`, Bitig invokes the AI router (`suggestTaskRunProfile` with `onlyWhenUnprofiled: true`, bounded by a `10 s` batch timeout) in parallel for unprofiled `ready`, `after_queued_task`, and `needs_approval` tasks, saving `source: "router"` profiles (including `touches`) and recomputing lane waves. (MCP `plan_work_queue` passes `route: false` so MCP previews remain strictly read-only.)
- If neither a task profile nor the project's `defaultRunLevel` selects a level, the planner falls back to the organisation's lowest run level and marks the row `"default, not routed"`.
- In the preview (`WorkQueuePlanPreview`), people can remove code chips, apply one-click unknown-key suggestions (**Use `KMZ (Komuz)`**), tick **Approve `<CODE>`** / **Approve all**, and change any row's `level`, `model`, or `effort`.
- Clicking **Queue N tasks** (`POST /api/work-queue` with `{ prompt, items, approvals, overrides }`) rebuilds the plan on the server from `items` (never trusting client classifications or waves), clears `pendingApproval` attributed to the signed-in person for ticked `approvals` (recording task activity and settling any linked feedback entry), saves `overrides` as `source: "manual"` run profiles, creates lane umbrellas where needed, and activates the queue. If nothing listed can be queued, the server responds with `409 { error: "nothing_to_queue", message, plan }`.

### Lanes, parallelism, queue umbrellas, and the per-host cap

Each Bitig project forms an independent **lane** (`work_queue_items.lane = projectId`):

- **Parallel across project lanes:** Tasks in different projects (e.g. `BIT`, `WOR`, `KMZ`) touch separate repositories and T3 projects, so lanes run concurrently side by side, bounded only by each T3 host's `maxParallelRuns`.
- **Per-host parallel run cap (`maxParallelRuns`):** Stored per T3 host on `t3_connections.max_parallel_runs` (`1..20`, default `3` via `DEFAULT_HOST_MAX_PARALLEL_RUNS` when `null`, read/written via `D1WorkQueueStore` and preserved when reauthorising a host; there is no REST or Settings UI editor for `maxParallelRuns` yet). The cap counts **every** active session (`queued`, `working`, `waiting_for_approval`, `waiting_subagent`, `offline`) on that host across both `agent_runs` (including manual runs and running umbrella children) and `project_t3_threads`. `reserveWorkQueueLaunch` arbitrates the last slot in a single conditional SQL `INSERT ... SELECT` (using idempotent `clientRequestId` `wq:<entryId>` or `wq:<entryId>:child` and releasing stale reservations older than `10` minutes).
- **Single-task lane (1 queued task in a project):** Launches directly on its own worktree branch `bitig/<code>` (`umbrellaTaskId: null`) with its snapshotted `resolvedSelection`, and opens its own pull request when finished.
- **Multi-task lane (2+ queued tasks in a project):** Confirm creates an approved queue umbrella task in that project (`Queue: BIT-92..BIT-102` when contiguous, `Queue: BIT-92, BIT-95` up to 5 codes, or `Queue: BIT-92..BIT-110 (N tasks)` above 5; labelled `work-queue`), sets explicit `task.parentId = umbrella.id` on every queued task in that lane (never setting `dependsOn` on the umbrella), and records `umbrellaTaskId = umbrella.id` on each queue item.
  - The dispatcher launches **only** the queue umbrella session; the umbrella agent drives its children through the standard Section 6 flow (`start_ready_children` → `bitig/<child-code>` worktrees → ordered merges → `make check` → `report_child_merge` → **one pull request** for the lane).
  - Inside a multi-task lane, a child task with `dependsOn` on an earlier child in the same lane stays gated (`Waiting for dependency <id> to be merged`) until `report_child_merge` records `mergedAt` — completing the dependency on its child branch alone does not unblock the dependent.
  - After the lane finishes, the queue umbrella moves to `done` and its children keep `parentId = umbrella.id` as a permanent record of how they shipped.
- **Wave preview vs live dispatcher:** The preview groups each lane into estimated waves (`Wave 1`, `Wave 2`, …) using `dependsOn` readiness and `pickParallelBatch` (`touches`, `parallelSafe`, `serialPaths`, `maxParallelChildren`). At runtime, the dispatcher (`dispatchWorkQueues`) re-evaluates live gates after every mutating `/api/*` or `/mcp` request, after every `agent_runs` state change or `report_child_merge`, and on the scheduled Worker cron (`runScheduledWorkQueues`, which reconciles live T3 runs via `listT3RunsLive` first).

### Queue & item state machines

- **`work_queues.state`:** `planning` → `active` ⇄ `paused`, `planning | active | paused` → `cancelled`, and `active` → `done` (once every stored row in `work_queue_items` is `done`, `skipped`, or `cancelled`).
- **`work_queue_items.state`:** `waiting` → `ready` → `running` → `merged` → `done`, plus terminal transitions to `failed`, `skipped`, and `cancelled`. A partial unique index on `work_queue_items(task_id)` over `('waiting', 'ready', 'running', 'merged')` ensures each task occupies at most one active queue item at a time.
  - Single-task lane items advance `running` → `merged` → `done` when the task completes.
  - Multi-task lane items stay `running` (`Waiting for umbrella merge`) after `complete_task` until `report_child_merge` sets `mergedAt` (moving the item to `merged`), and advance `merged` → `done` when the lane's queue umbrella task reaches `done`.

### Failure handling, isolation, and queue controls

- **Failure isolation across lanes and unrelated tasks:** If a task run fails, stops, or finishes without completing the task (or throws on launch), its queue item moves to `failed`. Items that `dependsOn` the failed task remain `waiting` (`Dependency <id> failed`), while unrelated items and other project lanes keep running normally. While a failed item remains unretried, the queue stays `active` rather than closing as `done`.
- **Umbrella `needsHuman` (merge conflict or failing `make check`):** If a lane's queue umbrella sets `needsHuman`, only that lane pauses (`Lane paused: <reason>`); other project lanes continue.
- **T3 host offline:** Launches fall back to `agent_runs.state = "queued"` (`t3_run_requests`) while the queue item becomes `ready` (`T3 host offline or waiting to dispatch`), draining automatically on reconnect after re-running `checkWorkQueueLaunch`.
- **Host/provider usage limits:** Errors matching usage, rate, credit, or quota limits stamp `Host usage limit: <reason>` onto open items mapped to **that host**, holding further launches on that host while other connected hosts continue. Explicitly pausing and resuming the queue (`queue.updatedAt > entry.updatedAt`) clears the hold without automatic paid escalation.
- **Expired T3 OAuth sign-in:** An expired host token (`expiresAt <= now` or `401`) records `T3 sign-in expired; reconnect before resuming the queue` on the item, pauses the queue (`state: "paused"`), and broadcasts `work_queue.updated`.
- **Mid-queue task edits:** Before launching (and before draining an offline run), the dispatcher re-checks live task state: tasks archived, completed externally, deleted, moved across projects, or reparented elsewhere are `skipped` with the reason; tasks whose approval was revoked or that gained `needsHuman` are held as `waiting`.
- **Dashboard controls (`WorkQueuePanel`):**
  - **Pause / Resume (`POST /api/work-queues/:id/pause` | `/resume`):** Holds new launches and offline drains while letting active sessions continue, then resumes dispatch.
  - **Cancel queue (`POST /api/work-queues/:id/cancel`):** Immediately cancels unstarted (`waiting` / `ready`) items and detaches their `parentId` (`null`) from any queue umbrella so they return cleanly to the backlog. The dispatcher stops running sessions (`t3_thread_interrupt`, umbrellas before children so child stops cannot wake a cancelled umbrella) without deleting git branches; already-merged items transition to `done`.
  - **Skip (`POST /api/work-queue-items/:id/skip`):** Marks an unstarted (`waiting` / `ready`) item `skipped` and detaches `parentId` from its queue umbrella.
  - **Retry & Retry on next level up (`POST /api/work-queue-items/:id/retry`):** Appends a new `waiting` item at the end of the open queue (with a fresh `wq:<newEntryId>` idempotency key, re-attaching `parentId` to the lane umbrella if a prior skip/cancel detached it) while preserving the earlier `failed` / `skipped` / `cancelled` item as history. Passing `{ level }` escalates the retry explicitly — never automatically.

### Known v1 limitations

- **No PR links in the queue panel:** `WorkQueueEntry` rows do not carry pull request URLs, so `WorkQueuePanel` does not render PR links directly; open the lane umbrella task (for 2+ task lanes) or the task itself (for single-task lanes) to view reported `pullRequestUrls`.
- **Manual control actions do not broadcast over realtime:** `pause`, `resume`, `cancel`, `skip`, and `retry` update the caller's tab from the HTTP response, while only the background dispatcher publishes `work_queue.updated` and `work_queue_item.updated` WebSocket events.
- **MCP agents cannot approve tasks when queueing:** `queue_tasks` never passes `approvals`, leaving `needs_approval` tasks out of the queue until a person approves them in Bitig.
- **Historical `failed` rows keep a retried queue `active`:** Because `retry` appends a new `work_queue_items` row while preserving the earlier `failed` row and the dispatcher checks `every` stored row for `done | skipped | cancelled`, a queue with a retried failure stays `active` after the retry finishes until explicitly cancelled.

---

## 8. What needs a person

Bitig keeps humans in control of every privilege boundary, cost escalation, and irreversible git action:

- **Approving agent-created tasks (`pendingApproval`):** Every task an agent creates via `add_task` starts with `pendingApproval: true`. Agents cannot approve tasks (including via MCP `queue_tasks`) or start T3 runs for unapproved tasks; a person approves them in the web UI (task detail or the work-queue plan preview), CLI (`bitig tasks approve`), or REST (`PATCH /api/tasks/:id` with `{ "pendingApproval": null }` or `POST /api/work-queue` with `approvals`).
- **Owner-only administration:** Connecting T3 hosts, registering host folders, editing organisation task levels and model mappings (`/api/orgs/:id/run-levels`), and configuring the AI router endpoint and token (`/api/orgs/:id/ai-router`) require the organisation `owner` role.
- **Retry on the next level up (`nextLevelUp`):** When a run fails (`state: "failed"`) or a task sets `needsHuman` while assigned to a level below the organisation's highest level, Bitig includes `nextLevelUp` on `GET /api/tasks/:id/run-profile`, `GET /api/tasks/:id/t3-run`, and MCP `get_task`, and offers one-click **Retry on <Next Level>** / **Retry on next level up** buttons in the task's T3 section and the dashboard work-queue panel. **Nothing escalates to a higher level automatically.**
- **Child task blockers (`needsHuman` or failed session):** If a child task sets `needsHuman` or its T3 session fails/stops, its sibling tasks finish normally and the batch resume message reports the blocked or failed child to the umbrella. Either a person resolves the child's question/failure and retries it, or the umbrella stops and sets `needsHuman` on the umbrella task if it cannot proceed.
- **Unsafe merge conflicts or failing checks:** If merging a child branch into the integration branch produces a conflict the umbrella agent cannot resolve with confidence, or if `make check` fails after the merge, the umbrella aborts the conflicting merge, posts a comment with the exact conflict or failure output, and sets `needsHuman` on the umbrella task.
- **Pull request review and task archiving:** People review and merge the umbrella's (or single-task lane's) pull request into the default branch and move completed tasks from `done` to `archived`. Agents never merge into the default branch or archive tasks.

---

## 9. API & MCP reference

### REST endpoints

| Route | Role | Purpose |
| --- | --- | --- |
| `GET /api/orgs/:id/run-levels` | Member | List the organisation's ordered run levels and model bindings (`?hostId=<id>` resolves host-specific bindings) |
| `PUT /api/orgs/:id/run-levels` | Owner | Save ordered run levels, default/per-host model bindings, and `replacementKeys` for removed levels |
| `GET /api/orgs/:id/ai-router` | Owner | Read AI router configuration (`baseUrl`, `model`, `apiStyle`, `hasToken`, `tokenStatus`, `tokenLast4`, `enabled`, `configured`) |
| `PUT /api/orgs/:id/ai-router` | Owner | Configure AI router endpoint, model, style, encrypted token, or enabled state |
| `DELETE /api/orgs/:id/ai-router` | Owner | Delete AI router configuration and stored token |
| `POST /api/orgs/:id/ai-router/test` | Owner | Probe the AI router endpoint with a test task and return `{ ok, status, latencyMs, suggestion?, error? }` |
| `GET /api/projects/:id/run-settings` | Member | Read project `defaultRunLevel`, `serialPaths`, and `maxParallelChildren` (also mounted at `/api/t3/projects/:projectId/run-settings`) |
| `PUT` / `PATCH /api/projects/:id/run-settings` | Editor / Owner | Update project `defaultRunLevel`, `serialPaths`, and `maxParallelChildren` |
| `GET /api/t3/run-profiles` | Member | List all task run profiles and run levels in the organisation for board/list level chips |
| `GET /api/tasks/:id/run-profile` | Member | Get a task's `profile`, `resolved` model selection, `routerEnabled`, and optional `nextLevelUp` |
| `PUT /api/tasks/:id/run-profile` | Editor / Owner | Save a manual run profile (`source: "manual"`) on a task |
| `DELETE /api/tasks/:id/run-profile` | Editor / Owner | Clear a task's run profile so agent/router suggestions or project defaults apply |
| `POST /api/tasks/:id/run-profile/suggest` | Editor / Owner | Invoke the AI router on demand for a task (never overwrites `manual` or `agent` profiles) |
| `GET /api/tasks/:id/children` | Member | Inspect an umbrella task's children, resolved levels/models, `readyBatch` preview, `waitingReason`s, git/merge status, and `progress` |
| `POST /api/tasks/:id/children/start-ready` | Editor / Owner | Launch the next parallel-safe batch of ready children for an umbrella task |
| `POST /api/tasks/:id/children/stop` | Editor / Owner | Stop all currently running child T3 sessions of an umbrella task |
| `GET /api/tasks/hierarchy/inventory` | Member | Read-only inventory of pre-cutoff legacy hierarchy candidates and conflicts (`?projectId=<id>`) |
| `POST /api/tasks/hierarchy/import` | Editor / Owner | Human-confirmed import of selected legacy child-parent links into explicit `task.parentId` |
| `POST /api/work-queue/plan` | Editor / Owner | Parse a free-text `prompt` (or explicit `items`), route unprofiled tasks via the AI router, and return the `WorkQueuePlanView` preview |
| `POST /api/work-queue` | Editor / Owner | Confirm a work queue from `items`, applying human `approvals` and manual `overrides`, creating 2+ task lane umbrellas, and activating the queue (`409 nothing_to_queue` if none are queueable) |
| `GET /api/work-queues` | Member | List open work queues and decorated entries (`?all=true` includes `done` and `cancelled` queues, up to 50 newest) |
| `POST /api/work-queues/:id/pause` | Editor / Owner | Pause an `active` work queue so no new sessions or offline drains start |
| `POST /api/work-queues/:id/resume` | Editor / Owner | Resume a `paused` work queue |
| `POST /api/work-queues/:id/cancel` | Editor / Owner | Cancel a work queue, detaching unstarted children from queue umbrellas and stopping running sessions via the dispatcher |
| `POST /api/work-queue-items/:id/skip` | Editor / Owner | Skip an unstarted (`waiting` / `ready`) queue item and detach its task from any queue umbrella |
| `POST /api/work-queue-items/:id/retry` | Editor / Owner | Append a fresh `waiting` item for a `failed`, `skipped`, or `cancelled` queue item (accepts optional `{ level }`) |

### MCP tools

| Tool | Purpose |
| --- | --- |
| `list_run_levels` | List the organisation's ordered run levels (`key`, `label`, `description`, `order`, `selection`) before breaking work into tasks |
| `add_task` / `update_task` (`parentId`, `runProfile`) | Set explicit single-parent `parentId` containment and save `{ level, effort, selection, touches, parallelSafe, reason }` on a task with `source: "agent"` (never overwrites `source: "manual"`) |
| `suggest_run_profile` | Ask the organisation's AI router to suggest and store a `router` profile for a task |
| `start_t3_thread` | Launch a task (or a single umbrella child with `parentTaskId`, requiring `task.parentId === parentTaskId` in explicit mode) in T3, optionally overriding `level`, `model`, `providerInstanceId`, and `options` |
| `start_ready_children` | Pick and launch the next batch of approved, unblocked, non-overlapping child tasks for `parentTaskId` |
| `report_t3_git_metadata` | Report `branch`, `headSha`, `worktreePath`, `dirty` / `uncommittedChanges`, `changedPaths`, `diffStat`, and `pullRequestUrls` |
| `report_child_merge` | Record that the umbrella session merged `childTaskId`'s branch into `parentTaskId`'s integration branch at `mergedSha` |
| `list_legacy_hierarchy_inventory` | Inspect pre-cutoff inferred parent-child candidates and conflicts without mutating tasks |
| `import_explicit_hierarchy` | Apply explicitly selected legacy parent-child links into `task.parentId` without overwriting existing parents |
| `plan_work_queue` | Read-only preview (`route: false`, no writes) of how a `prompt` or `items` list parses into rows, classifications, lanes, waves, and run selections |
| `queue_tasks` | Queue listed ticket `items` with `prompt` (`editor`+ role; never approves `needs_approval` tasks, returning `{ queued: false, reason: "nothing_to_queue", plan }` when nothing can be queued) |
| `list_work_queues` | List open work queues and their entries (or all up to 50 with `includeClosed: true`) |

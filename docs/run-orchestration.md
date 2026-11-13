# Run orchestration: task levels, AI router, and parallel umbrella children

Bitig orchestrates coding sessions on connected T3 Code hosts across two dimensions (#BIT-183):

1. **Model and reasoning effort per task** — organisation-defined task levels mapped to T3 models and options, per-task run profiles (`manual`, `agent`, or `router`), and an optional per-organisation AI router that suggests a level, effort, and touched paths when a task is approved.
2. **Parallel child tasks under an umbrella session** — server-enforced path-overlap and serial-path checks, a configurable per-project parallel cap, child worktrees branched from the umbrella's integration worktree, a single consolidated batch resume, and tracked branch merges (`report_child_merge`).

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
   - `"cloudflare-run"` (default) — posts to `<baseUrl>/<model>` (for example, `https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/run` with model `@cf/cloudflare/clef`).
   - `"openai"` — posts to `<baseUrl>/chat/completions` with `{ model, messages, response_format }` (for example, a Cloudflare AI Gateway `/compat` endpoint or any OpenAI-compatible provider). Switching between direct Workers AI and an AI Gateway requires changing settings only.
3. **Model ID (`model`):**
   - The model identifier passed to the endpoint (for example, `@cf/cloudflare/clef`).
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

## 7. What needs a person

Bitig keeps humans in control of every privilege boundary, cost escalation, and irreversible git action:

- **Approving agent-created tasks (`pendingApproval`):** Every task an agent creates via `add_task` starts with `pendingApproval: true`. Agents cannot approve tasks or start T3 runs for unapproved tasks; a person approves them in the web UI, CLI (`bitig tasks approve`), or REST (`PATCH /api/tasks/:id` with `{ "pendingApproval": null }`).
- **Owner-only administration:** Connecting T3 hosts, registering host folders, editing organisation task levels and model mappings (`/api/orgs/:id/run-levels`), and configuring the AI router endpoint and token (`/api/orgs/:id/ai-router`) require the organisation `owner` role.
- **Retry on the next level up (`nextLevelUp`):** When a run fails (`state: "failed"`) or a task sets `needsHuman` while assigned to a level below the organisation's highest level, Bitig includes `nextLevelUp` on `GET /api/tasks/:id/run-profile`, `GET /api/tasks/:id/t3-run`, and MCP `get_task`, and shows a one-click **Retry on <Next Level>** button in the task's T3 section. **Nothing escalates to a higher level automatically.**
- **Child task blockers (`needsHuman` or failed session):** If a child task sets `needsHuman` or its T3 session fails/stops, its sibling tasks finish normally and the batch resume message reports the blocked or failed child to the umbrella. Either a person resolves the child's question/failure and retries it, or the umbrella stops and sets `needsHuman` on the umbrella task if it cannot proceed.
- **Unsafe merge conflicts or failing checks:** If merging a child branch into the integration branch produces a conflict the umbrella agent cannot resolve with confidence, or if `make check` fails after the merge, the umbrella aborts the conflicting merge, posts a comment with the exact conflict or failure output, and sets `needsHuman` on the umbrella task.
- **Pull request review and task archiving:** People review and merge the umbrella's pull request into the default branch and move completed tasks from `done` to `archived`. Agents never merge into the default branch or archive tasks.

---

## 8. API & MCP reference

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

### MCP tools

| Tool | Purpose |
| --- | --- |
| `list_run_levels` | List the organisation's ordered run levels (`key`, `label`, `description`, `order`, `selection`) before breaking work into tasks |
| `add_task` / `update_task` (`runProfile`) | Save `{ level, effort, selection, touches, parallelSafe, reason }` on a task with `source: "agent"` (never overwrites `source: "manual"`) |
| `suggest_run_profile` | Ask the organisation's AI router to suggest and store a `router` profile for a task |
| `start_t3_thread` | Launch a task (or a single umbrella child with `parentTaskId`) in T3, optionally overriding `level`, `model`, `providerInstanceId`, and `options` |
| `start_ready_children` | Pick and launch the next batch of approved, unblocked, non-overlapping child tasks for `parentTaskId` |
| `report_t3_git_metadata` | Report `branch`, `headSha`, `worktreePath`, `dirty` / `uncommittedChanges`, `changedPaths`, `diffStat`, and `pullRequestUrls` |
| `report_child_merge` | Record that the umbrella session merged `childTaskId`'s branch into `parentTaskId`'s integration branch at `mergedSha` |

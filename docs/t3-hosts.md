# T3 hosts: prerequisites and folder registration

Bitig runs coding sessions on one or more T3 Code hosts that the organisation owner connects in **Settings**. This page covers what each host needs, how Bitig persists multiple hosts and host-bound project mappings (#BIT-147), how Bitig registers project folders on a host (#BIT-148), and how owner-only administration and host-scoped execution are enforced (#BIT-149). For the security model, see [`security.md`](security.md#6b-t3-code-access-from-bitig-oauth-mcp-client).

## Multiple hosts and host-bound mappings (#BIT-147, #BIT-149)

An organisation can connect and authenticate multiple T3 Code hosts independently:

- **Owner-only administration (#BIT-149):** Only the organisation `owner` may connect, reauthorise, configure, or disconnect hosts, manage project mappings and host folders, or create, import, or delete Bitig projects across REST and MCP (`create_project`, `delete_project`). Platform `admin` status does not grant organisation `owner` permissions. Organisation `editor`s can run tasks and project threads on mapped projects without host-management privileges or token access; `viewer`s are read-only.
- **Stable host identity:** Each host connection in `t3_connections` has a stable `id`, organisation ownership (`org_id`), optional `label`, host `kind` (`"user"` or `"container"`), and `projectsRoot` (`~/www` by default for user-owned hosts, `/var/www` for managed containers).
- **Per-host OAuth and capability caches:** Starting OAuth (`POST /api/t3/oauth/start`) accepts an optional `hostId`, `label`, `kind`, and `projectsRoot`. Reauthorising an existing `hostId` must match its recorded `mcpUrl` and updates only that host's encrypted token and metadata without affecting any other host. Model capabilities (`GET /api/t3/capabilities`) and connection status (`GET /api/t3/connection`) accept `?hostId=<id>`, `?projectId=<id>`, or `?taskId=<id>` and resolve the recorded host; when multiple hosts exist and no host context is provided, Bitig rejects ambiguous requests (`400`) instead of guessing.
- **One active host mapping per project:** Each Bitig project (`t3_project_mappings`) maps to at most one `(hostId, t3ProjectId)` pair at a time. Replacing or deleting a mapping, unregistering a host folder, or deleting a project is refused (`409 { error: "project_busy" }`) while the project has active or offline T3 sessions.
- **Originating-host retention and collision safety:** Task runs (`agent_runs`), queued offline requests (`t3_run_requests`), and project-level threads (`project_t3_threads`) record the `hostId` on which they were launched. Every status check, reply, approval response, model switch, stop, and settlement routes strictly to that recorded host without silent cross-host fallback, and reports host-specific errors when a host is disconnected, offline, or expired. Project-thread endpoints accept `?hostId=<id>` so identical remote `threadId`s on different hosts never collide.

## Host prerequisites

The operator prepares the host before the owner connects it:

1. **T3 Code is installed and running.** Its `/mcp` endpoint is reachable from the Bitig Worker over HTTPS. Loopback is allowed only in local development. If the host is behind Cloudflare Access, set `T3_CF_ACCESS_CLIENT_ID` and `T3_CF_ACCESS_CLIENT_SECRET` on the Worker.
2. **A projects root exists:**
   - `/var/www` on managed containers (`kind: "container"`)
   - `~/www` on user-owned hosts (`kind: "user"`)

   The UI suggests `<projects root>/<project name>`, and the owner may customise `projectsRoot` per host or enter any absolute or `~/` path.
3. **Worktrees are configured** under `<projects root>/.worktree`. This is set in T3 on the host, not in Bitig.
4. **Repositories are already cloned.** Bitig registers existing folders only; cloning through Bitig is planned in #BIT-150. Until then, the host owner clones each repository into its folder on the host.
5. **The connection may change projects.** T3 rejects `t3_project_create` and `t3_project_delete` with `capability_denied` unless the caller has full access. When connecting, Bitig requests every scope the host advertises in `scopes_supported`. It reads the protected-resource metadata first, then the authorization server's, and requests `mcp:tools` only if neither lists any. Grant full access on T3's consent screen. A connection made before this change only has `mcp:tools`. If registering fails with "Reconnect the T3 host with full access", disconnect and connect again in Settings.

## Registering a folder

There are two places to register a folder. Both are shown only to the organisation owner, and only while a host is connected.

- **New Project dialog:** the optional *Folder on T3 host* field. The project is created first, then the folder is registered. If registering fails, the project is kept and a notice explains why; retry from the project's T3 panel.
- **Project details → T3 panel:** *Folder on T3 host* → **Register**. For a project that is already linked, use **Unregister folder**.

What happens when you register:

1. Bitig validates the path. It must be absolute or start with `~/`. Relative paths, control characters, `.`/`..` segments and segments starting with `-` are rejected.
2. Bitig lists the selected host's T3 projects. If one is already registered at that exact path:
   - linked to no Bitig project on that host: Bitig links it and does not register it again. This also makes a retry safe.
   - linked to another Bitig project on that host: Bitig refuses.
3. Otherwise Bitig calls `t3_project_create` on that host with the path, and never asks T3 to create the folder. If the folder is missing, T3 refuses and Bitig shows T3's message.

Paths are compared exactly as written. Bitig can't know the host user's home directory, so `~/www/app` and `/home/dev/www/app` don't match. If T3 already lists a folder under its absolute path, enter that path.

## Unregistering a folder

**Unregister folder** calls `t3_project_delete` on the mapped host, then removes the link. The folder and its files stay on the host. Bitig refuses to unregister when:

- the project still has active T3 sessions (stop them first), or
- another Bitig project links the same T3 project on the same host (unlink that project in Settings instead).

T3 also refuses to delete a project that still has threads, unless *Also remove it if it still has T3 threads* is ticked.

## API

### Host and mapping management (writes require organisation `owner`; `editor` and `viewer` get `403`)

| Route | Body / query | Result |
| --- | --- | --- |
| `GET /api/t3/hosts` | — | `{ hosts: T3HostConnectionStatus[] }` |
| `GET /api/t3/hosts/:hostId` | — | `T3HostConnectionStatus` |
| `PATCH /api/t3/hosts/:hostId` | `{ label?, kind?, projectsRoot? }` | `T3HostConnectionStatus` |
| `DELETE /api/t3/hosts/:hostId` | — | `204`, or `409 { error: "host_busy" }` if the host has active/offline sessions |
| `GET /api/t3/connection` | `?hostId=<id>`, `?projectId=<id>`, or `?taskId=<id>` | `T3ConnectionStatus` for the resolved host |
| `DELETE /api/t3/connection` | `?hostId=<id>` (required when multiple hosts exist) | `204`, or `409 { error: "host_busy" }` if the host has active/offline sessions |
| `POST /api/t3/oauth/start` | `{ mcpUrl, hostId?, label?, kind?, projectsRoot? }` | `{ authorizationUrl, state }` |
| `GET /api/t3/projects` | `?hostId=<id>` (required when multiple hosts exist) | `{ projects: T3RemoteProject[] }` |
| `GET /api/t3/capabilities` | `?hostId=<id>`, `?projectId=<id>`, or `?taskId=<id>` | `{ capabilities: T3ModelCapability[] }` |
| `PUT /api/t3/mappings/:projectId` | `{ hostId?, t3ProjectId, t3ProjectTitle }` | `T3ProjectMapping` (`409 project_busy` when reattaching with active/offline sessions) |
| `DELETE /api/t3/mappings/:projectId` | — | `204` (`409 project_busy` when active/offline sessions exist) |
| `GET /api/t3/projects/:projectId/threads/:threadId/messages` | `?hostId=<id>&after=<pos>` | `ProjectT3ThreadMessagesResponse` (`400` if `threadId` exists on multiple hosts and `hostId` is omitted) |
| `POST /api/t3/projects/:projectId/threads/:threadId/messages` | `?hostId=<id>`, `{ body, modelSelection? }` | `201 ProjectT3Thread` |
| `POST /api/t3/projects/:projectId/threads/:threadId/settle` | `?hostId=<id>` | `204` |

### Host folder registration (owner-only; editors and viewers get `403`)

| Route | Body / query | Result |
| --- | --- | --- |
| `POST /api/t3/host-folders/check` | `{ "workspaceRoot": "~/www/app", "hostId"?: "..." }` | `{ hostId, workspaceRoot, t3Project?, mappedProjectId? }` |
| `PUT /api/t3/projects/:projectId/host-folder` | `{ "workspaceRoot": "/var/www/app", "hostId"?: "..." }` | `201 { mapping, created: true }`, or `200 { mapping, created: false }` when an existing registration was linked |
| `DELETE /api/t3/projects/:projectId/host-folder` | `?force=true` (optional) | `{ unregistered: true }`, or `{ unregistered: false }` when the project had no link |

Errors use `{ error, message }`. The `message` says what to do next.

| `error` | Status | Meaning |
| --- | --- | --- |
| `validation_error` | 400 | Invalid path, or no host connected / token expired |
| `project_already_mapped` | 409 | The project already links another T3 project or host |
| `folder_mapped_to_other_project` | 409 | The folder belongs to another Bitig project on that host |
| `project_busy` | 409 | Active sessions block unregistering |
| `host_busy` | 409 | Active sessions on the host block deleting the host |
| `t3_project_shared` | 409 | Another Bitig project links the same T3 project on that host |
| `t3_rejected` | 422 | T3 refused, e.g. the folder is missing |
| `t3_access_denied` | 502 | The connection lacks full access |
| `host_offline` | 503 | The host is unreachable |
| `host_timeout` | 504 | The host did not answer within 20 s |

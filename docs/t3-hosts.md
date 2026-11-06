# T3 hosts: prerequisites and folder registration

Bitig runs coding sessions on a T3 Code host that the organisation owner connects in **Settings**. This page covers what the host needs, and how Bitig registers project folders on it (#BIT-148). For the security model, see [`security.md`](security.md#6b-t3-code-access-from-bitig-oauth-mcp-client).

Only one host per organisation is supported for now. Support for several hosts is planned in #BIT-147.

## Host prerequisites

The operator prepares the host before the owner connects it:

1. **T3 Code is installed and running.** Its `/mcp` endpoint is reachable from the Bitig Worker over HTTPS. Loopback is allowed only in local development. If the host is behind Cloudflare Access, set `T3_CF_ACCESS_CLIENT_ID` and `T3_CF_ACCESS_CLIENT_SECRET` on the Worker.
2. **A projects root exists:**
   - `/var/www` on managed containers
   - `~/www` on user-owned hosts

   The UI suggests `<projects root>/<project name>`, but the owner may enter any absolute or `~/` path.
3. **Worktrees are configured** under `<projects root>/.worktree`. This is set in T3 on the host, not in Bitig.
4. **Repositories are already cloned.** Bitig registers existing folders only; cloning through Bitig is planned in #BIT-150. Until then, the host owner clones each repository into its folder on the host.
5. **The connection may change projects.** T3 rejects `t3_project_create` and `t3_project_delete` with `capability_denied` unless the caller has full access. When connecting, Bitig requests every scope the host advertises in `scopes_supported`. It reads the protected-resource metadata first, then the authorization server's, and requests `mcp:tools` only if neither lists any. Grant full access on T3's consent screen. A connection made before this change only has `mcp:tools`. If registering fails with "Reconnect the T3 host with full access", disconnect and connect again in Settings.

## Registering a folder

There are two places to register a folder. Both are shown only to the organisation owner, and only while a host is connected.

- **New Project dialog:** the optional *Folder on T3 host* field. The project is created first, then the folder is registered. If registering fails, the project is kept and a notice explains why; retry from the project's T3 panel.
- **Project details → T3 panel:** *Folder on T3 host* → **Register**. For a project that is already linked, use **Unregister folder**.

What happens when you register:

1. Bitig validates the path. It must be absolute or start with `~/`. Relative paths, control characters, `.`/`..` segments and segments starting with `-` are rejected.
2. Bitig lists the host's T3 projects. If one is already registered at that exact path:
   - linked to no Bitig project: Bitig links it and does not register it again. This also makes a retry safe.
   - linked to another Bitig project: Bitig refuses.
3. Otherwise Bitig calls `t3_project_create` with the path, and never asks T3 to create the folder. If the folder is missing, T3 refuses and Bitig shows T3's message.

Paths are compared exactly as written. Bitig can't know the host user's home directory, so `~/www/app` and `/home/dev/www/app` don't match. If T3 already lists a folder under its absolute path, enter that path.

## Unregistering a folder

**Unregister folder** calls `t3_project_delete`, then removes the link. The folder and its files stay on the host. Bitig refuses to unregister when:

- the project still has active T3 sessions (stop them first), or
- another Bitig project links the same T3 project (unlink that project in Settings instead).

T3 also refuses to delete a project that still has threads, unless *Also remove it if it still has T3 threads* is ticked.

## API

All routes are owner-only. Editors and viewers get `403`.

| Route | Body / query | Result |
| --- | --- | --- |
| `POST /api/t3/host-folders/check` | `{ "workspaceRoot": "~/www/app" }` | `{ workspaceRoot, t3Project?, mappedProjectId? }` |
| `PUT /api/t3/projects/:projectId/host-folder` | `{ "workspaceRoot": "/var/www/app" }` | `201 { mapping, created: true }`, or `200 { mapping, created: false }` when an existing registration was linked |
| `DELETE /api/t3/projects/:projectId/host-folder` | `?force=true` (optional) | `{ unregistered: true }`, or `{ unregistered: false }` when the project had no link |

Errors use `{ error, message }`. The `message` says what to do next.

| `error` | Status | Meaning |
| --- | --- | --- |
| `validation_error` | 400 | Invalid path, or no host connected / token expired |
| `project_already_mapped` | 409 | The project already links another T3 project |
| `folder_mapped_to_other_project` | 409 | The folder belongs to another Bitig project |
| `project_busy` | 409 | Active sessions block unregistering |
| `t3_project_shared` | 409 | Another Bitig project links the same T3 project |
| `t3_rejected` | 422 | T3 refused, e.g. the folder is missing |
| `t3_access_denied` | 502 | The connection lacks full access |
| `host_offline` | 503 | The host is unreachable |
| `host_timeout` | 504 | The host did not answer within 20 s |

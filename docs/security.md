# Bitig Security Architecture & Audit Report

## 1. Threat Model & Overview

Bitig is an edge-ready task and project manager deployed on local filesystems and Cloudflare Workers (edge compute + D1 storage). Security controls are enforced at every domain and protocol boundary.

### Trust Boundaries
1. **Local CLI / STDIO MCP:** Trusted local user executing on local filesystem. Isolation enforced via POSIX file permissions (`0700` directories) and advisory locking.
2. **Cloudflare Worker (HTTP REST & Streamable MCP):** Public internet facing. Guarded by TLS, HMAC-signed dashboard session cookies, constant-time Basic Auth, constant-time Bearer token auth, sliding-window rate limiting, and CSRF protection.

---

## 2. Authentication & Credential Handling

### 2.1 Constant-Time String Comparison
All authentication mechanisms (HTTP Basic Auth for REST API, Bearer Token for remote MCP) utilize cryptographic constant-time comparison via Web Crypto `crypto.subtle.timingSafeEqual`:

- Passwords and tokens are hashed with SHA-256 before comparison to prevent string length side-channel leakage.
- Without a valid dashboard session or Basic credentials, protected API requests are rejected. MCP requests require a matching legacy secret or an active managed credential; no configured or stored matching credential means `401 Unauthorized`.
- Credentials and secrets are never logged or exposed in client error payloads.

### 2.2 Remote MCP Tokens
`/mcp` continues to accept two separate legacy environment secrets:

- `Authorization: Bearer <MCP_AUTH_TOKEN>` for clients that can send headers (Claude Code, the CLI, scripts).
- `/mcp?token=<MCP_URL_TOKEN>` for clients that cannot, such as ChatGPT connectors set to "No authentication". The URL token is checked only when the request has no `Authorization` header, and the header token is never accepted in the URL. Leave `MCP_URL_TOKEN` empty to turn this off.

A token in a URL leaks more easily than a header: Cloudflare's request logs record the full URL, and the client stores it as part of the connector address. The URL token is a separate secret so it can be rotated (`wrangler secret put MCP_URL_TOKEN`) without breaking header clients. Bitig's own logging records only the path. This is a stopgap until `/mcp` supports OAuth.

#### Managed per-client credentials

In Cloudflare storage mode, **Settings → MCP Tokens** generates separately named credentials for clients connecting to Bitig. These are not credentials issued by external MCP servers. Each credential grants the same full MCP access as a legacy token; labels are not authorization scopes. Choose Bearer headers whenever possible. A generated credential is bound to either Bearer or query transport, never both; an `Authorization` header always takes precedence over a query token, even if that header is invalid.

- Generation uses 32 cryptographically random bytes. D1 stores only the SHA-256 digest, metadata, optional expiry, and revocation timestamp. The random secret cannot be recovered from the database or listed by the API.
- The authenticated creation response reveals the secret once with `Cache-Control: no-store`. The browser keeps it only in the mounted MCP tab, clears it on dismissal or navigation, and never saves it in local/session storage. Copying writes it to the system clipboard, where it remains under the user's control; save it securely and clear the clipboard when appropriate.
- `GET /api/mcp-tokens` lists metadata; `POST /api/mcp-tokens` creates one credential; `DELETE /api/mcp-tokens/:id` idempotently revokes that generated credential. All routes require dashboard-session or Basic authentication and use existing CSRF/rate-limit middleware. An MCP credential cannot manage credentials. Inputs and request size are bounded, creation is atomically limited to 100 active credentials, and listings include all active credentials plus recent inactive history up to 200 rows. Revoked/expired records are retained; expiry also frees active capacity.
- Revocation and expiry are checked from D1 on each managed-token request; no acceptance cache delays revocation. They affect subsequent requests, not operations already authenticated. A storage failure rejects managed-token verification with a sanitized `503`, without recording it as an authentication failure or logging database errors containing parameters.
- The UI offers no rotation/revocation action for `MCP_AUTH_TOKEN` or `MCP_URL_TOKEN`. Their environment values are never read into the UI, migrated, or overwritten. Legacy authentication runs first and needs no managed-token table, so those clients continue working even before migration or during token-storage failure. Managed credentials also work when legacy secrets are empty.
- Do not automatically retry a creation after an interrupted request: it may have committed without delivering the secret. Reload the list, identify and revoke any credential whose secret was not received, then create a replacement. Never reuse the original client label as a substitute for the credential ID when revoking.

Migration `0017_mcp_tokens.sql` is additive. Apply it through the established local/production migration process before using managed credentials; production migration and deployment require operator authorization. This change does not rotate either legacy secret. Without that migration, management/managed verification return safe unavailable errors while matching legacy credentials remain usable.

### 2.3 Dashboard Sessions, Email Codes & Multi-User Tenancy
In Cloudflare storage mode, the dashboard supports multi-user accounts and organisation-scoped tenancy:

- **One-Time Email Codes (Cloudflare Email Sending):** `POST /api/auth/code` and `POST /api/auth/register` generate a 6-digit verification code, store only its SHA-256 hash in `auth_codes` with a 10-minute TTL and a 5-attempt cap, and deliver the email via Cloudflare Email Sending (`env.EMAIL.send` with `EMAIL_FROM`). `POST /api/auth/verify` verifies the code in constant time, creates or updates the user in `users`, and creates a server-side session row in `sessions`.
- **Server-Side Sessions:** A successful login sets a `__Host-bitig_session` cookie (`HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, valid for 30 days) backed by a server-side row in `sessions` (storing only the SHA-256 token hash, user ID, user agent, IP, and expiry). Users can inspect and revoke individual device sessions at `/settings/security`, and account deletion or disabling immediately revokes all sessions and disconnects active WebSockets.
- **Per-User Personal Access Tokens (`btg_...`):** Users can generate organisation-scoped access tokens in `/settings/security` (`POST /api/me/tokens`). Only the SHA-256 digest and prefix are stored in `access_tokens`. Tokens inherit the user's live membership role (`owner`, `editor`, `viewer`) in the target organisation.
- **Organisation Isolation & RBAC:** Every project, task, comment, checkpoint, attachment, webhook, and T3 host belongs to an organisation (`org_id`). Non-members receive `404 Not Found` so organisation, project, and host existence is never leaked across tenants. Viewers are restricted to read-only operations (`403 Forbidden` on mutations), editors can update projects and create/update tasks, comments, and webhooks as well as execute T3 runs on mapped projects, and only organisation `owner`s can create, import, or delete projects, connect/configure/disconnect T3 hosts, manage project-to-host mappings, or manage members, invitations, backup restores, and organisation settings (#BIT-149). Platform `admin` status never grants organisation `owner` privileges.
- **Soft-Delete Lifecycle:** Deleting a user account or organisation performs a soft-delete (`deleted_at` timestamp), revokes active sessions and tokens, and frees unique identifiers (`email`, `username`, `slug`) while preserving referential integrity.
- **Nostr Sign-In:** `POST /api/auth/challenge` creates an unpredictable five-minute nonce in a dedicated Durable Object, bound to the Worker's origin. The browser asks its NIP-07 extension to sign the explicit Bitig login event and submits it to `POST /api/auth/nostr`.
- The Worker verifies the event signature and exact origin/action/challenge tags, then atomically consumes the nonce. Expired, wrong-origin and replayed challenges fail.
- **Open Nostr Registration:** Any key with a valid signature can register. A new Nostr account is an ordinary platform `user` with no organisation, so it goes through onboarding like an email account. Only keys in `NOSTR_AUTH_PUBKEYS` are created as platform admins and owners of the default organisation. Existing accounts keep their role: removing a key from the allowlist does not demote it, so do that in the admin panel. New non-allowlisted accounts are capped at 10 per IP per hour.
- **Nostr Profile Fetch:** After a Nostr sign-in, and on `POST /api/me/nostr/sync` (10 per account per 15 minutes), the Worker reads the account's latest kind-0 metadata from `NOSTR_PROFILE_RELAYS` (default: a fixed list of public relays) within a 5-second budget.
  - Relay data is untrusted: only events signed by the account's own key are used, the display name is stripped of control and bidi characters and length-limited, and only `https://` avatar URLs are accepted.
  - A NIP-05 identifier is stored only after `https://<domain>/.well-known/nostr.json?name=<local>` maps it to the same key; redirects are not followed.
  - The fetch only fills empty fields (the generated `Nostr (…)` display name, a missing avatar, a missing NIP-05). It runs after the sign-in response, so slow or failing relays never block sign-in.
- No credential is stored in browser storage; JavaScript never sees the session cookie.
- `/api/*` 401 responses do not carry `WWW-Authenticate: Basic`, so browsers never show their native prompt.
- Failed logins and invalid verification codes count toward the failed-login budget (section 3.1). Login requests pass the same CSRF check as other mutations, and `SameSite=Strict` keeps the cookie off cross-site requests.
- Realtime WebSocket upgrades (`GET /api/realtime`, backed by the `RealtimeHub` Durable Object) require a valid session or token and scope broadcasts strictly to the authenticated organisation (`orgId`).

---

## 3. Rate Limiting Architecture

A sliding-window rate limiter is implemented at the Cloudflare Worker edge. Counters live in a SQLite-backed Durable Object (`RateLimiter`, binding `RATE_LIMITER`), one object per policy and client IP (`cf-connecting-ip`). This makes the limits global across Worker isolates and keeps them across object eviction; an alarm deletes an object's storage once its window has passed.

### 3.1 Rate Limit Tiers
- **Authentication Failure Protection:** Max 10 failed login attempts per 15 minutes per IP. Mitigates brute-force attacks against the dashboard login, Basic Auth and MCP tokens.
  - Nostr proof (`/api/auth/nostr`), Basic Auth (`/api/*`) and Bearer or URL token (`/mcp`) failures share one budget per IP.
  - Only attempts that present credentials count (invalid/unauthorized signatures or wrong tokens). Requests without credentials, such as the dashboard's session check before sign-in, do not, and neither do expired session cookies.
  - Once the budget is used up, every request from that IP to `/api/*` and `/mcp` gets `429` before credentials are checked, including requests with valid credentials, until the window passes. Other clients are not affected. A successful login does not reset the counter.
- **REST API Routes (`/api/*`):** Max 1,000 requests per minute per IP.
- **MCP Endpoint (`/mcp`):** Max 1,000 requests per minute per IP.

### 3.2 Response Headers
Standard rate limiting headers are returned on all evaluated requests:
- `RateLimit-Limit`: Maximum requests permitted in current window.
- `RateLimit-Remaining`: Remaining request quota.
- `RateLimit-Reset`: Seconds remaining until quota renewal.
- On HTTP `429 Too Many Requests`: `Retry-After: <seconds>` is sent.

### 3.3 Limiter Failure Behavior
If the `RateLimiter` Durable Object cannot be reached, the error is logged and the request is allowed (fail open). Authentication still runs on every request, and an outage of the limiter must not lock the owner out of their data.

---

## 4. Cross-Site Request Forgery (CSRF) & CORS

### 4.1 CORS Enforcement
- Cross-origin resource sharing (`CORS`) is locked down to explicit origins configured in `ALLOWED_ORIGINS`.
- Requests from untrusted origins are denied cross-origin access.

### 4.2 CSRF Defense in Depth
State-mutating HTTP methods (`POST`, `PATCH`, `DELETE`, `PUT`) are subject to multi-layered CSRF verification:
1. **Origin Verification:** Checked against worker self-origin and `ALLOWED_ORIGINS`.
2. **Referer Verification:** If Origin is omitted, Referer host is validated. An unparsable Referer is rejected.
3. **Fetch Metadata:** If both are omitted, a request with `Sec-Fetch-Site: cross-site` is rejected.
4. **Form-Encoded Blocking:** If both are omitted, requests carrying `application/x-www-form-urlencoded`, `multipart/form-data`, or `text/plain` that could be triggered by unauthorized browser forms are strictly rejected with HTTP `403 Forbidden`.

Any rejection returns HTTP `403 Forbidden`. The server does not check for a custom header: `ApiStorage` sends `X-Bitig-Request: true`, but the middleware does not require it.

### 4.3 Requests Without Origin or Referer
A mutating request that has neither header, is not marked cross-site, and does not use a form content type (for example `Content-Type: application/json`) passes the CSRF check. This is deliberate: the CLI, MCP clients, scripts and `curl` do not send `Origin`, and they must be able to call the API.

This does not open a CSRF hole:
- Browsers send `Origin` on cross-origin `POST`, `PATCH`, `PUT` and `DELETE` requests, so a forged request from another site is caught by step 1.
- A cross-site browser request that could skip the CORS preflight must use a form content type, which step 4 rejects. A JSON request from another origin triggers a preflight, which CORS denies for origins not on the allowlist.
- Every request still needs a valid session cookie or Basic Auth credentials, and failed logins are rate-limited (section 3).

What remains is a non-browser client that already holds valid credentials. That client is the account owner, not a CSRF attacker, so it is accepted.

---

## 5. Filesystem & Path Traversal Protections

### 5.1 UUIDv7 Path Validation
In local mode (`storage-markdown`), files are stored as:
`~/.local/share/bitig/<projectId>/<taskId>.md`

- Both `<projectId>` and `<taskId>` are validated against `IdSchema = z.uuidv7()`.
- Paths containing `../`, null bytes, slashes, or non-hex characters are rejected before touching filesystem APIs.
- The `FileSystemPort` implementation (`NodeFileSystem`) enforces that all resolved canonical paths remain within `rootDir`.

### 5.2 Concurrency & Advisory Locking
- Workspace operations acquire advisory file locks with PID tracking.
- Stale locks from crashed processes are automatically reclaimed using PID liveness checks.

---

## 6a. Execution Checkpoints

Checkpoints hold working notes written by agents, so treat them as sensitive and as untrusted input.

**What is enforced**
- Routes sit behind the same `/api/*` session or Basic Auth, CSRF and rate-limit middleware as every other mutation, and `/mcp` behind its Bearer token; there is no unauthenticated path.
- Input is validated by one Zod schema on every path (REST, MCP, storage): strict objects, bounded lengths and counts, flat metadata only, no nested objects. The URL step segment must be plain digits.
- Storage paths are built only from validated UUIDs and integers; snapshot text never reaches a file name or query.
- Saving a checkpoint cannot approve, unblock or move a task. `resume_from_checkpoint` derives the gates from live task state, so a stale snapshot cannot hide a pending approval, a `needsHuman` question or an unfinished dependency.

**What is not**
- **Confidentiality at rest.** Markdown and D1 store snapshots unencrypted, like task descriptions. Do not put secrets in a snapshot; nothing scans for them.
- **Prompt injection.** A resumed snapshot is text an earlier session wrote, possibly after reading untrusted content. Agents should treat `nextStepInstructions` as notes to verify against the task, not as authority.
- **Attribution and integrity.** A checkpoint does not record which agent wrote it, and any holder of a valid token can overwrite any step of any task. Writes are last-write-wins with no versioning.
- **Visibility.** Checkpoints are not broadcast as realtime events and no dashboard screen shows them yet; they are reachable only through the authenticated REST routes and MCP tools.

---

## 6b. T3 Code Access from Bitig (OAuth MCP Client)

Bitig can connect to a user-authorized T3 Code `/mcp` server to launch, inspect, message, and interrupt coding threads for tasks.

**What is enforced**
- **OAuth 2.1 with PKCE (`S256`):** Starting a connection (`POST /api/t3/oauth/start`, guarded by `apiAuth()` and `csrfProtection()`) discovers the T3 host's metadata (`/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`), registers an ephemeral public client (`token_endpoint_auth_method: "none"`), requests every scope the host advertises in `scopes_supported` (falling back to `mcp:tools`, #BIT-148), and generates a single-use 256-bit `state` and PKCE `code_verifier` stored in D1 (`t3_oauth_states`) with a 10-minute TTL.
- **Cross-site Callback Verification:** Because `__Host-bitig_session` uses `SameSite=Strict`, top-level browser redirects from the T3 host to `GET /api/t3/oauth/callback` do not carry the session cookie. The callback authenticates the flow by atomically consuming the single-use `state` record and verifying the PKCE `code_verifier` against the T3 token endpoint.
- **Encryption at Rest (`AES-256-GCM`):** Issued bearer tokens are encrypted using Web Crypto `AES-256-GCM` with a random 96-bit IV per write, keyed by SHA-256 of the Worker secret `T3_ENCRYPTION_KEY` (minimum 32 characters). Plaintext tokens are never returned by any API endpoint or written to D1 in clear text.
- **Cloudflare Access Service Token Support:** When `T3_CF_ACCESS_CLIENT_ID` and `T3_CF_ACCESS_CLIENT_SECRET` secrets are set on the Worker, all server-to-server OAuth discovery, registration, token exchange, and MCP requests automatically attach `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers so the T3 host can be protected behind a Cloudflare Access `Service Auth` policy.
- **Strict Tool Allowlist:** `T3McpClient` enforces `T3_ALLOWED_MCP_TOOLS` (`t3_project_list`, `t3_project_create`, `t3_project_delete`, `orchestrator_capabilities`, `t3_thread_list`, `t3_thread_launch`, `t3_thread_read`, `t3_pending_request`, `t3_thread_send`, `t3_thread_interrupt`, `t3_thread_organize`, `t3_thread_configure`). `t3_thread_configure` only switches a thread's model, and only when a person replies with a new model while the thread waits or has finished its turn (#BIT-119); permission modes are never changed. Bitig never calls `t3_project_update` or `t3_project_clone`.
- **Host Folder Registration (#BIT-148):** `t3_project_create` and `t3_project_delete` are only used to register an existing host folder as a T3 project and to unregister it, through owner-only routes (`POST /api/t3/host-folders/check`, `PUT`/`DELETE /api/t3/projects/:projectId/host-folder`; editors and viewers get `403`). Bitig never creates, moves or deletes files on the host:
  - `t3_project_create` is always sent an explicit `workspaceRoot` (without one, T3 creates a new repository) and never `createWorkspaceRootIfMissing`, so a missing folder fails instead of being created.
  - `t3_project_delete` leaves the folder on disk. `force` is sent only when the owner ticks it in the UI (`?force=true`).
  - Paths are validated on the server by `HostFolderPathSchema` (`@bitig/core`): absolute or `~/` only, at most 1024 characters, no control characters, no `.`/`..` or empty segments, and no segment starting with `-`, so a value can never be read as a command-line option.
  - Every T3 call is bounded by `T3_PROJECT_OPERATION_TIMEOUT_MS` (20 s) and cancelled when the browser request is aborted.
  - Retries are idempotent: a folder T3 already lists, and no Bitig project links, is linked instead of registered again; a folder linked to another Bitig project is refused (`409`).
  - Unregistering is refused while the project has active or offline T3 sessions, or when another Bitig project links the same T3 project.
  - Host prerequisites are listed in [`t3-hosts.md`](t3-hosts.md).
- **Owner-Only Host Administration & Host-Scoped Execution (#BIT-149):**
  - Connecting or reauthorising a host (`POST /api/t3/oauth/start`), updating or disconnecting a host (`PATCH`/`DELETE /api/t3/hosts/:hostId`, `DELETE /api/t3/connection`), managing project mappings (`PUT`/`DELETE /api/t3/mappings/:projectId`), and creating/importing/deleting projects (`POST /api/projects`, `POST /api/projects/import`, `DELETE /api/projects/:id`, and MCP `create_project`/`delete_project`) require the organisation `owner` role (`403` for `editor` and `viewer`). Reauthorising an existing `hostId` must match its recorded `mcpUrl`.
  - Organisation `editor`s can launch and control task runs and project threads on already-mapped projects (including MCP `start_t3_thread` and `report_t3_git_metadata`, which reject `viewer`s with `403`) without access to host management or encrypted tokens.
  - Every execution operation (launch, capability discovery, live status sync, follow-up replies, pending question/approval responses, model switching, stop, settlement, and project-thread reads/messages) validates organisation/project/task ownership and routes strictly to the project or session's recorded `hostId` without cross-host fallback. Disconnected, unreachable, or expired hosts return host-specific actionable errors (`400`/`502`), and identical remote `threadId`s across multiple hosts are isolated by `hostId`.
  - Disconnecting a host, detaching/replacing a project mapping, unregistering a host folder, or deleting a project is refused (`409` `host_busy` / `project_busy`) while active or offline sessions exist, and never touches files on the host (#BIT-146).
- **Launch & Status Gates:** Starting a T3 thread (via `POST /api/tasks/:id/t3-run` or the `start_t3_thread` MCP tool) is refused while `pendingApproval: true`, while any task in `dependsOn` is unfinished, when the project has no T3 mapping, or when the T3 OAuth token is missing or expired. Live thread status checks (`GET /api/tasks/:id/t3-run`) update `agent_runs.state` only and never auto-transition a Bitig task to `done` or `archived`.

---

## 7. HTTP Security Headers

The following edge headers are enforced across all Worker endpoints:
- `Strict-Transport-Security`: `max-age=63072000; includeSubDomains`
- `X-Frame-Options`: `DENY`
- `X-Content-Type-Options`: `nosniff`
- `Referrer-Policy`: `no-referrer`
- `Content-Security-Policy`: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`

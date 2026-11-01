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
- If no credentials are configured in environment secrets (`BASIC_AUTH_PASS`, `MCP_AUTH_TOKEN`, `MCP_URL_TOKEN`), all incoming requests are rejected by default with `401 Unauthorized`.
- Credentials and secrets are never logged or exposed in client error payloads.

### 2.2 Remote MCP Tokens
`/mcp` accepts two separate secrets:

- `Authorization: Bearer <MCP_AUTH_TOKEN>` for clients that can send headers (Claude Code, the CLI, scripts).
- `/mcp?token=<MCP_URL_TOKEN>` for clients that cannot, such as ChatGPT connectors set to "No authentication". The URL token is checked only when the request has no `Authorization` header, and the header token is never accepted in the URL. Leave `MCP_URL_TOKEN` empty to turn this off.

A token in a URL leaks more easily than a header: Cloudflare's request logs record the full URL, and the client stores it as part of the connector address. The URL token is a separate secret so it can be rotated (`wrangler secret put MCP_URL_TOKEN`) without breaking header clients. Bitig's own logging records only the path. This is a stopgap until `/mcp` supports OAuth.

### 2.3 Dashboard Sessions
The dashboard signs in on its own `/login` page with an allowlisted NIP-07 identity:

- `POST /api/auth/challenge` creates an unpredictable five-minute nonce in a dedicated Durable Object, bound to the Worker's origin. The browser asks its NIP-07 extension to sign the explicit Bitig login event and submits it to `POST /api/auth/nostr`.
- The Worker verifies the event signature, exact origin/action/challenge tags and the `NOSTR_AUTH_PUBKEYS` allowlist, then atomically consumes the nonce. Expired, wrong-origin and replayed challenges fail.
- A successful proof sets a `__Host-bitig_session` cookie: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, valid for 7 days. The stateless value is `<expiry>:<pubkey>`, signed with HMAC-SHA256 under `SESSION_SECRET`; rotation signs everyone out.
- Without `SESSION_SECRET` or an allowed public key, login answers `503`; Basic Auth API access keeps working.
- No credential is stored in browser storage; JavaScript never sees the cookie.
- `/api/*` 401 responses no longer carry `WWW-Authenticate: Basic`, so browsers never show their native prompt. Scripts can still send `Authorization: Basic`.
- Failed logins and cookies with a forged signature count toward the failed-login budget (section 3.1). Login requests pass the same CSRF check as other mutations, and `SameSite=Strict` keeps the cookie off cross-site requests.
- Realtime WebSocket upgrades (`GET /api/realtime`, backed by the `RealtimeHub` Durable Object) require the same session cookie or Basic Auth credentials (`apiAuth()`) and verify that any `Origin` header matches the Worker's origin or `ALLOWED_ORIGINS`, blocking cross-site WebSocket hijacking.

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
- **OAuth 2.1 with PKCE (`S256`):** Starting a connection (`POST /api/t3/oauth/start`, guarded by `apiAuth()` and `csrfProtection()`) discovers the T3 host's metadata (`/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`), registers an ephemeral public client (`token_endpoint_auth_method: "none"`), and generates a single-use 256-bit `state` and PKCE `code_verifier` stored in D1 (`t3_oauth_states`) with a 10-minute TTL.
- **Cross-site Callback Verification:** Because `__Host-bitig_session` uses `SameSite=Strict`, top-level browser redirects from the T3 host to `GET /api/t3/oauth/callback` do not carry the session cookie. The callback authenticates the flow by atomically consuming the single-use `state` record and verifying the PKCE `code_verifier` against the T3 token endpoint.
- **Encryption at Rest (`AES-256-GCM`):** Issued bearer tokens are encrypted using Web Crypto `AES-256-GCM` with a random 96-bit IV per write, keyed by SHA-256 of the Worker secret `T3_ENCRYPTION_KEY` (minimum 32 characters). Plaintext tokens are never returned by any API endpoint or written to D1 in clear text.
- **Strict Tool Allowlist & Read-Only Project Mapping:** `T3McpClient` enforces `T3_ALLOWED_MCP_TOOLS` (`t3_project_list`, `orchestrator_capabilities`, `t3_thread_launch`, `t3_thread_read`, `t3_pending_request`, `t3_thread_send`, `t3_thread_interrupt`). Bitig never calls `t3_project_create`, `t3_project_update`, `t3_project_delete`, or `t3_project_clone`; projects are mapped read-only to existing T3 workspaces.
- **Launch & Status Gates:** Starting a T3 thread (via `POST /api/tasks/:id/t3-run` or the `start_t3_thread` MCP tool) is refused while `pendingApproval: true`, while any task in `dependsOn` is unfinished, when the project has no T3 mapping, or when the T3 OAuth token is missing or expired. Live thread status checks (`GET /api/tasks/:id/t3-run`) update `agent_runs.state` only and never auto-transition a Bitig task to `done` or `archived`.

---

## 7. HTTP Security Headers

The following edge headers are enforced across all Worker endpoints:
- `Strict-Transport-Security`: `max-age=63072000; includeSubDomains`
- `X-Frame-Options`: `DENY`
- `X-Content-Type-Options`: `nosniff`
- `Referrer-Policy`: `no-referrer`
- `Content-Security-Policy`: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`


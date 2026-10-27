# Bitig Security Architecture & Audit Report

## 1. Threat Model & Overview

Bitig is an edge-ready task and project manager deployed across local filesystems, Cloudflare Workers (edge compute + D1 storage), and decentralized Nostr networks. Security controls are enforced at every domain and protocol boundary.

### Trust Boundaries
1. **Local CLI / STDIO MCP:** Trusted local user executing on local filesystem. Isolation enforced via POSIX file permissions (`0700` directories) and advisory locking.
2. **Cloudflare Worker (HTTP REST & Streamable MCP):** Public internet facing. Guarded by TLS, HMAC-signed dashboard session cookies, constant-time Basic Auth, constant-time Bearer token auth, sliding-window rate limiting, and CSRF protection.
3. **Nostr Relays:** Untrusted relay nodes. Cleartext is never sent for private tasks; NIP-44 authenticated encryption with ChaCha20-Poly1305 is used for task payloads.

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
The dashboard signs in on its own `/login` page instead of the browser's native Basic Auth prompt:

- `POST /api/auth/login` takes `{ username, password }` (JSON), checks them against `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` in constant time, and sets a `__Host-bitig_session` cookie: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, valid for 7 days. `GET /api/auth/session` reports the signed-in user; `POST /api/auth/logout` clears the cookie.
- The cookie is stateless: `<expiry>:<user>` signed with HMAC-SHA256 under `SESSION_SECRET` (a Worker secret, at least 32 characters). The Worker rejects cookies with a bad signature, a past expiry, or a user other than `BASIC_AUTH_USER`. Rotating `SESSION_SECRET` signs everyone out. Logout clears the cookie in the browser; a copied cookie stays valid until it expires or the secret rotates.
- Without `SESSION_SECRET`, login answers `503` and the dashboard says so; Basic Auth API access keeps working.
- No credential is stored in browser storage; JavaScript never sees the cookie.
- `/api/*` 401 responses no longer carry `WWW-Authenticate: Basic`, so browsers never show their native prompt. Scripts can still send `Authorization: Basic`.
- Failed logins and cookies with a forged signature count toward the failed-login budget (section 3.1). Login requests pass the same CSRF check as other mutations, and `SameSite=Strict` keeps the cookie off cross-site requests.
- Realtime WebSocket upgrades (`GET /api/realtime`, backed by the `RealtimeHub` Durable Object) require the same session cookie or Basic Auth credentials (`apiAuth()`) and verify that any `Origin` header matches the Worker's origin or `ALLOWED_ORIGINS`, blocking cross-site WebSocket hijacking.

---

## 3. Rate Limiting Architecture

A sliding-window rate limiter is implemented at the Cloudflare Worker edge. Counters live in a SQLite-backed Durable Object (`RateLimiter`, binding `RATE_LIMITER`), one object per policy and client IP (`cf-connecting-ip`). This makes the limits global across Worker isolates and keeps them across object eviction; an alarm deletes an object's storage once its window has passed.

### 3.1 Rate Limit Tiers
- **Authentication Failure Protection:** Max 10 failed login attempts per 15 minutes per IP. Mitigates brute-force attacks against the dashboard login, Basic Auth and MCP tokens.
  - Login (`/api/auth/login`), Basic Auth (`/api/*`) and Bearer or URL token (`/mcp`) failures share one budget per IP.
  - Only attempts that present credentials count (wrong password or token, malformed or wrong-scheme `Authorization` header). Requests without credentials, such as the dashboard's session check before sign-in, do not, and neither do expired session cookies.
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

## 6. Nostr Privacy & Cryptographic Analysis

### 6.1 Private Task Payload Encryption (NIP-44)
- **Encryption Scheme:** NIP-44 self-encryption (ChaCha20-Poly1305 with HKDF key derivation).
- **Encrypted Fields:** Task title and description are packed into a JSON payload and encrypted before broadcast.
- **Metadata Visibility:** Relays can observe event kinds (30001), tags (`status`, `priority`, `dueDate`, `order`, `labels`), and timestamps (`created_at_iso`). Users requiring zero metadata exposure should run Local or Cloudflare D1 mode.

### 6.2 Checkpoint Events (kind 30335)
- Checkpoint content (step index, status and the whole snapshot) is always NIP-44 self-encrypted, whatever the task's `is_public`, and none of it appears in tags.
- **Metadata Visibility:** relays see the event kind, the task a checkpoint belongs to (`a` and `task` tags), its creation time and how often it is rewritten. They cannot see the step, status or text.

---

## 6a. Execution Checkpoints

Checkpoints hold working notes written by agents, so treat them as sensitive and as untrusted input.

**What is enforced**
- Routes sit behind the same `/api/*` session or Basic Auth, CSRF and rate-limit middleware as every other mutation, and `/mcp` behind its Bearer token; there is no unauthenticated path.
- Input is validated by one Zod schema on every path (REST, MCP, storage): strict objects, bounded lengths and counts, flat metadata only, no nested objects. The URL step segment must be plain digits.
- Storage paths and Nostr tags are built only from validated UUIDs and integers; snapshot text never reaches a file name, query or tag.
- Saving a checkpoint cannot approve, unblock or move a task. `resume_from_checkpoint` derives the gates from live task state, so a stale snapshot cannot hide a pending approval, a `needsHuman` question or an unfinished dependency.

**What is not**
- **Confidentiality at rest.** Markdown (plain JSON in the data directory) and D1 store snapshots unencrypted, like task descriptions. Only Nostr mode encrypts them. Do not put secrets in a snapshot; nothing scans for them.
- **Prompt injection.** A resumed snapshot is text an earlier session wrote, possibly after reading untrusted content. Agents should treat `nextStepInstructions` as notes to verify against the task, not as authority.
- **Attribution and integrity.** A checkpoint does not record which agent wrote it, and any holder of a valid token can overwrite any step of any task. Writes are last-write-wins with no versioning.
- **Visibility.** Checkpoints are not broadcast as realtime events and no dashboard screen shows them yet; they are reachable only through the authenticated REST routes and MCP tools.

---

## 7. HTTP Security Headers

The following edge headers are enforced across all Worker endpoints:
- `Strict-Transport-Security`: `max-age=63072000; includeSubDomains`
- `X-Frame-Options`: `DENY`
- `X-Content-Type-Options`: `nosniff`
- `Referrer-Policy`: `no-referrer`
- `Content-Security-Policy`: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`


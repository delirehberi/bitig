# BIT-103 Dual Login Repair Plan

- `BIT-103` — Restore username/password dashboard login alongside NIP-07 Nostr login.
- Restore the validated, rate-limited password session route and expose both sign-in methods in the web UI.
- Validate existing session cookies against either the configured Basic username or the Nostr public-key allowlist.
- Preserve single-use, origin-bound Nostr challenges and improve configuration-error reporting without exposing secrets.
- Add Worker and web tests for both methods, invalid credentials, unauthorized keys, stale sessions, replay protection, and 503 responses.
- Run `make check`, then separately configure and deploy the approved production Nostr public key; do not commit or deploy without explicit authorization.

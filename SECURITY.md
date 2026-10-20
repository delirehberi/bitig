# Security Policy

## Architecture & Security Model

Bitig enforces strict validation, authentication, rate limiting, and encryption boundaries across its Local Markdown, Cloudflare Worker (D1 + Hono), and Nostr storage modes. For the complete threat model, authentication specifications, CSRF defenses, and NIP-44 encryption details, see [`docs/security.md`](./docs/security.md).

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Instead, please report vulnerabilities privately using [GitHub Private Vulnerability Reporting](https://github.com/delirehberi/bitig/security/advisories/new) on this repository.

When reporting a vulnerability, please include:
- A clear description of the issue and the affected package or app (`@bitig/core`, `@bitig/storage-markdown`, `@bitig/worker`, etc.).
- Steps to reproduce or a minimal proof-of-concept.
- The potential impact and deployment mode affected (`local`, `cloudflare`, or `nostr`).

We will acknowledge receipt of your report within 72 hours and work with you to validate and remediate the issue before public disclosure.


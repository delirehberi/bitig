# Security Policy

## Architecture & Security Model

Bitig enforces strict validation, authentication, rate limiting, and encryption boundaries across its Local Markdown and Cloudflare Worker (D1 + Hono) storage modes. For the complete threat model, authentication specifications (password and NIP-07 Nostr sign-in), and CSRF defenses, see [`docs/security.md`](./docs/security.md).

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Instead, please report vulnerabilities privately using [GitHub Private Vulnerability Reporting](https://github.com/delirehberi/bitig/security/advisories/new) on this repository.

When reporting a vulnerability, please include:
- A clear description of the issue and the affected package or app (`@bitig/core`, `@bitig/storage-markdown`, `@bitig/worker`, etc.).
- Steps to reproduce or a minimal proof-of-concept.
- The potential impact and deployment mode affected (`local` or `cloudflare`).

We will acknowledge receipt of your report within 72 hours and work with you to validate and remediate the issue before public disclosure.


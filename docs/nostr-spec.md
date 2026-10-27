# Bitig Nostr Event Specification

This document defines the Nostr event kinds, tag schemas, encryption standards, and deletion semantics used by Bitig for decentralized project and task management. Any third-party Nostr client, agent, or explorer can parse, display, and manage Bitig entities by following this specification.

---

## 1. Overview

Bitig uses **parameterized replaceable events** (kinds `30000 <= kind < 40000`, per NIP-01 and NIP-33). Each entity is uniquely identified by `(kind, pubkey, d-tag)`:
- `d` tag: Domain identifier (UUIDv7 string, e.g. `01940000-0000-7000-8000-000000000001`).
- Relays replace previous events having the same kind, pubkey, and `d` tag whenever a newer event (higher `created_at`) is published.
- Privacy: Public tasks store their title and description in cleartext. Private tasks encrypt their title and description using **NIP-44 self-encryption** (author pubkey as both sender and recipient).
- Deletion: Managed via **NIP-09** (kind `5`) deletion events referencing event addresses and IDs.

---

## 2. Event Kinds

| Kind | Name | Description |
| :--- | :--- | :--- |
| `30331` | **Bitig Project** | Parameterized replaceable event representing a project container. |
| `30332` | **Bitig Task** | Parameterized replaceable event representing an individual task. |
| `30333` | **Bitig Comment** | Parameterized replaceable event representing a comment on a task. |
| `30335` | **Bitig Checkpoint** | Parameterized replaceable event holding one step of a task's execution state. |
| `31989` | **App Handler (NIP-89)** | Metadata event declaring Bitig as a handler for kinds `30331` and `30332`. |
| `5` | **Deletion (NIP-09)** | Standard deletion event referencing deleted project or task coordinates. |

---

## 3. Project Event (`kind: 30331`)

A project groups related tasks.

### Tags

| Tag | Required | Description | Example |
| :--- | :--- | :--- | :--- |
| `d` | **Yes** | Project ID (UUIDv7) | `["d", "01944547-0e62-7901-b755-e7a93540a08f"]` |
| `name` | **Yes** | Project name (1–200 characters) | `["name", "Bitig Core"]` |
| `kind` | **Yes** | Project category: `paid`, `hobby`, `open_source`, `personal`, or `internal` (default: `hobby`) | `["kind", "open_source"]` |
| `key` | No | Project key for ticket codes: 2–10 uppercase letters or digits, starting with a letter, unique among the author's projects. Set on every project Bitig creates; older projects get one from the ticket-code backfill. | `["key", "BIT"]` |
| `alt` | No | NIP-31 human-readable description for clients without kind `30331` support | `["alt", "Bitig Project: Bitig Core"]` |
| `resource` | No | A link to an outside resource: URL (http or https), type (`repository`, `issue_tracker`, `design`, `documentation` or `other`) and label. One tag per link, up to 50, in display order. Project events are not encrypted, so these links are public. | `["resource", "https://github.com/acme/bitig", "repository", "GitHub"]` |

### Content
- Cleartext UTF-8 string containing the project description (up to 50,000 characters). May be empty (`""`).

### Timestamps
- `created_at`: Unix timestamp in seconds.
- Update tracking: When updating a project, publish a new event with the same `d` tag and an updated `created_at`.

---

## 4. Task Event (`kind: 30332`)

An actionable item belonging to a project.

### Tags

| Tag | Required | Description | Example |
| :--- | :--- | :--- | :--- |
| `d` | **Yes** | Task ID (UUIDv7) | `["d", "01944547-2b7e-7c15-992e-33633beba656"]` |
| `a` | **Yes** | Address coordinate of the parent project: `30331:<authorPubkey>:<projectId>` | `["a", "30331:fa56...:01944547-0e62-7901-b755-e7a93540a08f"]` |
| `project` | **Yes** | Parent project ID for direct query indexing (`#project`) | `["project", "01944547-0e62-7901-b755-e7a93540a08f"]` |
| `status` | **Yes** | Task status: `todo`, `in_progress`, `done`, or `archived` | `["status", "todo"]` |
| `is_public`| **Yes** | Visibility flag: `"true"` or `"false"` | `["is_public", "false"]` |
| `priority` | No | Task priority: `trivial`, `low`, `medium`, `high`, or `urgent` | `["priority", "high"]` |
| `due` | No | Calendar due date (`YYYY-MM-DD`, no timezone) | `["due", "2026-12-31"]` |
| `order` | No | Fractional index or sort order (floating point number as string) | `["order", "1.5"]` |
| `t` | No | Zero or more label tags (e.g. hashtags) | `["t", "frontend"], ["t", "bug"]` |
| `number` | No | Positive integer, unique within the project; with the project `key` it forms the ticket code (`BIT-12`). New tasks take one past the highest number the client knows of in that project, so two clients creating tasks offline can pick the same number. | `["number", "12"]` |
| `alt` | No | NIP-31 fallback description | `["alt", "Bitig Task"]` |

### Content & Encryption (NIP-44)

The payload content depends on `is_public`:

#### Public Task (`is_public: "true"`)
The `content` field contains a cleartext JSON object:
```json
{
  "title": "Implement Nostr storage adapter",
  "description": "Full details and markdown notes here...",
  "checklist": [
    { "text": "Write the codec", "done": true },
    { "text": "Run the contract suite", "done": false }
  ],
  "needsHuman": "Choose which relays to publish to",
  "pendingApproval": true,
  "dependsOn": ["01940000-0000-7000-8000-000000000001"]
}
```
`checklist` (the task's subtasks, in order) is omitted when the task has none. `needsHuman` (what the task waits on a person for) is omitted when it needs nobody. `pendingApproval` is `true` while a task an agent or webhook created waits for a person to approve it, and is omitted once it is approved. `dependsOn` lists the IDs (the `d` tags) of the tasks this task waits on, and is omitted when it waits on none. It lives in the content rather than in tags so a private task's dependencies stay encrypted.

#### Private Task (`is_public: "false"`)
- The `title`, `description`, `checklist`, `needsHuman`, `pendingApproval` and `dependsOn` (when present) are packaged into the JSON object:
  ```json
  {
    "title": "Private confidential task",
    "description": "Sensitive instructions..."
  }
  ```
- The JSON string is encrypted using **NIP-44 v2** encryption with the user's own keypair (self-encryption: `senderPrivateKey = userPrivateKey`, `recipientPublicKey = userPublicKey`).
- The resulting ciphertext (base64 string starting with version byte) is stored in `content`.
- **Privacy Guarantee:** Relays, indexers, and third parties only see the kind, task ID, parent project coordinate, status, priority, and due date. The task title, description, checklist, needs-human reason and dependencies remain strictly confidential.

---

## 4a. Comment Event (`kind: 30333`)

A comment on a task: context an agent keeps, or a person's answer. Comments are never edited, only added and deleted.

### Tags

| Tag | Required | Description | Example |
| :--- | :--- | :--- | :--- |
| `d` | **Yes** | Comment ID (UUIDv7) | `["d", "01944547-4c1a-7d20-8a11-2f6e1b0c9d33"]` |
| `a` | **Yes** | Address coordinate of the task: `30332:<authorPubkey>:<taskId>` | `["a", "30332:fa56...:01944547-2b7e-7c15-992e-33633beba656"]` |
| `task` | **Yes** | Task ID for direct query indexing (`#task`) | `["task", "01944547-2b7e-7c15-992e-33633beba656"]` |
| `author_type` | **Yes** | Who wrote it: `human` or `agent` | `["author_type", "agent"]` |
| `created_at_iso` | No | Millisecond-precision creation time | `["created_at_iso", "2026-10-20T00:30:00.000Z"]` |
| `alt` | No | NIP-31 fallback description | `["alt", "Bitig Comment"]` |

### Content
Always NIP-44 self-encrypted, whatever the task's `is_public`: a task can be made private later, and relays keep old events. The plaintext is JSON:
```json
{ "body": "Use the staging key.", "author": "claude" }
```
`author` (a display name, up to 100 characters) is omitted when not set. `body` is Markdown, 1–20,000 characters.

A comment stays with its task when the task moves to another project, since it references only the task.

---

## 4b. Checkpoint Event (`kind: 30335`)

One step of a task's sequential execution state, so an agent can resume where it stopped. A task has at most one checkpoint per step index; saving a step again replaces its event.

### Tags

| Tag | Required | Description | Example |
| :--- | :--- | :--- | :--- |
| `d` | **Yes** | Checkpoint ID (UUIDv7), kept when the step is saved again | `["d", "01944547-4c1a-7d20-8a11-2f6e1b0c9d33"]` |
| `a` | **Yes** | Address coordinate of the task: `30332:<authorPubkey>:<taskId>` | `["a", "30332:fa56...:01944547-2b7e-7c15-992e-33633beba656"]` |
| `task` | **Yes** | Task ID for direct query indexing (`#task`) | `["task", "01944547-2b7e-7c15-992e-33633beba656"]` |
| `created_at_iso` | No | Millisecond-precision time the step was first saved | `["created_at_iso", "2026-10-20T00:30:00.000Z"]` |
| `alt` | No | NIP-31 fallback description | `["alt", "Bitig Checkpoint"]` |

### Content
Always NIP-44 self-encrypted, whatever the task's `is_public`. The step index, status and snapshot are never tags, so relays see only the task a checkpoint belongs to. The plaintext is JSON:
```json
{
  "stepIndex": 2,
  "status": "IN_PROGRESS",
  "stateSnapshot": {
    "summary": "Schema migrated",
    "modifiedArtifacts": ["migrations/0012.sql"],
    "decisionsMade": ["unique (task, step)"],
    "nextStepInstructions": "Wire the REST routes"
  }
}
```
`status` is one of `PENDING`, `IN_PROGRESS`, `WAITING_HUMAN_APPROVAL`, `COMPLETED`, `FAILED`. `stateSnapshot` may also carry `blockersOrErrors` and flat `metadata`; every field is length-bounded (summary 500, instructions 4,000, 20 list items).

Saving a step again republishes the same `d` tag with an event time strictly later than the previous one, so last-write-wins resolves to the newest snapshot. A checkpoint is informational: it never changes the task's status, approval or needs-human gates. It stays with its task when the task moves to another project.

---

## 5. Deletion & Cascades (NIP-09)

Entities are permanently deleted by publishing a **kind `5`** deletion event signed by the author.

### Deleting a Task
Publish a kind `5` event with:
- `["a", "30332:<authorPubkey>:<taskId>"]`
- `["e", "<latestTaskEventId>"]` (optional but recommended)
- `["a", "30333:<authorPubkey>:<commentId>"]` for each of the task's comments, with `["k", "30333"]`
- `["a", "30335:<authorPubkey>:<checkpointId>"]` for each of the task's checkpoints, with `["k", "30335"]`

### Deleting a Comment
Publish a kind `5` event with `["a", "30333:<authorPubkey>:<commentId>"]` and `["k", "30333"]`.

### Deleting a Project (Cascading Deletion)
In Bitig, deleting a project cascades to delete all tasks belonging to it.
Publish a single kind `5` event containing:
- `["a", "30331:<authorPubkey>:<projectId>"]`
- `["a", "30332:<authorPubkey>:<taskId1>"]`
- `["a", "30332:<authorPubkey>:<taskId2>"]`
- `["a", "30333:<authorPubkey>:<commentId>"]` for each comment on those tasks
- `["a", "30335:<authorPubkey>:<checkpointId>"]` for each checkpoint on those tasks
- `["k", "30331"]`
- `["k", "30332"]`
- `["k", "30333"]` (when there are comments)
- `["k", "30335"]` (when there are checkpoints)

When a client queries events from relays, it must fetch kind `5` events authored by the user and treat any referenced `d` or `a` coordinates as tombstones.

---

## 6. NIP-89 Application Handler (`kind: 31989`)

To let third-party Nostr clients know that Bitig handles project and task events, Bitig registers an application handler:

```json
{
  "kind": 31989,
  "tags": [
    ["d", "bitig"],
    ["k", "30331"],
    ["k", "30332"],
    ["k", "30333"],
    ["name", "Bitig"],
    ["about", "Edge-ready, decentralized task and project manager."],
    ["web", "https://bitig.app/projects/<bech32>?mode=nostr", "project"],
    ["web", "https://bitig.app/tasks/<bech32>?mode=nostr", "task"]
  ],
  "content": ""
}
```

---

## 7. Conflict Resolution (Last-Write-Wins)

When querying multiple relays:
1. Deduplicate events by event ID.
2. Group events by `(kind, pubkey, d-tag)`.
3. Pick the event with the greatest `created_at` timestamp.
4. If two events have identical `created_at`, break ties deterministically by choosing the event with the lower lexicographical event `id`.
5. If an event coordinate has a newer or matching kind `5` tombstone, discard it.


# Interoperability & Backup Specification

Bitig supports two storage modes:
1. **Local Markdown (`storage-markdown`)**: Projects as directories, tasks as markdown files with YAML frontmatter.
2. **Cloudflare D1 (`storage-d1`)**: Relational edge SQL database with Drizzle ORM.

To enable seamless data portability, backup, and cross-mode synchronization, Bitig provides canonical interchange bundle formats and automated import/export tooling.

---

## 1. Bundle Specifications

All bundles are strictly validated at system boundaries with Zod.

### 1.1 ProjectBundle (`ProjectBundleSchema`)
Encapsulates a single project entity alongside all associated tasks and their comments. `comments` and `checkpoints` (execution state, at most one per task step) are optional on import, so bundles made before either still load. A bundle is rejected if a checkpoint references a task outside it or repeats a `(taskId, stepIndex)` pair.

```json
{
  "version": 1,
  "exportedAt": "2026-10-12T15:20:00.000Z",
  "project": {
    "id": "01940000-0000-7000-8000-000000000001",
    "name": "Production Infrastructure",
    "description": "Core cluster operations",
    "kind": "internal",
    "createdAt": "2026-10-12T10:00:00.000Z",
    "updatedAt": "2026-10-12T10:00:00.000Z"
  },
  "tasks": [
    {
      "id": "01940000-0000-7000-8000-000000000002",
      "projectId": "01940000-0000-7000-8000-000000000001",
      "title": "Upgrade Kubelet",
      "description": "Upgrade control plane to latest patch release",
      "status": "todo",
      "isPublic": false,
      "createdAt": "2026-10-12T10:05:00.000Z",
      "updatedAt": "2026-10-12T10:05:00.000Z",
      "priority": "urgent",
      "dueDate": "2026-12-31",
      "labels": ["k8s", "infra"],
      "order": 1
    }
  ],
  "comments": [
    {
      "id": "01940000-0000-7000-8000-000000000003",
      "taskId": "01940000-0000-7000-8000-000000000002",
      "body": "Waiting on the maintenance window. Which day works?",
      "authorType": "agent",
      "author": "claude",
      "createdAt": "2026-10-12T11:00:00.000Z"
    }
  ]
}
```

### 1.2 BackupBundle (`BackupBundleSchema`)
Encapsulates all projects and their corresponding tasks across the entire storage provider.

```json
{
  "version": 1,
  "exportedAt": "2026-10-12T15:20:00.000Z",
  "bundles": [
    {
      "version": 1,
      "exportedAt": "2026-10-12T15:20:00.000Z",
      "project": { ... },
      "tasks": [ ... ],
      "comments": [ ... ]
    }
  ]
}
```

---

## 2. CLI Usage Reference

The Bitig CLI (`apps/cli`) includes built-in commands for export, import, backup, and restore.

### 2.1 Exporting a Single Project
Export a project and all its tasks to a JSON bundle:

```bash
# Output to stdout
bitig export <projectId>

# Save directly to a file
bitig export <projectId> --file backup-project.json
```

### 2.2 Importing a Project
Restore or migrate a project bundle into the active storage provider:

```bash
bitig import backup-project.json
```
Importing is idempotent: if the project or tasks already exist, their metadata and content are updated without losing timestamp history.

### 2.3 Full System Backup
Create an archive containing all projects and tasks:

```bash
# Output to stdout
bitig backup

# Save directly to a backup archive
bitig backup --file bitig-backup-2026-10-12.json
```

### 2.4 Full System Restore
Restore all projects and tasks from a backup archive:

```bash
bitig restore bitig-backup-2026-10-12.json
```

---

## 3. Cross-Mode Migration & Interoperability

Projects and tasks round-trip across **Markdown ↔ D1** through the canonical bundle format.

+------------------+         Export         +-------------------+         Import         +------------------+
| Local Markdown   |  ------------------->  |  ProjectBundle    |  ------------------->  | Cloudflare D1    |
| (Filesystem)     |                        |  (Standard JSON)  |                        | (Relational SQL) |
+------------------+                        +-------------------+                        +------------------+

### Field Preservation Guarantees:
- **Project IDs & Task IDs:** Immutable UUIDv7 identifiers preserved across all storage media.
- **Timestamps (`createdAt`, `updatedAt`):** Preserved exactly to the millisecond.
- **Comments:** IDs, authors and timestamps are preserved.
- **Optional Metadata:** `dueDate`, `priority`, `order`, and `labels` retain their exact types, values, and order.

## Retiring Nostr storage

Before upgrading a deployment that used `STORAGE_MODE=nostr`, open the old dashboard and download a full JSON backup. After deploying the D1-backed release, sign in with an allowlisted NIP-07 key and restore that backup from the dashboard. Keep the backup until project, task, comment and checkpoint counts have been verified. Relay storage has been removed: current releases cannot read relay data, so the JSON backup is the only migration path.


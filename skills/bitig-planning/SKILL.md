---
name: bitig-planning
description: Record plans and findings as Bitig tasks through the bitig MCP server instead of Markdown files. Use when creating or updating a roadmap, phase plan, milestone list, task breakdown, backlog, audit, code review, security review, or tech-debt list, or when the user asks to track, remember, or follow up on work later. Do not write ROADMAP.md, TASKS.md, TODO.md, or similar tracking files.
---

# Bitig planning

Bitig is the single source of truth for planned work. Roadmaps, task lists and review findings go into Bitig as tasks through the `bitig` MCP server (tools: `list_projects`, `create_project`, `update_project`, `delete_project`, `list_tasks`, `get_task`, `add_task`, `update_task`, `complete_task`, `delete_task`, `backfill_ticket_codes`, `list_comments`, `add_comment`, `delete_comment`).

Do not create `ROADMAP.md`, `TASKS.md`, `TODO.md` or similar files for tracking. If the user explicitly asks for such a file, write it **in addition to** the Bitig tasks, never instead of them.

## 1. Resolve the project

1. Look for a `.bitig` file in the workspace root and read `project_id` from it.
2. If there is no `.bitig` file:
   - Call `list_projects` and look for a project that matches this workspace.
   - If none matches, ask the user before calling `create_project` (confirm the name, optional `key` like `BIT`, and `kind`: `paid | hobby | open_source | personal | internal`).
   - Write the returned `bitig_file_content` to `.bitig` in the workspace root.
3. Pass that `projectId` (or the project's short `key`, e.g. `BIT`) to every task call.
4. **Ticket codes**: Every project has an uppercase `key` (2–10 characters starting with a letter, derived from the project name when omitted) and every task receives a sequential `code` like `BIT-12`. You can pass a task's `code` wherever a task `id` is accepted (`get_task`, `update_task`, `complete_task`, `delete_task`, `list_comments`, `add_comment`), and a project's `key` wherever `projectId` is accepted (`list_tasks`, `add_task`, `update_task`). If an older project has unnumbered tasks, run `backfill_ticket_codes` once (idempotent).
5. **Project resources**: Attach related external links (`repository`, `issue_tracker`, `design`, `documentation`, `other`) via `resources: [{ type, label, url }]` on `create_project` or `update_project` (send the full edited list to add, edit, or remove links; `null` or `[]` clears them).

## 2. Avoid duplicates

Call `list_tasks` with the `projectId` (or project `key`) before adding anything. If a task already covers the item, update it with `update_task` instead of adding a new one. Do not reopen `done` or `archived` tasks unless the user asks for that.

## 3. Write each item as one task

- **title**: a short imperative sentence, e.g. "Rate-limit failed authentication attempts". No status markers or priority prefixes in the title.
- **description**: Markdown, using the sections that apply:
  - `**Finding:**` what was observed, with `path/to/file.ts:42` references.
  - `**Do:**` the concrete change.
  - `**Done when:**` a checkable acceptance criterion.
- **checklist** (subtasks): an ordered array of `{ text, done }` items on `add_task` or `update_task` for breaking a task into concrete, checkable steps. To check off, rename, reorder, add, or remove items, pass the full updated `checklist` array to `update_task` (`null` or `[]` removes the checklist).
- **needsHuman** (human-in-the-loop): set `needsHuman` on `add_task` or `update_task` when a task is blocked on a person—state clearly what you need from them (a design decision, approval, credentials, or an answer). Use `list_tasks({ needsHuman: true })` to find tasks waiting on a human, and clear it with `update_task({ id, needsHuman: null })` once resolved.
- **priority**:
  - `urgent`: blocks other work or is broken in production.
  - `high`: security issues, data loss, correctness bugs.
  - `medium`: needed for a phase or milestone to count as done.
  - `low`: quality, usability, cleanup.
  - `trivial`: cosmetic.
- **labels** (lowercase except phase labels):
  - area: `security`, `testing`, `docs`, `cli`, `api`, `ui`, `setup`, `infra`, `performance`, …
  - phase: `P0`, `P1`, … when the task belongs to a roadmap phase.
  - source: `roadmap`, `code-review`, `audit`, `tech-debt`.
- **order**: for a roadmap, set `order` so tasks sort in execution order (10, 20, 30, … leaves room to insert).
- **status**: `todo` for new work. Use `done` only when importing work that is already finished.
- **dueDate**: only when the user gives a date (`YYYY-MM-DD`).

## 4. Comments & context sharing

Tasks have a chronological comment thread (`get_task` returns `comments` oldest first, or call `list_comments`).
- Use `add_comment` (`taskId` accepts ID or ticket code like `BIT-12`, `body` in Markdown, `author` set to your agent name e.g. `"claude"` or `"antigravity"`, `authorType: "agent"`) to record investigation notes, architectural context, blockers, or questions for the user without overwriting the task description.
- When a task has `needsHuman` set, check its comments via `get_task` or `list_comments` to read the person's response. A comment does not clear `needsHuman` automatically: only clear `needsHuman: null` with `update_task` if the person's comment explicitly states the question or blocker is resolved (otherwise leave it for the person's manual resolve action).
- Use `delete_comment` with a comment `id` only when removing an erroneous or duplicate comment.

## 5. By request type

- **Roadmap / phase plan**: one task per deliverable, labeled `roadmap` plus its phase label. Put the phase's goal and "done when" criterion in the description of its tasks rather than in a separate file.
- **Code review / security review**: one task per finding, labeled `code-review` (or `security`), with the `file:line` reference in the title or the first line of the description. Still present the findings to the user in chat as usual; the tasks are the durable record.
- **Audit / tech debt**: one task per finding, labeled `audit` or `tech-debt`, prioritized with the scale above.

## 6. Keep status current

- When starting a task, call `update_task` with `status: "in_progress"`.
- As you complete subtasks within a task, update its `checklist` items (`done: true`) via `update_task`.
- When it is finished and verified, call `complete_task`.
- If the plan changes, update or archive the task (`status: "archived"`) instead of leaving it stale.

## 7. Report back

After writing tasks, give the user a short summary: the project, how many tasks were added or updated, and a compact list of ticket codes and titles with priority. Do not paste full descriptions back.

## 8. Failures

If the `bitig` MCP server is unavailable or a call fails, stop and tell the user the exact error. Do not fall back to writing a Markdown tracking file without the user's approval.

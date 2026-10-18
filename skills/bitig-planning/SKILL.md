---
name: bitig-planning
description: Record plans and findings as Bitig tasks through the bitig MCP server instead of Markdown files. Use when creating or updating a roadmap, phase plan, milestone list, task breakdown, backlog, audit, code review, security review, or tech-debt list, or when the user asks to track, remember, or follow up on work later. Do not write ROADMAP.md, TASKS.md, TODO.md, or similar tracking files.
---

# Bitig planning

Bitig is the single source of truth for planned work. Roadmaps, task lists and review findings go into Bitig as tasks through the `bitig` MCP server (tools: `list_projects`, `create_project`, `update_project`, `list_tasks`, `get_task`, `add_task`, `update_task`, `complete_task`, `delete_task`).

Do not create `ROADMAP.md`, `TASKS.md`, `TODO.md` or similar files for tracking. If the user explicitly asks for such a file, write it **in addition to** the Bitig tasks, never instead of them.

## 1. Resolve the project

1. Look for a `.bitig` file in the workspace root and read `project_id` from it.
2. If there is no `.bitig` file:
   - Call `list_projects` and look for a project that matches this workspace.
   - If none matches, ask the user before calling `create_project` (confirm the name and `kind`: `paid | hobby | open_source | personal | internal`).
   - Write the returned `bitig_file_content` to `.bitig` in the workspace root.
3. Pass that `projectId` to every task call.

## 2. Avoid duplicates

Call `list_tasks` with the `projectId` before adding anything. If a task already covers the item, update it with `update_task` instead of adding a new one. Do not reopen `done` or `archived` tasks unless the user asks for that.

## 3. Write each item as one task

- **title**: a short imperative sentence, e.g. "Rate-limit failed authentication attempts". No status markers or priority prefixes in the title.
- **description**: Markdown, using the sections that apply:
  - `**Finding:**` what was observed, with `path/to/file.ts:42` references.
  - `**Do:**` the concrete change.
  - `**Done when:**` a checkable acceptance criterion.
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

## 4. By request type

- **Roadmap / phase plan**: one task per deliverable, labeled `roadmap` plus its phase label. Put the phase's goal and "done when" criterion in the description of its tasks rather than in a separate file.
- **Code review / security review**: one task per finding, labeled `code-review` (or `security`), with the `file:line` reference in the title or the first line of the description. Still present the findings to the user in chat as usual; the tasks are the durable record.
- **Audit / tech debt**: one task per finding, labeled `audit` or `tech-debt`, prioritized with the scale above.

## 5. Keep status current

- When starting a task, call `update_task` with `status: "in_progress"`.
- When it is finished and verified, call `complete_task`.
- If the plan changes, update or archive the task (`status: "archived"`) instead of leaving it stale.

## 6. Report back

After writing tasks, give the user a short summary: the project, how many tasks were added or updated, and a compact list of titles with priority. Do not paste full descriptions back.

## 7. Failures

If the `bitig` MCP server is unavailable or a call fails, stop and tell the user the exact error. Do not fall back to writing a Markdown tracking file without the user's approval.

---
name: bitig
description: Connect to Bitig MCP to read tasks, update checklists, manage branch/worktree status, and submit review summaries.
---

# Bitig — Agent Workflow & Task Execution Skill

Use the `bitig` MCP server tools whenever you are working on a Bitig task or ticket (e.g. `BIT-123`).

## 1. Starting a Task or Ticket
- When starting work on a task or ticket, call `get_task({ id: "<TICKET_CODE>" })` and `resume_from_checkpoint({ taskId: "<TICKET_CODE>" })` to fetch the full task details, description, acceptance criteria, checklists, comments, and any prior checkpoint.
- Check `pendingApproval`, `needsHuman`, and `blockedBy` / `dependsOn` gates before making changes. Do not start implementation on tasks awaiting human approval or blocked by unfinished dependencies.

## 2. Creating a Branch or Worktree (`in_progress`)
- When creating a feature branch or isolated Git worktree to begin implementation, move the task status to `in_progress` via `update_task({ id: "<TICKET_CODE>", status: "in_progress" })` (if not already `in_progress`).

## 3. Executing & Checking Off Subtasks
- Work through the task's acceptance criteria and checklist items methodically.
- As each subtask is completed and verified, update the checklist via `update_task({ id: "<TICKET_CODE>", checklist: [...] })` and record a deterministic checkpoint via `save_checkpoint({ taskId: "<TICKET_CODE>", stepIndex, status: "IN_PROGRESS", stateSnapshot: { summary, modifiedArtifacts, decisionsMade, nextStepInstructions } })`.
- If blocked by a human decision, credentials, or clarification, post a clear question with `add_comment({ taskId: "<TICKET_CODE>", body: "..." })` and set `update_task({ id: "<TICKET_CODE>", needsHuman: "<what you need>" })`, then stop and wait for human input.

## 4. Opening a PR & Finishing Implementation (`in_review` / `done`)
- When opening a Pull Request or finishing implementation:
  1. Run linting, typechecking, build, and tests to verify all acceptance criteria pass.
  2. Report Git branch, `HEAD` commit SHA, diff statistics, and PR URLs via `report_t3_git_metadata` when running inside a T3 session.
  3. Post a comprehensive summary comment via `add_comment({ taskId: "<TICKET_CODE>", body: "..." })` covering the outcome, changes made, verification output, and the branch / PR URL.
  4. Move the task status to `in_review` (or mark `done` via `complete_task({ id: "<TICKET_CODE>" })` when the schema uses `todo` / `in_progress` / `done` and all work is verified). Never move a task directly to `archived`.

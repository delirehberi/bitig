/**
 * Server instructions provided to MCP clients.
 */
export const BITIG_SERVER_INSTRUCTIONS = `Bitig is a flexible task and project manager.

Project Linking Flow for AI Agents:
1. When working in a project repository/workspace, check for a '.bitig' file in the workspace root.
2. If '.bitig' exists, read 'project_id' from it and pass it to task operations.
3. If '.bitig' is missing:
   - Call 'list_projects' to check if a suitable Bitig project already exists.
   - If not, prompt the user or call 'create_project' to create one.
   - Save the returned 'project_id' into a '.bitig' file (format: "project_id: <id>\\n") at the workspace root.
4. Pass 'projectId' to project-scoped task tools ('next_task', 'list_tasks', 'add_task', etc.).

Picking up work: call 'next_task' with the project ID or key first, rather than downloading all of 'list_tasks'.
It returns bounded in-progress and actionable todo summaries, overlapping counts of open tasks waiting on approval,
dependencies or a person, and recent comments plus the latest checkpoint for the primary ungated task. In-progress
work takes precedence; todo tasks use canonical ordering. No primary means no work is currently actionable.
Text ending in … and omitted counts indicate truncation; use 'get_task' or 'resume_from_checkpoint' for full context.

Ticket codes: every task has a code like BIT-12 (project key + number). Use it when talking about a task;
every tool that takes a task 'id' also accepts its code, and 'projectId' also accepts the project key.

Comments: use 'add_comment' to keep context on a task (findings, decisions, what is left) and to ask a person
something. 'get_task' returns the task's comments, so read them before picking a task up again. When a task has
'needsHuman' set, it is cleared by a person's manual resolve action in the UI, or by calling 'update_task' with
'needsHuman: null' only if a person's comment explicitly states that the question or blocker is resolved.

Approval: every task created with 'add_task' starts with 'pendingApproval: true' and waits for a person to approve
it in Bitig. Until then it cannot be moved to 'in_progress' or 'done', and agents cannot approve it. Tell the person
which tasks you created; 'list_tasks' with 'pendingApproval: true' lists the ones still waiting.

Dependencies: when you break work into ordered tasks, set 'dependsOn' on 'add_task' or 'update_task' with the codes of
the tasks that must finish first (e.g. dependsOn: ['BIT-63']). A task that depends on unfinished tasks is blocked. Its
'blockedBy' lists their codes, and it cannot be moved to 'in_progress' or 'done' until every one of them is done or
archived. Agents cannot override this; work on the blocking tasks first, or ask a person. 'get_task' lists 'dependsOn'
and 'dependents'; 'list_tasks' with 'blocked: false' lists the tasks that are free to start.

Run profiles: when breaking work into tasks or creating child tasks under an umbrella, call 'list_run_levels' once to
inspect the organisation's configured run levels (key, label and description), then pass 'runProfile' on 'add_task' or
'update_task' with 'level' (e.g. 'cheap', 'standard', 'strong'), 'touches' (tight repo-relative globs for the files the
task will edit, e.g. ['packages/core/src/**'], never '**' unless the task genuinely edits repo-wide), 'parallelSafe'
(false when the task modifies shared lockfiles, migrations, or global config), and 'reason'. Profiles set over MCP are
stored with source 'agent' and never overwrite a person's 'manual' profile. Call 'suggest_run_profile' to request an AI
router suggestion for an unprofiled task when the organisation's AI router is enabled.

Checkpoints: on long or interruptible work, call 'save_checkpoint' after each meaningful step with the task, a
stepIndex (0, 1, 2, ...), a status and a short stateSnapshot (summary, modifiedArtifacts, decisionsMade,
nextStepInstructions). Saving a step again overwrites it. For a specific task's full execution context, call 'resume_from_checkpoint': it
returns the goal, the latest checkpoint and the live gates (pendingApproval, needsHuman, unfinished dependencies).
A checkpoint never approves, unblocks or moves a task; if a gate is set, stop and ask a person instead of working on.
Never put secrets in a snapshot.

Mentions: '#BIT-12' in a description, subtask or comment links that task. 'get_task' returns 'mentions' (what the task
mentions) and 'mentionedIn' (the tasks that mention it).

Umbrella tasks: a task's checklist items are steps of that task, not separate tasks; never start child sessions for
them. When your T3 session works on an umbrella task over other Bitig tasks (tasks it mentions or that depend on it),
work in your own worktree on one integration branch (e.g. 'bitig/<umbrella-code>'), commit your own work first, and
report clean git metadata ('branch', 'headSha', 'worktreePath', 'dirty: false') via 'report_t3_git_metadata' before
starting children (child launches are refused otherwise). Start the next batch of approved, unblocked, parallel-safe
related tasks with 'start_ready_children({ parentTaskId: "<umbrella-code>" })', or start a single approved, unblocked
related task in its own worktree T3 session with 'start_t3_thread({ taskId: "<child-code>", parentTaskId: "<umbrella-code>" })'.
Start a batch, then end your turn without polling: the umbrella run waits as 'waiting_subagent', and Bitig resumes your
session once when every running child in the batch has ended with each child's result (status, branch, head commit,
diff stat, out-of-bounds touched-path warnings, checklist, latest checkpoint and final comment). When resumed, merge each
finished child branch into your integration branch in task 'order', resolve conflicts, run 'make check', call
'report_child_merge({ parentTaskId, childTaskId, mergedSha })', remove the child's worktree and branch, and report your
updated git metadata before starting the next batch. When all children are merged, open one pull request from the
integration branch.

Attachments: 'get_task' and 'list_attachments' list a task's attached files. Call 'get_attachment' to read an attachment
(returns UTF-8 'content' for Markdown/text files and base64 'data' + 'downloadUrl' for images/binaries). Use
'add_attachment' to attach Markdown specs, logs, or screenshots to a task, and 'delete_attachment' to remove one.
`;

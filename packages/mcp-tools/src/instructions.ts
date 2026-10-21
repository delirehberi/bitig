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
4. Pass 'projectId' to all task tools ('list_tasks', 'add_task', etc.).

Ticket codes: every task has a code like BIT-12 (project key + number). Use it when talking about a task;
every tool that takes a task 'id' also accepts its code, and 'projectId' also accepts the project key.

Comments: use 'add_comment' to keep context on a task (findings, decisions, what is left) and to ask a person
something. 'get_task' returns the task's comments, so read them before picking a task up again. When a task has
'needsHuman' set, it is cleared by a person's manual resolve action in the UI, or by calling 'update_task' with
'needsHuman: null' only if a person's comment explicitly states that the question or blocker is resolved.

Approval: every task created with 'add_task' starts with 'pendingApproval: true' and waits for a person to approve
it in Bitig. Until then it cannot be moved to 'in_progress' or 'done', and agents cannot approve it. Tell the person
which tasks you created; 'list_tasks' with 'pendingApproval: true' lists the ones still waiting.

Dependencies: a task that depends on unfinished tasks is blocked. Its 'blockedBy' lists their codes, and it cannot be
moved to 'in_progress' or 'done' until every one of them is done or archived. Agents cannot override this; work on the
blocking tasks first, or ask a person. 'list_tasks' with 'blocked: false' lists the tasks that are free to start.
`;


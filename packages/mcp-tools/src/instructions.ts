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

Comment decisions and approval blocks:
- Before starting or resuming work, read the task's comments. If an unblocked task has an unresolved question
  (e.g. "what do you think?") or a prerequisite (e.g. "do the design in Figma first"), answer the question or
  carry out the authorized prerequisite first. Respect tool permissions and the user's scope.
- Add a comment with the decision or result, links to any artifact, and exactly what the person should approve.
  Then call 'update_task' with status: 'blocked'. Use 'needsHuman' to explain the approval being requested.
- Stop work on that task and wait for the person. Do not repeat already answered comments or block routine
  informational comments. A blocked task stays blocked even if a new comment arrives; agents cannot release it.
  A person approves by changing its status to 'todo' or 'in_progress' in the dashboard or CLI.
- 'blocked' is a separate status; unfinished 'dependsOn' tasks are a separate dependency block.

Approval: every task created with 'add_task' starts with 'pendingApproval: true' and waits for a person to approve
it in Bitig. Until then it cannot be moved to 'in_progress' or 'done', and agents cannot approve it. Tell the person
which tasks you created; 'list_tasks' with 'pendingApproval: true' lists the ones still waiting.

Dependencies: when you break work into ordered tasks, set 'dependsOn' on 'add_task' or 'update_task' with the codes of
the tasks that must finish first (e.g. dependsOn: ['BIT-63']). A task that depends on unfinished tasks is blocked. Its
'blockedBy' lists their codes, and it cannot be moved to 'in_progress' or 'done' until every one of them is done or
archived. Agents cannot override this; work on the blocking tasks first, or ask a person. 'get_task' lists 'dependsOn'
and 'dependents'; 'list_tasks' with 'blocked: false' lists the tasks that are free to start.

Mentions: '#BIT-12' in a description, subtask or comment links that task. 'get_task' returns 'mentions' (what the task
mentions) and 'mentionedIn' (the tasks that mention it).
`;


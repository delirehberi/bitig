import { hasMinimumOrgRole, type OrganisationRole } from "./organisations";

export const ORG_PERMISSIONS = [
  "project:read",
  "project:write",
  "task:read",
  "task:write",
  "comment:read",
  "comment:write",
  "attachment:read",
  "attachment:write",
  "checkpoint:read",
  "checkpoint:write",
  "webhook:read",
  "webhook:write",
  "backup:export",
  "backup:import",
  "t3:read",
  "t3:write",
  "org:read",
  "org:manage",
  "org:members:read",
  "org:members:manage",
] as const;

export type OrgPermission = (typeof ORG_PERMISSIONS)[number];

/** Minimum organisation role required for each permission. */
export const ORG_PERMISSION_ROLES: Record<OrgPermission, OrganisationRole> = {
  "project:read": "viewer",
  "project:write": "editor",
  "task:read": "viewer",
  "task:write": "editor",
  "comment:read": "viewer",
  "comment:write": "editor",
  "attachment:read": "viewer",
  "attachment:write": "editor",
  "checkpoint:read": "viewer",
  "checkpoint:write": "editor",
  "webhook:read": "viewer",
  "webhook:write": "editor",
  "backup:export": "editor",
  "backup:import": "owner",
  "t3:read": "viewer",
  "t3:write": "editor",
  "org:read": "viewer",
  "org:manage": "owner",
  "org:members:read": "viewer",
  "org:members:manage": "owner",
};

export function canPerformOrgAction(role: OrganisationRole, permission: OrgPermission): boolean {
  return hasMinimumOrgRole(role, ORG_PERMISSION_ROLES[permission]);
}

/** MCP tools that modify state and therefore require at least `editor` role. */
export const MCP_WRITE_TOOLS = new Set<string>([
  "create_project",
  "update_project",
  "delete_project",
  "add_task",
  "update_task",
  "complete_task",
  "delete_task",
  "backfill_ticket_codes",
  "add_comment",
  "delete_comment",
  "save_checkpoint",
  "add_attachment",
  "delete_attachment",
  "create_webhook",
  "update_webhook",
  "delete_webhook",
  "start_t3_thread",
  "report_t3_git_metadata",
]);

export function requiredOrgRoleForMcpTool(toolName: string): OrganisationRole {
  return MCP_WRITE_TOOLS.has(toolName) ? "editor" : "viewer";
}

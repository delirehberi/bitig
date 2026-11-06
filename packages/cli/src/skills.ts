import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentId } from "./agents";

export const DEFAULT_REMOTE_SKILL_URL = "https://bitig.emre.xyz/skills/bitig/SKILL.md";

export const BUNDLED_SKILL_MD = `---
name: bitig
description: Connect to Bitig MCP to read tasks, update checklists, manage branch/worktree status, and submit review summaries.
---

# Bitig — Agent Workflow & Task Execution Skill

Use the \`bitig\` MCP server tools whenever you are working on a Bitig task or ticket (e.g. \`BIT-123\`).

## 1. Starting a Task or Ticket
- When starting work on a task or ticket, call \`get_task({ id: "<TICKET_CODE>" })\` and \`resume_from_checkpoint({ taskId: "<TICKET_CODE>" })\` to fetch the full task details, description, acceptance criteria, checklists, comments, and any prior checkpoint.
- Check \`pendingApproval\`, \`needsHuman\`, and \`blockedBy\` / \`dependsOn\` gates before making changes. Do not start implementation on tasks awaiting human approval or blocked by unfinished dependencies.

## 2. Creating a Branch or Worktree (\`in_progress\`)
- When creating a feature branch or isolated Git worktree to begin implementation, move the task status to \`in_progress\` via \`update_task({ id: "<TICKET_CODE>", status: "in_progress" })\` (if not already \`in_progress\`).

## 3. Executing & Checking Off Subtasks
- Work through the task's acceptance criteria and checklist items methodically.
- As each subtask is completed and verified, update the checklist via \`update_task({ id: "<TICKET_CODE>", checklist: [...] })\` and record a deterministic checkpoint via \`save_checkpoint({ taskId: "<TICKET_CODE>", stepIndex, status: "IN_PROGRESS", stateSnapshot: { summary, modifiedArtifacts, decisionsMade, nextStepInstructions } })\`.
- If blocked by a human decision, credentials, or clarification, post a clear question with \`add_comment({ taskId: "<TICKET_CODE>", body: "..." })\` and set \`update_task({ id: "<TICKET_CODE>", needsHuman: "<what you need>" })\`, then stop and wait for human input.

## 4. Opening a PR & Finishing Implementation (\`in_review\` / \`done\`)
- When opening a Pull Request or finishing implementation:
  1. Run linting, typechecking, build, and tests to verify all acceptance criteria pass.
  2. Report Git branch, \`HEAD\` commit SHA, diff statistics, and PR URLs via \`report_t3_git_metadata\` when running inside a T3 session.
  3. Post a comprehensive summary comment via \`add_comment({ taskId: "<TICKET_CODE>", body: "..." })\` covering the outcome, changes made, verification output, and the branch / PR URL.
  4. Move the task status to \`in_review\` (or mark \`done\` via \`complete_task({ id: "<TICKET_CODE>" })\` when the schema uses \`todo\` / \`in_progress\` / \`done\` and all work is verified). Never move a task directly to \`archived\`.
`;

export function loadLocalSkillTemplate(): string {
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(currentDir, "../templates/SKILL.md"),
      path.resolve(currentDir, "../../templates/SKILL.md"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        const content = readFileSync(candidate, "utf8");
        if (content.trim().length > 0) {
          return content;
        }
      }
    }
  } catch {
    // Fallback to embedded string
  }
  return BUNDLED_SKILL_MD;
}

export async function resolveSkillMarkdown(options?: {
  remoteUrl?: string | undefined;
  fetchFn?: typeof fetch | undefined;
  skipRemote?: boolean | undefined;
}): Promise<string> {
  const localContent = loadLocalSkillTemplate();
  if (options?.skipRemote) {
    return localContent;
  }

  const remoteUrl = options?.remoteUrl ?? DEFAULT_REMOTE_SKILL_URL;
  const fetchFn = options?.fetchFn;
  if (!fetchFn) {
    return localContent;
  }

  try {
    const response = await fetchFn(remoteUrl, {
      method: "GET",
      headers: { Accept: "text/markdown, text/plain" },
    });
    if (response.ok) {
      const text = await response.text();
      const trimmed = text.trim();
      if (
        (trimmed.startsWith("---") || trimmed.startsWith("#")) &&
        trimmed.includes("bitig")
      ) {
        return text;
      }
    }
  } catch {
    // Fallback to local template when offline or remote not reachable
  }

  return localContent;
}

export function getAgentSkillPaths(agentId: AgentId, homedir: string = os.homedir()): readonly string[] {
  switch (agentId) {
    case "claude":
      return [
        path.join(homedir, ".claude", "skills", "bitig", "SKILL.md"),
        path.join(homedir, ".claude", "commands", "bitig.md"),
      ];
    case "codex":
      return [
        path.join(homedir, ".agents", "skills", "bitig", "SKILL.md"),
        path.join(homedir, ".codex", "skills", "bitig", "SKILL.md"),
      ];
    case "opencode":
      return [path.join(homedir, ".config", "opencode", "command", "bitig.md")];
    case "cursor":
      return [path.join(homedir, ".agents", "skills", "bitig", "SKILL.md")];
    case "windsurf":
      return [path.join(homedir, ".agents", "skills", "bitig", "SKILL.md")];
    case "gemini":
      return [
        path.join(homedir, ".gemini", "skills", "bitig", "SKILL.md"),
        path.join(homedir, ".agents", "skills", "bitig", "SKILL.md"),
      ];
  }
}

export function installAgentSkills(
  agentIds: readonly AgentId[],
  homedir: string = os.homedir(),
  skillContent: string = loadLocalSkillTemplate(),
): string[] {
  const installedPaths = new Set<string>();
  for (const agentId of agentIds) {
    for (const targetPath of getAgentSkillPaths(agentId, homedir)) {
      mkdirSync(path.dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, skillContent, "utf8");
      installedPaths.add(targetPath);
    }
  }
  return [...installedPaths];
}

export function hasAgentSkillsInstalled(agentId: AgentId, homedir: string = os.homedir()): boolean {
  const paths = getAgentSkillPaths(agentId, homedir);
  return paths.length > 0 && paths.every((p) => existsSync(p));
}

export function removeAgentSkills(
  agentIds: readonly AgentId[],
  homedir: string = os.homedir(),
): string[] {
  const removedPaths: string[] = [];
  const seen = new Set<string>();

  for (const agentId of agentIds) {
    for (const targetPath of getAgentSkillPaths(agentId, homedir)) {
      if (seen.has(targetPath)) {
        continue;
      }
      seen.add(targetPath);
      if (existsSync(targetPath)) {
        rmSync(targetPath, { force: true });
        removedPaths.push(targetPath);
      }
    }
  }

  return removedPaths;
}

/**
 * Upward discovery of `.bitig` project linking files.
 */
import { parseProjectLink, PROJECT_LINK_FILE_NAME } from "@bitig/mcp-tools";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

export interface FoundProjectLink {
  readonly projectId: string;
  readonly filePath: string;
}

export function findProjectLink(startDir: string, homedir: string): FoundProjectLink | null {
  let current = path.resolve(startDir);
  const normalizedHome = path.resolve(homedir);
  let reachedTop = false;
  while (!reachedTop) {
    const candidate = path.join(current, PROJECT_LINK_FILE_NAME);
    if (existsSync(candidate)) {
      const content = readFileSync(candidate, "utf8");
      const parsed = parseProjectLink(content, candidate);
      return {
        projectId: parsed.project_id,
        filePath: candidate,
      };
    }

    if (current === normalizedHome || current === path.dirname(current)) {
      reachedTop = true;
    } else {
      current = path.dirname(current);
    }
  }

  return null;
}

/**
 * Schema and helpers for workspace-level `.bitig` project linking files.
 */
import { IdSchema, parseOrThrow } from "@bitig/core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

export const PROJECT_LINK_FILE_NAME = ".bitig";

export const ProjectLinkSchema = z.strictObject({
  project_id: IdSchema,
});

export type ProjectLink = z.output<typeof ProjectLinkSchema>;

export function serializeProjectLink(projectId: string): string {
  const data = parseOrThrow(ProjectLinkSchema, { project_id: projectId }, "serializeProjectLink");
  return stringifyYaml(data);
}

export function parseProjectLink(content: string, context = "parseProjectLink"): ProjectLink {
  const parsed: unknown = parseYaml(content);
  return parseOrThrow(ProjectLinkSchema, parsed, context);
}

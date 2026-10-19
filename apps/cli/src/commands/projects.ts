/**
 * 'bitig projects' subcommands.
 */
import {
  PROJECT_KINDS,
  RESOURCE_TYPES,
  resolveProjectRef,
  type Project,
  type ProjectKind,
  type ProjectResource,
  type ResourceType,
  type StorageProvider,
} from "@bitig/core";
import type { Command } from "commander";
import { formatOutput } from "../io/output";

function formatResources(resources: readonly ProjectResource[] | undefined): string {
  if (resources === undefined) return "(none)";
  return resources.map((r, i) => `${String(i + 1)}. [${r.type}] ${r.label}  ${r.url}`).join("\n");
}

/** Parses a 1-based position as typed on the command line into a 0-based index within `length`. */
function parsePosition(raw: string, length: number): number {
  const position = Number(raw);
  if (!Number.isInteger(position) || position < 1 || position > length) {
    throw new Error(`Invalid position '${raw}': use the link number shown by 'bitig projects show' (1, 2, ...)`);
  }
  return position - 1;
}

/** A link added without --label is named after its host, e.g. github.com. */
function defaultLabel(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function registerProjectsCommands(program: Command, getStorage: () => Promise<StorageProvider>): void {
  const projects = program.command("projects").description("Manage projects");

  // list
  projects
    .command("list")
    .description("List all projects")
    .option("--json", "Output JSON")
    .action(async (options: { json?: boolean }) => {
      const storage = await getStorage();
      const list = await storage.getProjects();
      const output = formatOutput(
        list,
        () => list.map((p) => `${p.id}\t${p.name}\t${p.kind}\t${p.key ?? ""}`).join("\n"),
        () => {
          if (list.length === 0) return "No projects found.";
          const rows = list.map((p) => `${p.id}  ${(p.key ?? "-").padEnd(10)}  ${p.kind.padEnd(12)}  ${p.name}`);
          return ["ID                                    KEY         KIND          NAME", ...rows].join("\n");
        },
        options,
      );
      if (output !== "") console.log(output);
    });

  // create
  projects
    .command("create <name>")
    .description("Create a new project")
    .option("-d, --description <desc>", "Project description")
    .option("-k, --kind <kind>", `Project kind (${PROJECT_KINDS.join(", ")})`)
    .option("--key <key>", "Key for ticket codes, e.g. BIT for BIT-12 (derived from the name if omitted)")
    .option("--json", "Output JSON")
    .action(
      async (name: string, options: { description?: string; kind?: string; key?: string; json?: boolean }) => {
        const storage = await getStorage();
        const project = await storage.createProject({
          name,
          description: options.description,
          kind: options.kind as ProjectKind | undefined,
          key: options.key,
        });
        const output = formatOutput(
          project,
          () => `${project.id}\t${project.name}`,
          () => `Created project ${project.name} (${project.id}), key ${project.key ?? "-"}`,
          options,
        );
        console.log(output);
      },
    );

  // update
  projects
    .command("update <id>")
    .description("Update project metadata")
    .option("-n, --name <name>", "New project name")
    .option("-d, --description <desc>", "New description")
    .option("-k, --kind <kind>", `New kind (${PROJECT_KINDS.join(", ")})`)
    .option("--key <key>", "New key for ticket codes; every task's code changes with it")
    .option("--json", "Output JSON")
    .action(
      async (
        ref: string,
        options: { name?: string; description?: string; kind?: string; key?: string; json?: boolean },
      ) => {
        const storage = await getStorage();
        const updated = await storage.updateProject(await resolveProjectRef(storage, ref), {
          name: options.name,
          description: options.description,
          kind: options.kind as ProjectKind | undefined,
          key: options.key,
        });
        const output = formatOutput(
          updated,
          () => `${updated.id}\t${updated.name}`,
          () => `Updated project ${updated.name} (${updated.id})`,
          options,
        );
        console.log(output);
      },
    );

  // show
  projects
    .command("show <id>")
    .description("Show a project and its links")
    .option("--json", "Output JSON")
    .action(async (ref: string, options: { json?: boolean }) => {
      const storage = await getStorage();
      const project = await storage.getProject(await resolveProjectRef(storage, ref));
      if (project === null) {
        throw new Error(`Project ${ref} not found`);
      }
      const output = formatOutput(
        project,
        () =>
          [
            `Project: ${project.name}`,
            `ID: ${project.id}`,
            `Key: ${project.key ?? "-"}`,
            `Kind: ${project.kind}`,
            `Description: ${project.description || "(none)"}`,
            "Links:",
            formatResources(project.resources),
          ].join("\n"),
        undefined,
        options,
      );
      console.log(output);
    });

  // link: external resources (repository, issue tracker, designs...). Positions are 1-based, as `projects show` prints them.
  const link = projects.command("link").description("Edit a project's links to outside resources");

  async function editResources(
    projectId: string,
    options: { json?: boolean },
    edit: (resources: ProjectResource[]) => ProjectResource[],
  ): Promise<void> {
    const storage = await getStorage();
    const id = await resolveProjectRef(storage, projectId);
    const project = await storage.getProject(id);
    if (project === null) {
      throw new Error(`Project ${projectId} not found`);
    }
    const updated: Project = await storage.updateProject(id, {
      resources: edit((project.resources ?? []).map((r) => ({ ...r }))),
    });
    const output = formatOutput(
      updated.resources ?? [],
      () => formatResources(updated.resources),
      () => `Links of '${updated.name}'\n${formatResources(updated.resources)}`,
      options,
    );
    console.log(output);
  }

  link
    .command("add <projectId> <url>")
    .description("Add a link at the end")
    .option("-l, --label <label>", "Display name (defaults to the URL's host)")
    .option("-t, --type <type>", `Link type (${RESOURCE_TYPES.join(", ")})`, "other")
    .option("--json", "Output JSON")
    .action(async (projectId: string, url: string, options: { label?: string; type: string; json?: boolean }) => {
      await editResources(projectId, options, (list) => [
        ...list,
        { type: options.type as ResourceType, label: options.label ?? defaultLabel(url), url },
      ]);
    });

  link
    .command("edit <projectId> <position>")
    .description("Change a link's URL, label or type")
    .option("-u, --url <url>", "New URL")
    .option("-l, --label <label>", "New display name")
    .option("-t, --type <type>", `New link type (${RESOURCE_TYPES.join(", ")})`)
    .option("--json", "Output JSON")
    .action(
      async (
        projectId: string,
        position: string,
        options: { url?: string; label?: string; type?: string; json?: boolean },
      ) => {
          await editResources(projectId, options, (list) => {
            const index = parsePosition(position, list.length);
            return list.map((r, i) =>
              i === index
                ? {
                    type: (options.type ?? r.type) as ResourceType,
                    label: options.label ?? r.label,
                    url: options.url ?? r.url,
                  }
                : r,
            );
          });
      },
    );

  link
    .command("remove <projectId> <position>")
    .description("Remove a link")
    .option("--json", "Output JSON")
    .action(async (projectId: string, position: string, options: { json?: boolean }) => {
      await editResources(projectId, options, (list) => {
        const index = parsePosition(position, list.length);
        return list.filter((_, i) => i !== index);
      });
    });

  // delete
  projects
    .command("delete <id>")
    .description("Permanently delete a project and all its tasks")
    .option("--json", "Output JSON")
    .action(async (ref: string, options: { json?: boolean }) => {
      const storage = await getStorage();
      const id = await resolveProjectRef(storage, ref);
      await storage.deleteProject(id);
      const output = formatOutput(
        { deletedProjectId: id },
        () => `Deleted project ${id}`,
        undefined,
        options,
      );
      console.log(output);
    });
}

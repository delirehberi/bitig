/**
 * 'bitig projects' subcommands.
 */
import { PROJECT_KINDS, type ProjectKind, type StorageProvider } from "@bitig/core";
import type { Command } from "commander";
import { formatOutput } from "../io/output";

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
        () => list.map((p) => `${p.id}\t${p.name}\t${p.kind}`).join("\n"),
        () => {
          if (list.length === 0) return "No projects found.";
          const rows = list.map((p) => `${p.id}  ${p.kind.padEnd(12)}  ${p.name}`);
          return ["ID                                    KIND          NAME", ...rows].join("\n");
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
    .option("--json", "Output JSON")
    .action(async (name: string, options: { description?: string; kind?: string; json?: boolean }) => {
      const storage = await getStorage();
      const project = await storage.createProject({
        name,
        description: options.description,
        kind: options.kind as ProjectKind | undefined,
      });
      const output = formatOutput(
        project,
        () => `${project.id}\t${project.name}`,
        () => `Created project ${project.name} (${project.id})`,
        options,
      );
      console.log(output);
    });

  // update
  projects
    .command("update <id>")
    .description("Update project metadata")
    .option("-n, --name <name>", "New project name")
    .option("-d, --description <desc>", "New description")
    .option("-k, --kind <kind>", `New kind (${PROJECT_KINDS.join(", ")})`)
    .option("--json", "Output JSON")
    .action(async (id: string, options: { name?: string; description?: string; kind?: string; json?: boolean }) => {
      const storage = await getStorage();
      const updated = await storage.updateProject(id, {
        name: options.name,
        description: options.description,
        kind: options.kind as ProjectKind | undefined,
      });
      const output = formatOutput(
        updated,
        () => `${updated.id}\t${updated.name}`,
        () => `Updated project ${updated.name} (${updated.id})`,
        options,
      );
      console.log(output);
    });

  // delete
  projects
    .command("delete <id>")
    .description("Permanently delete a project and all its tasks")
    .option("--json", "Output JSON")
    .action(async (id: string, options: { json?: boolean }) => {
      const storage = await getStorage();
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

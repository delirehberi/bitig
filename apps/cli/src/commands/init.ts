/**
 * 'bitig init' command — creates or links a project and writes ./.bitig.
 */
import { PROJECT_LINK_FILE_NAME, serializeProjectLink } from "@bitig/mcp-tools";
import type { Command } from "commander";
import { existsSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { formatOutput } from "../io/output";
import type { StorageFactory } from "../storage-factory";

export function registerInitCommand(program: Command, getStorage: StorageFactory): void {
  program
    .command("init")
    .description("Initialize and link current directory to a Bitig project")
    .option("-n, --name <name>", "Name of the new project to create")
    .option("-p, --project <id>", "Existing project ID to link to")
    .option("-f, --force", "Overwrite existing .bitig file")
    .option("--json", "Output JSON")
    .action(async (options: { name?: string; project?: string; force?: boolean; json?: boolean }) => {
      const targetFile = path.resolve(PROJECT_LINK_FILE_NAME);
      if (existsSync(targetFile) && !options.force) {
        throw new Error(`${PROJECT_LINK_FILE_NAME} already exists in this directory. Use --force to overwrite.`);
      }

      const storage = await getStorage({ createDataDir: true });
      let projectId: string;

      if (options.project !== undefined) {
        const existing = await storage.getProject(options.project);
        if (existing === null) {
          throw new Error(`Project ${options.project} not found`);
        }
        projectId = existing.id;
      } else {
        const name = options.name ?? path.basename(process.cwd());
        const created = await storage.createProject({ name });
        projectId = created.id;
      }

      const content = serializeProjectLink(projectId);
      writeFileSync(targetFile, content, { encoding: "utf8", mode: 0o644 });

      const output = formatOutput(
        { projectId, file: targetFile },
        () => `Linked current workspace to project ${projectId} (written to ${targetFile})`,
        undefined,
        options,
      );
      console.log(output);
    });
}


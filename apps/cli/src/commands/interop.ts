/**
 * 'bitig export', 'bitig import', 'bitig backup', 'bitig restore' subcommands.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  BackupBundleSchema,
  ProjectBundleSchema,
  parseOrThrow,
} from "@bitig/core";
import type { Command } from "commander";
import type { StorageFactory } from "../storage-factory";

export function registerInteropCommands(
  program: Command,
  getStorage: StorageFactory,
): void {
  program
    .command("export <projectId>")
    .description("Export a project and its tasks to JSON")
    .option("-f, --file <path>", "Output file path (defaults to stdout)")
    .action(async (projectId: string, options: { file?: string }) => {
      const storage = await getStorage();
      const bundle = await storage.exportProject(projectId);
      const json = JSON.stringify(bundle, null, 2);
      if (options.file) {
        writeFileSync(options.file, json, "utf8");
        console.log(
          `Exported project ${bundle.project.name} (${bundle.project.id}) with ${String(bundle.tasks.length)} task(s) to ${options.file}`,
        );
      } else {
        console.log(json);
      }
    });

  program
    .command("import <file>")
    .description("Import a project bundle from JSON file")
    .action(async (file: string) => {
      if (!existsSync(file)) {
        throw new Error(`File not found: ${file}`);
      }
      const text = readFileSync(file, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err: unknown) {
        throw new Error(`Invalid JSON in file: ${file}`, { cause: err });
      }
      const bundle = parseOrThrow(ProjectBundleSchema, parsed, "import");
      const storage = await getStorage({ createDataDir: true });
      const project = await storage.importProject(bundle);
      console.log(
        `Successfully imported project ${project.name} (${project.id}) with ${String(bundle.tasks.length)} task(s)`,
      );
    });

  program
    .command("backup")
    .description("Export full backup of all projects and tasks")
    .option("-f, --file <path>", "Output file path (defaults to stdout)")
    .action(async (options: { file?: string }) => {
      const storage = await getStorage();
      const backup = await storage.exportAll();
      const json = JSON.stringify(backup, null, 2);
      if (options.file) {
        writeFileSync(options.file, json, "utf8");
        console.log(
          `Backup completed: ${String(backup.bundles.length)} project(s) exported to ${options.file}`,
        );
      } else {
        console.log(json);
      }
    });

  program
    .command("restore <file>")
    .description("Restore full backup from JSON file")
    .action(async (file: string) => {
      if (!existsSync(file)) {
        throw new Error(`File not found: ${file}`);
      }
      const text = readFileSync(file, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err: unknown) {
        throw new Error(`Invalid JSON in file: ${file}`, { cause: err });
      }
      const backup = parseOrThrow(BackupBundleSchema, parsed, "restore");
      const storage = await getStorage({ createDataDir: true });
      await storage.importBackup(backup);
      console.log(`Successfully restored backup: ${String(backup.bundles.length)} project(s)`);
    });
}

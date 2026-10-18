/**
 * 'bitig paths' command — prints resolved paths and their sources.
 */
import type { Command } from "commander";
import { formatOutput } from "../io/output";
import type { ResolvedBitigPaths } from "../paths/resolve";

export function registerPathsCommand(program: Command, getPaths: () => ResolvedBitigPaths): void {
  program
    .command("paths")
    .description("Print resolved Bitig paths (data, config, lock) and their sources")
    .option("--json", "Output machine-readable JSON")
    .action((options: { json?: boolean }) => {
      const paths = getPaths();
      const output = formatOutput(
        paths,
        () =>
          [
            `Data directory:  ${paths.dataDir} (source: ${paths.dataDirSource})`,
            `Config file:     ${paths.configFile} (source: ${paths.configSource})`,
            `Lock file:       ${paths.lockFile}`,
          ].join("\n"),
        undefined,
        options,
      );
      console.log(output);
    });
}


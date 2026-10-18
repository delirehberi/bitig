/**
 * Formatted output for CLI: TTY table, piped TSV, and JSON.
 */
export interface OutputOptions {
  readonly json?: boolean;
}

export function formatOutput(
  data: unknown,
  tsvFormatter: () => string,
  tableFormatter?: () => string,
  opts?: OutputOptions,
): string {
  if (opts?.json) {
    return JSON.stringify(data, null, 2);
  }

  const isTty = process.stdout.isTTY;
  const noColor = Boolean(process.env.NO_COLOR) || process.env.TERM === "dumb";

  if (isTty && !noColor && tableFormatter !== undefined) {
    return tableFormatter();
  }

  return tsvFormatter();
}

/**
 * Stdin and $EDITOR input handlers for task descriptions.
 */
import { spawnSync } from "node:child_process";
import { promises as fs, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk, "utf8"));
    } else if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    } else if (chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk));
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readFromEditor(initialContent = ""): Promise<string> {
  const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
  const tmpFile = path.join(os.tmpdir(), `bitig-edit-${String(Date.now())}.md`);

  writeFileSync(tmpFile, initialContent, { encoding: "utf8", mode: 0o600 });
  try {
    const res = spawnSync(editor, [tmpFile], { stdio: "inherit" });
    if (res.status !== 0) {
      throw new Error(`Editor ${editor} exited with code ${String(res.status)}`);
    }
    return await fs.readFile(tmpFile, "utf8");
  } finally {
    try {
      await fs.unlink(tmpFile);
    } catch {
      // ignore
    }
  }
}

import { runStorageContractSuite, type TestRuntime } from "@bitig/core/testing";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MarkdownStorage } from "./markdown-storage";
import { NodeFileSystem } from "./node/node-fs";

runStorageContractSuite("MarkdownStorage", async (runtime: TestRuntime) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitig-contract-test-"));
  const nodeFs = new NodeFileSystem({ rootDir: tempDir });
  const storage = new MarkdownStorage({
    fs: nodeFs,
    deps: runtime,
  });

  return {
    storage,
    dispose: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
});


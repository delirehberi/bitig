import * as esbuild from "esbuild";
import { chmodSync } from "node:fs";

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node26",
  format: "esm",
  outfile: "dist/bitig.js",
  banner: {
    js: `#!/usr/bin/env node
import { createRequire as __createRequire } from "node:module";
const require = __createRequire(import.meta.url);
`,
  },
  sourcemap: true,
});

chmodSync("dist/bitig.js", 0o755);


// Build the gh-pages site artifacts:
//   1. docs/js/kcp-agent.js — the real planner/gate/formatter bundled for the
//      browser (ESM, from site/entry.ts). Node builtins are stubbed; the
//      Claude SDK stays external (the site never synthesizes).
//   2. docs/examples/ — a copy of the example manifests the arena plans over.
// Both outputs are gitignored and rebuilt by CI and the Pages deploy.

import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stub = path.join(ROOT, "site", "node-stub.js");

await build({
  entryPoints: [path.join(ROOT, "site", "entry.ts")],
  outfile: path.join(ROOT, "docs", "js", "kcp-agent.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: false,
  // format.ts reads process.stdout.isTTY / process.env at module level.
  banner: { js: "var process = globalThis.process ?? { stdout: {}, env: {} };" },
  alias: {
    "node:fs": stub,
    "node:path": stub,
    "node:crypto": stub,
    "node:readline": stub,
  },
  external: ["@anthropic-ai/sdk", "npm:@anthropic-ai/sdk@^0.68.0"],
  logLevel: "info",
});

const dest = path.join(ROOT, "docs", "examples");
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const ex of ["fjordwire", "vault"]) {
  cpSync(path.join(ROOT, "examples", ex), path.join(dest, ex), { recursive: true });
}
console.log("site built: docs/js/kcp-agent.js + docs/examples/{fjordwire,vault}");

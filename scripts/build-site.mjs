// Build the gh-pages site artifacts:
//   1. docs/js/kcp-demos.js — the LLM-adjacent demos (term gate + grounding),
//      bundled for the browser (ESM, from site/demos-entry.ts). The deterministic
//      planner itself is NOT here — it runs as WebAssembly (docs/pkg, built by
//      scripts/build-wasm.mjs), the same Rust core the CLI binary runs.
//   2. docs/examples/ — a copy of the example manifests the arena plans over.
// All outputs are gitignored and rebuilt by CI and the Pages deploy. The WASM
// module's integrity hash (the shipping planner) is written by build-wasm.mjs.

import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stub = path.join(ROOT, "site", "node-stub.js");

await build({
  entryPoints: [path.join(ROOT, "site", "demos-entry.ts")],
  outfile: path.join(ROOT, "docs", "js", "kcp-demos.js"),
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
    "node:dns/promises": stub,
    "node:net": stub,
  },
  external: ["@anthropic-ai/sdk", "npm:@anthropic-ai/sdk@^0.68.0"],
  logLevel: "info",
});

const bundlePath = path.join(ROOT, "docs", "js", "kcp-demos.js");
const sha256 = createHash("sha256").update(readFileSync(bundlePath)).digest("hex");
const kb = (readFileSync(bundlePath).length / 1024).toFixed(1);

const dest = path.join(ROOT, "docs", "examples");
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const ex of ["fjordwire", "vault", "incident", "summer"]) {
  cpSync(path.join(ROOT, "examples", ex), path.join(dest, ex), { recursive: true });
}
console.log(`site built: docs/js/kcp-demos.js (${kb} KB, sha256 ${sha256.slice(0, 12)}…) + docs/examples/{fjordwire,vault,incident,summer}`);

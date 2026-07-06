// Build the gh-pages site artifacts:
//   1. docs/js/kcp-agent.js — the real planner/gate/formatter bundled for the
//      browser (ESM, from site/entry.ts). Node builtins are stubbed; the
//      Claude SDK stays external (the site never synthesizes).
//   2. docs/examples/ — a copy of the example manifests the arena plans over.
//   3. docs/js/bundle-info.json — the bundle's sha256, surfaced on the site's
//      Receipts section so anyone can reproduce the hash from source.
// All outputs are gitignored and rebuilt by CI and the Pages deploy.

import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
    "node:dns/promises": stub,
    "node:net": stub,
  },
  external: ["@anthropic-ai/sdk", "npm:@anthropic-ai/sdk@^0.68.0"],
  logLevel: "info",
});

const bundlePath = path.join(ROOT, "docs", "js", "kcp-agent.js");
const sha256 = createHash("sha256").update(readFileSync(bundlePath)).digest("hex");
writeFileSync(
  path.join(ROOT, "docs", "js", "bundle-info.json"),
  JSON.stringify({ file: "js/kcp-agent.js", sha256 }, null, 2) + "\n"
);

const dest = path.join(ROOT, "docs", "examples");
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const ex of ["fjordwire", "vault", "incident", "summer"]) {
  cpSync(path.join(ROOT, "examples", ex), path.join(dest, ex), { recursive: true });
}
console.log(`site built: docs/js/kcp-agent.js (sha256 ${sha256.slice(0, 12)}…) + docs/examples/{fjordwire,vault,incident,summer}`);

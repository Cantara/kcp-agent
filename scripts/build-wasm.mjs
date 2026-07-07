// Build the WASM planner module for the browser playground.
//
//   cargo build --target wasm32-unknown-unknown --release   (the core, size-optimized)
//   wasm-bindgen --target web                                (JS glue → docs/pkg)
//   wasm-opt -Oz -all                                        (shrink; optional)
//
// Output: docs/pkg/kcp_planner_wasm.js + kcp_planner_wasm_bg.wasm — the same
// "generated site artifact, gitignored" pattern as scripts/build-site.mjs.
//
// Toolchain (install once):
//   rustup target add wasm32-unknown-unknown
//   cargo install wasm-bindgen-cli          # must match the wasm-bindgen crate version
//   npm i -g binaryen                        # provides wasm-opt (optional but recommended)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CRATE = join(ROOT, "rust", "kcp-planner-wasm");
const OUT = join(ROOT, "docs", "pkg");
const WASM_IN = join(CRATE, "target", "wasm32-unknown-unknown", "release", "kcp_planner_wasm.wasm");
const WASM_OUT = join(OUT, "kcp_planner_wasm_bg.wasm");

// Size budget from issue #48: < 500 KB raw, < 200 KB gzipped.
const MAX_RAW = 500 * 1024;
const MAX_GZIP = 200 * 1024;

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function have(cmd) {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

run("cargo", ["build", "--manifest-path", join(CRATE, "Cargo.toml"), "--target", "wasm32-unknown-unknown", "--release"]);

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
run("wasm-bindgen", [WASM_IN, "--out-dir", OUT, "--target", "web", "--no-typescript"]);

if (have("wasm-opt")) {
  const tmp = WASM_OUT + ".opt";
  run("wasm-opt", ["-Oz", "-all", WASM_OUT, "-o", tmp]);
  run("mv", [tmp, WASM_OUT]);
} else {
  console.warn("⚠ wasm-opt not found (npm i -g binaryen) — shipping unoptimized WASM; size budget may not be met.");
}

const raw = statSync(WASM_OUT).size;
const gzip = gzipSync(readFileSync(WASM_OUT)).length;
const kb = (n) => (n / 1024).toFixed(1) + " KB";
console.log(`\ndocs/pkg/kcp_planner_wasm_bg.wasm: ${kb(raw)} raw, ${kb(gzip)} gzipped`);

let over = false;
if (raw >= MAX_RAW) {
  console.error(`✗ raw ${kb(raw)} exceeds ${kb(MAX_RAW)} budget`);
  over = true;
}
if (gzip >= MAX_GZIP) {
  console.error(`✗ gzipped ${kb(gzip)} exceeds ${kb(MAX_GZIP)} budget`);
  over = true;
}
if (over) process.exit(1);
console.log(`✓ within size budget (< ${kb(MAX_RAW)} raw, < ${kb(MAX_GZIP)} gzipped)`);

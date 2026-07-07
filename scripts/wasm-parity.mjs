// WASM ↔ CLI parity harness. Loads the browser WASM module in Node and checks
// that plan/trace/diff/validate produce byte-identical JSON to the native CLI
// binary for the same inputs. The only environmental difference is the manifest
// `source` label (a file path on the CLI, "playground.yaml" in the browser), so
// that one field is normalized before comparison.
//
// Usage: node scripts/wasm-parity.mjs [path-to-kcp-planner-binary]

import { readFileSync, existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import init, { plan, trace, diff_plans, validate, parse_manifest, format_plan } from "../docs/pkg/kcp_planner_wasm.js";

const BIN = process.argv[2] || "rust/kcp-planner/target/release/kcp-planner";
const wasmBytes = readFileSync("docs/pkg/kcp_planner_wasm_bg.wasm");
await init({ module_or_path: wasmBytes });

let pass = 0;
let fail = 0;
const failures = [];

// Normalize the environmental `source` label so a file path and "playground.yaml"
// compare equal — everything else (selection, budget, sha256, signature) must match.
const normSource = (s) => s.replace(/"source": "[^"]*"/g, '"source": "<SRC>"');

function cli(args) {
  // diff (differing) and validate (invalid) exit non-zero by design; capture
  // stdout regardless — execFileSync throws on non-zero exit but attaches it.
  try {
    return execFileSync(BIN, args, { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  } catch (e) {
    if (e.stdout != null) return e.stdout.toString();
    throw e;
  }
}

function check(name, wasmOut, cliOut) {
  if (normSource(wasmOut.trim()) === normSource(cliOut.trim())) {
    pass++;
  } else {
    fail++;
    failures.push({ name, wasmOut, cliOut });
  }
}

// Unsigned manifests only: a browser can't fetch a local .sig, so signed
// manifests read as unverifiable in WASM (by design) and wouldn't match.
const MANIFESTS = [
  "examples/fjordwire",
  "examples/vault",
  "examples/org/hub",
  "examples/org/platform",
  "examples/summer/registry",
  "examples/milky-way/brand",
];
const TASKS = ["authenticate device", "pricing and payment", "sovereign compute award", "temporal deprecated policy"];
const ASOF = "2026-07-07";

function manifestFile(dir) {
  for (const c of [`${dir}/knowledge.yaml`, `${dir}/.well-known/knowledge.yaml`]) {
    if (existsSync(c)) return c;
  }
  throw new Error(`no knowledge.yaml in ${dir}`);
}

for (const dir of MANIFESTS) {
  const file = manifestFile(dir);
  const yaml = readFileSync(file, "utf8");
  for (const task of TASKS) {
    for (const opt of [{}, { contextBudget: 3000 }, { maxUnits: 2, strict: true }, { budget: { amount: 5, currency: "USD" } }]) {
      const options = { asOf: ASOF, ...opt };
      const optionsJson = JSON.stringify(options);

      // plan
      const cliArgs = ["plan", task, "--manifest", file, "--as-of", ASOF, "--json"];
      if (opt.contextBudget) cliArgs.push("--context-budget", String(opt.contextBudget));
      if (opt.maxUnits) cliArgs.push("--max-units", String(opt.maxUnits));
      if (opt.strict) cliArgs.push("--strict");
      if (opt.budget) cliArgs.push("--budget", String(opt.budget.amount), "--currency", opt.budget.currency);
      check(`plan ${dir} "${task}" ${JSON.stringify(opt)}`, plan(yaml, task, optionsJson), cli(cliArgs));

      // trace + format_plan (only for the plain option set — keeps the matrix small)
      if (Object.keys(opt).length === 0) {
        const traceArgs = ["plan", task, "--manifest", file, "--as-of", ASOF, "--trace", "--json"];
        check(`trace ${dir} "${task}"`, trace(yaml, task, optionsJson), cli(traceArgs));
        // format_plan → the human render `kcp-planner plan` prints (source label differs).
        const human = format_plan(yaml, task, optionsJson);
        const cliHuman = cli(["plan", task, "--manifest", file, "--as-of", ASOF]);
        const stripSrc = (s) => s.replaceAll(file, "<SRC>").replaceAll("playground.yaml", "<SRC>");
        if (stripSrc(human.trim()) === stripSrc(cliHuman.trim())) pass++;
        else { fail++; failures.push({ name: `format_plan ${dir} "${task}"`, wasmOut: human, cliOut: cliHuman }); }
      }
    }
  }
  // validate
  check(`validate ${dir}`, validate(yaml), cli(["validate", file, "--json"]));
  // parse_manifest: sanity — the units the playground introspects are present.
  const parsed = JSON.parse(parse_manifest(yaml));
  if (parsed.units && parsed.units.length > 0) pass++;
  else { fail++; failures.push({ name: `parse_manifest ${dir}`, wasmOut: parse_manifest(yaml), cliOut: "(expected units[])" }); }
}

// diff: build two plan artifacts with the CLI, diff them both ways
const yaml = readFileSync(manifestFile("examples/fjordwire"), "utf8");
const pa = plan(yaml, "authenticate device pricing", JSON.stringify({ asOf: ASOF }));
const pb = plan(yaml, "authenticate device pricing", JSON.stringify({ asOf: ASOF, contextBudget: 2000, maxUnits: 2 }));
const dir = mkdtempSync(join(tmpdir(), "wasm-diff-"));
writeFileSync(join(dir, "a.json"), pa);
writeFileSync(join(dir, "b.json"), pb);
check("diff a b", diff_plans(pa, pb), cli(["diff", join(dir, "a.json"), join(dir, "b.json"), "--json"]));
check("diff a a", diff_plans(pa, pa), cli(["diff", join(dir, "a.json"), join(dir, "a.json"), "--json"]));

console.log(`WASM ↔ CLI parity: ${pass} identical, ${fail} differ`);
if (fail > 0) {
  for (const f of failures.slice(0, 3)) {
    console.log(`\n=== ${f.name} ===`);
    const w = normSource(f.wasmOut.trim()).split("\n");
    const c = normSource(f.cliOut.trim()).split("\n");
    for (let i = 0; i < Math.max(w.length, c.length); i++) {
      if (w[i] !== c[i]) console.log(`  L${i}: WASM ${JSON.stringify(w[i])} | CLI ${JSON.stringify(c[i])}`);
    }
  }
  process.exit(1);
}

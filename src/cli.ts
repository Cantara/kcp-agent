#!/usr/bin/env node
// kcp-agent — a reference agent that consumes KCP end to end.
//
//   kcp-agent plan "<task>" --manifest <path|dir|url> [options]   inspect the load plan (no API key)
//   kcp-agent ask  "<task>" --manifest <path|dir|url> [options]   plan + answer via Claude
//
// Options (both commands):
//   --manifest <loc>     path, directory, or HTTPS URL of a knowledge.yaml (required)
//   --env <name>         runtime environment for federation context selection (dev/test/staging/prod)
//   --as-of <date>       ISO date for temporal evaluation (default: today, UTC)
//   --max-units <n>      cap on selected units (default 5)
//   --strict             fail-closed: drop non-eligible units instead of listing them
//   --role <role>        audience role the agent presents (default: agent)
//   --methods <list>     payment methods the agent can settle (default: free), e.g. free,x402
//   --credentials <list> credential kinds the agent holds, e.g. api_key,oauth2
//   --attest <provider>  attestation provider the agent can present
//   --json               emit the plan as JSON
//   ask only:
//   --model <id>         Claude model id (default: claude-opus-4-8)

import { loadManifest } from "./client.js";
import { plan, type PlanOptions } from "./planner.js";
import { formatPlan } from "./format.js";
import { synthesize } from "./synthesize.js";

interface Args {
  command: string;
  task?: string;
  manifest?: string;
  env?: string;
  asOf?: string;
  maxUnits?: number;
  strict: boolean;
  role?: string;
  methods?: string[];
  credentials?: string[];
  attest?: string;
  json: boolean;
  model?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { command: argv[0] ?? "", strict: false, json: false };
  const rest = argv.slice(1);
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    const next = () => rest[++i];
    switch (t) {
      case "--manifest": a.manifest = next(); break;
      case "--env": a.env = next(); break;
      case "--as-of": a.asOf = next(); break;
      case "--max-units": a.maxUnits = Number(next()); break;
      case "--strict": a.strict = true; break;
      case "--role": a.role = next(); break;
      case "--methods": a.methods = (next() ?? "").split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--credentials": a.credentials = (next() ?? "").split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--attest": a.attest = next(); break;
      case "--model": a.model = next(); break;
      case "--json": a.json = true; break;
      default:
        if (t.startsWith("--")) { console.error(`Unknown option: ${t}`); process.exit(2); }
        positionals.push(t);
    }
  }
  a.task = positionals.join(" ") || undefined;
  return a;
}

function buildPlanOptions(a: Args): PlanOptions {
  return {
    env: a.env,
    asOf: a.asOf,
    maxUnits: a.maxUnits,
    strict: a.strict,
    capabilities: {
      ...(a.role ? { role: a.role } : {}),
      ...(a.methods ? { paymentMethods: a.methods } : {}),
      ...(a.credentials ? { credentials: a.credentials } : {}),
      ...(a.attest ? { attestationProvider: a.attest } : {}),
    },
  };
}

const USAGE =
  'Usage:\n' +
  '  kcp-agent plan "<task>" --manifest <path|dir|url> [options]\n' +
  '  kcp-agent ask  "<task>" --manifest <path|dir|url> [options]\n' +
  "\nRun `kcp-agent plan --help` for options.";

async function main() {
  const a = parseArgs(process.argv.slice(2));

  if (a.command === "" || a.command === "--help" || a.command === "-h" || a.command === "help") {
    console.log(USAGE);
    process.exit(a.command === "" ? 2 : 0);
  }
  if (a.command !== "plan" && a.command !== "ask") {
    console.error(`Unknown command: ${a.command}\n\n${USAGE}`);
    process.exit(2);
  }
  if (!a.task) { console.error("Missing task.\n\n" + USAGE); process.exit(2); }
  if (!a.manifest) { console.error("Missing --manifest.\n\n" + USAGE); process.exit(2); }

  const manifest = await loadManifest(a.manifest);
  const p = plan(manifest, a.task, buildPlanOptions(a));

  if (a.command === "plan") {
    console.log(a.json ? JSON.stringify(p, null, 2) : formatPlan(p));
    return;
  }

  // ask: show the plan, then synthesize.
  if (!a.json) console.log(formatPlan(p));
  const result = await synthesize(p, { model: a.model });
  if (a.json) {
    console.log(JSON.stringify({ plan: p, synthesis: result }, null, 2));
    return;
  }
  console.log("─".repeat(60));
  console.log(`Answer (via ${result.model}, from ${result.unitsLoaded.length} unit(s)):\n`);
  console.log(result.answer);
  if (result.unitsUnavailable.length) {
    console.log("\n" + result.unitsUnavailable.map((u) => `  · ${u.id}: ${u.reason}`).join("\n"));
  }
}

main().catch((err) => {
  console.error(`kcp-agent: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

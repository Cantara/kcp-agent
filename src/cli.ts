#!/usr/bin/env node
// kcp-agent — a reference agent that consumes KCP end to end.
//
//   kcp-agent plan     "<task>" --manifest <path|dir|url> [options]   inspect the load plan (no API key)
//   kcp-agent ask      "<task>" --manifest <path|dir|url> [options]   plan + answer via Claude
//   kcp-agent validate <path|dir|url>                                 lint a knowledge.yaml
//   kcp-agent replay   <plan.json>                                    re-verify a saved plan artifact (exit 1 on drift)
//   kcp-agent mcp                                                     serve the planner over MCP stdio
//
// Options (plan/ask):
//   --manifest <loc>      path, directory, or HTTPS URL of a knowledge.yaml (required)
//   --env <name>          runtime environment for federation context selection (dev/test/staging/prod)
//   --as-of <date>        ISO date for temporal evaluation (default: today, UTC)
//   --max-units <n>       cap on selected units (default 5)
//   --strict              fail-closed: drop non-eligible units instead of listing them
//   --role <role>         audience role the agent presents (default: agent)
//   --methods <list>      payment methods the agent can settle (default: free), e.g. free,x402
//   --credentials <list>  credential kinds the agent holds, e.g. api_key,oauth2
//   --attest <provider>   attestation provider the agent can present
//   --budget <amount>     spend ceiling for pay-per-request units (greedy by score, skip what blows it)
//   --currency <code>     budget currency (default USDC)
//   --follow              fetch and plan eligible federation refs too
//   --max-depth <n>       federation hops to follow (default 1, implies --follow)
//   --max-nodes <n>       cap on total manifests fetched across the walk (default 64)
//   --allow-private-hosts permit fetches to loopback/private/link-local hosts (and http://) — off by default
//   --no-verify           skip manifest signature verification
//   --require-signature   fail unless every manifest has a verified signature
//   --trust-key <loc>     pinned ed25519 public key (path, URL, or inline) for verification
//   --json                emit the result as JSON
//   ask only:
//   --model <id>          Claude model id (default: claude-opus-4-8)
//   --loop                audited critique loop: plan → LLM gap critique → re-plan → answer
//   --max-rounds <n>      max critique rounds for --loop (default 3)
//   --loop-model <id>     critic model for --loop (default: claude-haiku-4-5)
//   --ground              verify each answer claim against a loaded unit; surface unsubstantiated ones
//   --ground-model <id>   verifier model for --ground (default: claude-haiku-4-5)

import { readFileSync } from "node:fs";
import type { PlanOptions } from "./planner.js";
import type { FetchGuard } from "./fetch.js";
import { planTree, plans, type FollowOptions } from "./follow.js";
import { formatPlan, formatPlanTree, formatValidation, formatReplay, formatGrounded } from "./format.js";
import { synthesize, loadAnthropicSdk, type SynthesisResult } from "./synthesize.js";
import { groundAnswer, makeClaudeVerifier } from "./ground.js";
import { askLoop } from "./loop.js";
import { validateLocation } from "./validate.js";
import { replayArtifact } from "./replay.js";
import { serveMcp } from "./mcp.js";

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
  budget?: number;
  currency?: string;
  follow: boolean;
  maxDepth?: number;
  maxNodes?: number;
  allowPrivateHosts: boolean;
  noVerify: boolean;
  requireSignature: boolean;
  trustKey?: string;
  json: boolean;
  model?: string;
  loop: boolean;
  maxRounds?: number;
  loopModel?: string;
  ground: boolean;
  groundModel?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { command: argv[0] ?? "", strict: false, json: false, follow: false, allowPrivateHosts: false, noVerify: false, requireSignature: false, loop: false, ground: false };
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
      case "--budget": a.budget = Number(next()); break;
      case "--currency": a.currency = next(); break;
      case "--follow": a.follow = true; break;
      case "--max-depth": a.maxDepth = Number(next()); a.follow = true; break;
      case "--max-nodes": a.maxNodes = Number(next()); break;
      case "--allow-private-hosts": a.allowPrivateHosts = true; break;
      case "--no-verify": a.noVerify = true; break;
      case "--require-signature": a.requireSignature = true; break;
      case "--trust-key": a.trustKey = next(); break;
      case "--model": a.model = next(); break;
      case "--loop": a.loop = true; break;
      case "--max-rounds": a.maxRounds = Number(next()); break;
      case "--loop-model": a.loopModel = next(); break;
      case "--ground": a.ground = true; break;
      case "--ground-model": a.groundModel = next(); break;
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
    budget: a.budget !== undefined && !Number.isNaN(a.budget) ? { amount: a.budget, currency: a.currency } : undefined,
    capabilities: {
      ...(a.role ? { role: a.role } : {}),
      ...(a.methods ? { paymentMethods: a.methods } : {}),
      ...(a.credentials ? { credentials: a.credentials } : {}),
      ...(a.attest ? { attestationProvider: a.attest } : {}),
    },
  };
}

function buildFetchGuard(a: Args): FetchGuard {
  return { allowPrivate: a.allowPrivateHosts };
}

function buildFollowOptions(a: Args): FollowOptions {
  return {
    planOptions: buildPlanOptions(a),
    maxDepth: a.follow ? (a.maxDepth ?? 1) : 0,
    maxNodes: a.maxNodes,
    noVerify: a.noVerify,
    requireSignature: a.requireSignature,
    trustedKey: a.trustKey,
    fetchGuard: buildFetchGuard(a),
  };
}

const USAGE =
  'Usage:\n' +
  '  kcp-agent plan     "<task>" --manifest <path|dir|url> [options]\n' +
  '  kcp-agent ask      "<task>" --manifest <path|dir|url> [options]\n' +
  '  kcp-agent validate <path|dir|url> [--json]\n' +
  '  kcp-agent replay   <plan.json> [--json]\n' +
  '  kcp-agent mcp\n' +
  "\nRun `kcp-agent plan --help` for options.";

async function main() {
  const a = parseArgs(process.argv.slice(2));

  if (a.command === "" || a.command === "--help" || a.command === "-h" || a.command === "help") {
    console.log(USAGE);
    process.exit(a.command === "" ? 2 : 0);
  }

  if (a.command === "mcp") {
    await serveMcp();
    return;
  }

  if (a.command === "validate") {
    const location = a.manifest ?? a.task;
    if (!location) { console.error("Missing manifest location.\n\n" + USAGE); process.exit(2); }
    const report = await validateLocation(location, buildFetchGuard(a));
    console.log(a.json ? JSON.stringify(report, null, 2) : formatValidation(report));
    process.exit(report.ok ? 0 : 1);
  }

  if (a.command === "replay") {
    const file = a.manifest ?? a.task;
    if (!file) { console.error("Missing plan artifact path.\n\n" + USAGE); process.exit(2); }
    const artifact = JSON.parse(readFileSync(file, "utf8"));
    const report = await replayArtifact(artifact, file, buildFetchGuard(a));
    console.log(a.json ? JSON.stringify(report, null, 2) : formatReplay(report));
    process.exit(report.ok ? 0 : 1);
  }

  if (a.command !== "plan" && a.command !== "ask") {
    console.error(`Unknown command: ${a.command}\n\n${USAGE}`);
    process.exit(2);
  }
  if (!a.task) { console.error("Missing task.\n\n" + USAGE); process.exit(2); }
  if (!a.manifest) { console.error("Missing --manifest.\n\n" + USAGE); process.exit(2); }

  if (a.command === "ask" && a.loop) {
    const r = await askLoop(a.manifest, a.task, {
      maxRounds: a.maxRounds,
      loopModel: a.loopModel,
      synthesisModel: a.model,
      followOptions: buildFollowOptions(a),
    });
    if (a.json) { console.log(JSON.stringify(r, null, 2)); return; }
    console.log(formatPlan(r.basePlans[0]));
    for (const round of r.rounds) {
      const terms = round.acceptedTerms.length ? round.acceptedTerms.join(", ") : "(none accepted)";
      const added = round.addedUnits.length ? `+units ${round.addedUnits.join(", ")}` : "no new units";
      console.log(`Loop round ${round.round}${round.model ? ` (${round.model})` : ""}: +terms ${terms} → ${added}`);
      if (round.note) console.log(`  critic: ${round.note}`);
    }
    console.log(`Loop converged (${r.converged}) after ${r.rounds.length} round(s) · expanded task: "${r.expandedTask}"`);
    if (r.rounds.some((x) => x.addedUnits.length > 0)) console.log(formatPlan(r.finalPlans[0]));
    printAnswer(r.synthesis);
    return;
  }

  const tree = await planTree(a.manifest, a.task, buildFollowOptions(a));
  if (tree.error) throw new Error(`${tree.location}: ${tree.error}`);
  const allPlans = plans(tree);

  if (a.command === "plan") {
    if (a.json) console.log(JSON.stringify(a.follow ? tree : allPlans[0], null, 2));
    else console.log(a.follow ? formatPlanTree(tree) : formatPlan(allPlans[0]));
    return;
  }

  // ask: show the plan(s), then synthesize across every followed manifest.
  if (!a.json) console.log(a.follow ? formatPlanTree(tree) : formatPlan(allPlans[0]));
  const result = await synthesize(allPlans, { model: a.model, fetchGuard: buildFetchGuard(a) });

  // --ground: verify the answer against the loaded units and surface the gaps.
  const grounding = a.ground
    ? await groundAnswer(a.task, result.answer, result.unitsLoaded, {
        verifier: makeClaudeVerifier(loadAnthropicSdk, a.groundModel),
      })
    : undefined;

  if (a.json) {
    console.log(JSON.stringify({ plan: a.follow ? tree : allPlans[0], synthesis: result, grounding }, null, 2));
    return;
  }
  printAnswer(result);
  if (grounding) console.log(formatGrounded(grounding));
}

function printAnswer(result: SynthesisResult) {
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

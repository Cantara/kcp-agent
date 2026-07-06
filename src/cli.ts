#!/usr/bin/env node
// kcp-agent — a reference agent that consumes KCP end to end.
//
//   kcp-agent plan     "<task>" --manifest <path|dir|url> [options]   inspect the load plan (no API key)
//   kcp-agent ask      "<task>" --manifest <path|dir|url> [options]   plan + answer via Claude
//   kcp-agent validate <path|dir|url>                                 lint a knowledge.yaml
//   kcp-agent replay   <artifact.json>                                re-verify a saved plan OR grounded-answer artifact (exit 1 on drift)
//                                                                     --check-gaps: re-navigate to see if a surfaced gap now closes
//   kcp-agent remember <artifact.json> --memory <dir>                 log a plan/grounded-answer artifact to episodic memory (unit bytes stripped)
//   kcp-agent recall   "<task>" --memory <dir>                        recall past episodes by task overlap; --replay re-verifies each against today's world
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
//   --ground-rounds <n>   closed-loop grounding: a surfaced gap re-navigates for evidence (default 0)
//   memory (remember/recall):
//   --memory <dir>        episodic-memory directory (one hash-addressed entry per artifact)
//   --replay              recall only: re-verify each hit against today's manifests (drifted → exit 1)
//   --limit <n>           recall only: cap the number of episodes returned

import { readFileSync } from "node:fs";
import type { PlanOptions } from "./planner.js";
import type { FetchGuard } from "./fetch.js";
import { planTree, plans, type FollowOptions } from "./follow.js";
import { formatPlan, formatPlanTree, formatValidation, formatReplay, formatGrounded, formatGroundedReplay, formatRecall } from "./format.js";
import { synthesize, loadAnthropicSdk, loadPlannedUnits, type SynthesisResult } from "./synthesize.js";
import { groundAnswer, makeClaudeVerifier } from "./ground.js";
import { replayGroundedAnswer } from "./replayground.js";
import { groundingLoop, type GroundRoundFn } from "./groundloop.js";
import { askLoop } from "./loop.js";
import { validateLocation } from "./validate.js";
import { replayArtifact } from "./replay.js";
import { serveMcp } from "./mcp.js";
import { toEntry, fileStore, recall, type MemoryEntry, type RecallReplay } from "./memory.js";

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
  groundRounds?: number;
  checkGaps: boolean;
  memory?: string;
  replay: boolean;
  limit?: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { command: argv[0] ?? "", strict: false, json: false, follow: false, allowPrivateHosts: false, noVerify: false, requireSignature: false, loop: false, ground: false, checkGaps: false, replay: false };
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
      case "--ground-rounds": a.groundRounds = Number(next()); a.ground = true; break;
      case "--check-gaps": a.checkGaps = true; break;
      case "--json": a.json = true; break;
      case "--memory": a.memory = next(); break;
      case "--replay": a.replay = true; break;
      case "--limit": a.limit = Number(next()); break;
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

/** The `--check-gaps` reground seam: re-plan the artifact's manifest today and see which gap claims now ground. */
function buildReground(artifact: unknown, a: Args, guard: FetchGuard): (task: string, gapClaims: string[]) => Promise<string[]> {
  const a2 = artifact as { plan?: { manifest?: { source?: string }; plan?: { manifest?: { source?: string } } } };
  const source = a2.plan?.manifest?.source ?? a2.plan?.plan?.manifest?.source;
  return async (task, gapClaims) => {
    if (!source) return [];
    const tree = await planTree(source, task, { ...buildFollowOptions(a), fetchGuard: guard });
    if (tree.error) return [];
    const units = [];
    for (const p of plans(tree)) units.push(...(await loadPlannedUnits(p, guard)).loaded);
    // Treat the gap claims as a mini-answer and re-ground them against today's units.
    const g = await groundAnswer(task, gapClaims.join(" "), units, { verifier: makeClaudeVerifier(loadAnthropicSdk, a.groundModel) });
    return g.grounded.map((c) => c.claim);
  };
}

/** The `recall --replay` seam: re-verify a recalled episode against today's world, dispatching by kind. */
function buildRecallReplay(guard: FetchGuard): RecallReplay {
  return async (entry: MemoryEntry) => {
    try {
      if (entry.kind === "grounded-answer") {
        const r = await replayGroundedAnswer(entry.artifact, entry.id, { fetchGuard: guard });
        const drifted = r.claims.filter((c) => c.status !== "still-grounded").length;
        return { ok: r.ok, detail: r.ok ? "every cited unit holds its pinned bytes" : `${drifted} cited unit(s) drifted or gone` };
      }
      const r = await replayArtifact(entry.artifact, entry.id, guard);
      const changed = r.checks.filter((c) => c.status !== "identical").length;
      return { ok: r.ok, detail: r.ok ? "plan re-verifies against the live manifest" : `${changed} node(s) drifted since recorded` };
    } catch (err) {
      // A replay that cannot run (network, gone manifest) is unverifiable — never falsely "valid".
      return { ok: false, unverifiable: true, detail: `could not replay: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
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
  '  kcp-agent remember <artifact.json> --memory <dir>\n' +
  '  kcp-agent recall   "<task>" --memory <dir> [--replay] [--limit <n>]\n' +
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
    if (!file) { console.error("Missing artifact path.\n\n" + USAGE); process.exit(2); }
    const artifact = JSON.parse(readFileSync(file, "utf8"));
    const guard = buildFetchGuard(a);
    // A grounded-answer artifact (from `ask --ground --json`) is re-verified
    // claim-by-claim; a plan/tree artifact goes through the plan replay.
    const g = artifact as { grounding?: { claims?: unknown } };
    if (g.grounding && Array.isArray(g.grounding.claims)) {
      const reground = a.checkGaps ? buildReground(artifact, a, guard) : undefined;
      const report = await replayGroundedAnswer(artifact, file, { fetchGuard: guard, reground });
      console.log(a.json ? JSON.stringify(report, null, 2) : formatGroundedReplay(report));
      process.exit(report.ok ? 0 : 1);
    }
    const report = await replayArtifact(artifact, file, guard);
    console.log(a.json ? JSON.stringify(report, null, 2) : formatReplay(report));
    process.exit(report.ok ? 0 : 1);
  }

  if (a.command === "remember") {
    const file = a.task ?? a.manifest;
    if (!file) { console.error("Missing artifact path.\n\n" + USAGE); process.exit(2); }
    if (!a.memory) { console.error("Missing --memory <dir>.\n\n" + USAGE); process.exit(2); }
    const artifact = JSON.parse(readFileSync(file, "utf8"));
    const entry = toEntry(artifact, new Date().toISOString());
    await fileStore(a.memory).append(entry);
    if (a.json) { console.log(JSON.stringify({ id: entry.id, kind: entry.kind, task: entry.task }, null, 2)); return; }
    console.log(`Remembered ${entry.kind} ${entry.id.slice(0, 12)}… — "${entry.task}" (content stripped; only the replay skeleton is kept)`);
    return;
  }

  if (a.command === "recall") {
    if (!a.task) { console.error("Missing task.\n\n" + USAGE); process.exit(2); }
    if (!a.memory) { console.error("Missing --memory <dir>.\n\n" + USAGE); process.exit(2); }
    const guard = buildFetchGuard(a);
    // --replay re-verifies each hit against the live world, dispatching by kind.
    const replay: RecallReplay | undefined = a.replay ? buildRecallReplay(guard) : undefined;
    const hits = await recall(fileStore(a.memory), a.task, { replay, limit: a.limit });
    if (a.json) { console.log(JSON.stringify(hits, null, 2)); return; }
    console.log(formatRecall(a.task, hits));
    // Fail-closed exit: a drifted hit is a signal, not a clean recall.
    process.exit(hits.some((h) => h.status === "drifted") ? 1 : 0);
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

  // ask --ground-rounds N: closed-loop grounding — a surfaced gap re-navigates for evidence.
  if (a.command === "ask" && a.ground && (a.groundRounds ?? 0) > 0) {
    const navigate: GroundRoundFn = async (extraTerms) => {
      const expanded = extraTerms.length ? `${a.task} ${extraTerms.join(" ")}` : a.task!;
      const t = await planTree(a.manifest!, expanded, buildFollowOptions(a));
      if (t.error) throw new Error(`${t.location}: ${t.error}`);
      const ps = plans(t);
      const budgetBlocked = ps.some((p) => p.skipped.some((s) => /over budget/.test(s.reason)));
      // Synthesis answers the ORIGINAL task; expansion only steered discovery.
      const synthPlans = ps.map((p, i) => (i === 0 ? { ...p, task: a.task! } : p));
      const syn = await synthesize(synthPlans, { model: a.model, fetchGuard: buildFetchGuard(a) });
      return { units: syn.unitsLoaded, answer: syn.answer, budgetBlocked };
    };
    const loop = await groundingLoop({
      task: a.task,
      navigate,
      verifier: makeClaudeVerifier(loadAnthropicSdk, a.groundModel),
      maxRounds: a.groundRounds,
    });
    if (a.json) { console.log(JSON.stringify(loop, null, 2)); return; }
    console.log("─".repeat(60));
    console.log(`Answer (from ${loop.rounds.at(-1)?.addedUnitIds.length ?? 0} new unit(s) across ${loop.rounds.length} round(s)):\n`);
    console.log(loop.answer);
    for (const round of loop.rounds.slice(1)) {
      console.log(`  ground round ${round.round}: +terms ${round.seededTerms.join(", ") || "(none)"} → +units ${round.addedUnitIds.join(", ") || "(none)"} · ${round.gaps} gap(s) left`);
    }
    console.log(formatGrounded(loop.final));
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

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
//   kcp-agent diff     <a.json> <b.json>                              compare two saved plan artifacts (exit 0 identical, exit 1 changed)
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
//   --context-budget <n>  token ceiling for what a plan loads into the model's context window (greedy by score; over-budget units skipped with the arithmetic)
//   --currency <code>     budget currency (default USDC)
//   --follow              fetch and plan eligible federation refs too
//   --max-depth <n>       federation hops to follow (default 1, implies --follow)
//   --max-nodes <n>       cap on total manifests fetched across the walk (default 64)
//   --allow-private-hosts permit fetches to loopback/private/link-local hosts (and http://) — off by default
//   --no-verify           skip manifest signature verification
//   --require-signature   fail unless every manifest has a verified signature
//   --trust-key <loc>     pinned ed25519 public key (path, URL, or inline) for verification
//   --trace               show the decision trace: per-unit gate cascade (plan only)
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
import { loadManifest } from "./client.js";
import { formatPlan, formatPlanTree, formatValidation, formatReplay, formatGrounded, formatGroundedReplay, formatRecall, formatTrace, formatDiff } from "./format.js";
import { synthesize, loadAnthropicSdk, loadPlannedUnits, type SynthesisResult } from "./synthesize.js";
import { groundAnswer, makeClaudeVerifier } from "./ground.js";
import { replayGroundedAnswer } from "./replayground.js";
import { groundingLoop, type GroundRoundFn } from "./groundloop.js";
import { askLoop } from "./loop.js";
import { validateLocation } from "./validate.js";
import { replayArtifact } from "./replay.js";
import { serveMcp } from "./mcp.js";
import { toEntry, fileStore, recall, type MemoryEntry, type RecallReplay } from "./memory.js";
import { reuse } from "./reuse.js";
import { trace as traceDecision } from "./trace.js";
import { diffPlans } from "./diff.js";

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
  contextBudget?: number;
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
  trace: boolean;
  positionals: string[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = { command: argv[0] ?? "", strict: false, json: false, follow: false, allowPrivateHosts: false, noVerify: false, requireSignature: false, loop: false, ground: false, checkGaps: false, replay: false, trace: false, positionals: [] };
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
      case "--context-budget": a.contextBudget = Number(next()); break;
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
      case "--trace": a.trace = true; break;
      default:
        if (t.startsWith("--")) { console.error(`Unknown option: ${t}`); process.exit(2); }
        positionals.push(t);
    }
  }
  a.positionals = positionals;
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
    contextBudget: a.contextBudget !== undefined && !Number.isNaN(a.contextBudget) ? a.contextBudget : undefined,
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

/** A stable digest of the planner inputs — the reuse cache key (a plan is a function of these). */
function buildOptionsKey(a: Args): string {
  // A run with no pinned --as-of implicitly uses today, so bake the effective
  // date in: an unpinned plan is only reuse-eligible within the same day.
  const asOf = a.asOf ?? new Date().toISOString().slice(0, 10);
  return JSON.stringify({
    env: a.env ?? null,
    asOf,
    maxUnits: a.maxUnits ?? null,
    strict: a.strict,
    role: a.role ?? null,
    methods: a.methods ?? null,
    credentials: a.credentials ?? null,
    attest: a.attest ?? null,
    budget: a.budget ?? null,
    currency: a.currency ?? null,
    contextBudget: a.contextBudget ?? null,
    follow: a.follow,
    maxDepth: a.maxDepth ?? null,
    maxNodes: a.maxNodes ?? null,
  });
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
  '  kcp-agent diff     <a.json> <b.json> [--json]\n' +
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

  if (a.command === "diff") {
    if (a.positionals.length < 2) {
      console.error("Usage: kcp-agent diff <a.json> <b.json> [--json]\n\n" + USAGE);
      process.exit(2);
    }
    const planA = JSON.parse(readFileSync(a.positionals[0], "utf8"));
    const planB = JSON.parse(readFileSync(a.positionals[1], "utf8"));
    // Accept raw plans or tree/ask wrappers (extract .plan when present).
    const extractPlan = (obj: any) => obj.plan ?? obj;
    const d = diffPlans(extractPlan(planA), extractPlan(planB));
    console.log(a.json ? JSON.stringify(d, null, 2) : formatDiff(d));
    process.exit(d.identical ? 0 : 1);
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
    // --trace: produce the decision trace (gate cascade for every unit).
    if (a.trace) {
      const manifest = await loadManifest(a.manifest!, buildFetchGuard(a));
      const t = traceDecision(manifest, a.task!, buildPlanOptions(a));
      if (a.json) { console.log(JSON.stringify(t, null, 2)); return; }
      console.log(formatPlan(t.plan));
      console.log(formatTrace(t));
      return;
    }
    if (a.json) console.log(JSON.stringify(a.follow ? tree : allPlans[0], null, 2));
    else console.log(a.follow ? formatPlanTree(tree) : formatPlan(allPlans[0]));
    // --memory: report determinism against a prior episode (fail-closed on sha drift), then record.
    if (a.memory) {
      const store = fileStore(a.memory);
      const rootPlan = allPlans[0] as { manifest?: { source?: string; sha256?: string } };
      const source = rootPlan.manifest?.source;
      const freshSha = rootPlan.manifest?.sha256;
      const optionsKey = buildOptionsKey(a);
      if (source) {
        // "Freshness" for a plan is just sha equality with the fetch we already did — no extra I/O.
        const shaReplay: RecallReplay = async (e) =>
          e.manifestSha === freshSha
            ? { ok: true, detail: `manifest@${(freshSha ?? "").slice(0, 12)}… unchanged` }
            : { ok: false, detail: `manifest drifted: episode ${(e.manifestSha ?? "?").slice(0, 12)}… ≠ today ${(freshSha ?? "?").slice(0, 12)}…` };
        const d = await reuse(store, { task: a.task, manifestSource: source, optionsKey, kind: "plan" }, { replay: shaReplay });
        if (!a.json) {
          if (d.status === "reuse") console.log(`\n♻ determinism: provably identical to episode ${d.entry!.id.slice(0, 12)}… (${d.entry!.recordedAt}) — ${d.detail}`);
          else if (d.status === "drifted") console.log(`\n⚠ ${d.detail} since episode ${d.entry!.id.slice(0, 12)}… (${d.entry!.recordedAt}) — this plan differs from the recorded one`);
          else console.log(`\n· new episode for this task + manifest + options`);
        }
        await store.append(toEntry(allPlans[0], new Date().toISOString(), { optionsKey }));
      }
    }
    return;
  }

  // ask: show the plan(s), then synthesize across every followed manifest.
  if (!a.json) console.log(a.follow ? formatPlanTree(tree) : formatPlan(allPlans[0]));

  // --memory + --ground: try to reuse a cached grounded answer BEFORE calling the
  // model. Reuse is granted only if every cited unit still holds its pinned bytes
  // (replayGroundedAnswer), so a stale answer is re-computed, never served.
  const optionsKey = buildOptionsKey(a);
  const source = (allPlans[0] as { manifest?: { source?: string } }).manifest?.source;
  const store = a.memory ? fileStore(a.memory) : undefined;
  if (store && a.ground && source) {
    const d = await reuse(
      store,
      { task: a.task, manifestSource: source, optionsKey, kind: "grounded-answer" },
      { replay: buildRecallReplay(buildFetchGuard(a)) },
    );
    if (d.status === "reuse") {
      const art = d.artifact as { synthesis?: { answer?: string; unitsLoaded?: unknown[] }; grounding?: Parameters<typeof formatGrounded>[0] };
      if (a.json) { console.log(JSON.stringify({ reused: d.entry!.id, ...(art as object) }, null, 2)); return; }
      console.log(`\n♻ reused grounded answer from episode ${d.entry!.id.slice(0, 12)}… (${d.entry!.recordedAt}) — ${d.detail}`);
      console.log("─".repeat(60));
      console.log(`Answer (reused, from ${art.synthesis?.unitsLoaded?.length ?? 0} unit(s)):\n`);
      console.log(art.synthesis?.answer ?? "");
      if (art.grounding) console.log(formatGrounded(art.grounding));
      return;
    }
    if (!a.json && d.status === "drifted") console.log(`\n⚠ cached answer stale (${d.detail}) — re-answering.`);
  }

  const result = await synthesize(allPlans, { model: a.model, fetchGuard: buildFetchGuard(a) });

  // --ground: verify the answer against the loaded units and surface the gaps.
  const grounding = a.ground
    ? await groundAnswer(a.task, result.answer, result.unitsLoaded, {
        verifier: makeClaudeVerifier(loadAnthropicSdk, a.groundModel),
      })
    : undefined;

  // Record the episode so the next identical, grounded ask can reuse it.
  if (store && grounding) {
    await store.append(toEntry({ plan: allPlans[0], synthesis: result, grounding }, new Date().toISOString(), { optionsKey }));
  }

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

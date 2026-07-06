// The audited LLM loop — the model proposes, the plan disposes.
//
// The deterministic planner stays the sole authority over eligibility: trust,
// access, temporal, audience, and budget gates are never touched by a model.
// The LLM operates only *between* plans, as a gap critic: it sees a metadata
// digest of the current plan (ids, intents, scores, skip reasons — never unit
// content), and proposes additional lowercase search terms for what the plan
// may have missed. Each proposal passes a deterministic gate (sanitize, dedupe,
// cap), the task string is extended, and the planner re-plans from scratch.
// The chain of plans is the audit log: every round records what was proposed,
// what was accepted, and exactly which units that added.
//
// Nothing is loaded and nothing is paid for until the loop has converged; the
// final plan's budget arithmetic gates spending exactly as in single-shot mode.

import type { AgentPlan } from "./planner.js";
import { planTree, plans, type FollowOptions } from "./follow.js";
import { synthesize, loadAnthropicSdk, type SynthesisResult } from "./synthesize.js";

/** Metadata-only view of a plan set, safe to show a model: no unit content. */
export interface PlanDigest {
  manifests: string[];
  selected: { id: string; intent: string; score: number; loadEligible: boolean; reasons: string[] }[];
  skipped: { id: string; reason: string }[];
  budget?: { projectedSpend?: number; ceiling?: number; remaining?: number; currency?: string };
}

export interface CritiqueInput {
  task: string;
  round: number;
  digest: PlanDigest;
  maxTerms: number;
}

export interface Critique {
  /** Proposed additional search terms; empty means "the plan covers the task". */
  terms: string[];
  note?: string;
}

export type Critic = (input: CritiqueInput) => Promise<Critique>;

export interface LoopRound {
  round: number;
  model?: string;
  proposedTerms: string[];
  acceptedTerms: string[];
  rejectedTerms: string[];
  note?: string;
  /** Unit ids newly selected by the re-plan, vs the previous round. */
  addedUnits: string[];
  /** The full re-planned artifacts — the audit log entry for this round. */
  plans: AgentPlan[];
}

export type Convergence = "no-terms" | "no-new-units" | "max-rounds";

export interface LoopResult {
  task: string;
  /** The task string the final plan was computed from (task + accepted terms). */
  expandedTask: string;
  basePlans: AgentPlan[];
  rounds: LoopRound[];
  finalPlans: AgentPlan[];
  converged: Convergence;
}

export interface LoopOptions {
  /** Max LLM critique rounds (default 3). The base plan is round 0. */
  maxRounds?: number;
  /** Critic model (default a fast Haiku — the critic only proposes terms). */
  loopModel?: string;
  /** Accepted expansion terms per round (default 6). */
  maxTerms?: number;
  /** Injectable critic — tests and embedders can supply a deterministic one. */
  critic?: Critic;
  followOptions?: FollowOptions;
}

const DEFAULT_LOOP_MODEL = "claude-haiku-4-5";
const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_MAX_TERMS = 6;

/**
 * Sanitize one proposed term: lowercase words/short phrases only. Letters and
 * digits in any script — "strømnett" is vocabulary; `$(curl …)` is not. The
 * gate passes only word-shaped strings, by construction.
 */
const TERM_RE = /^[\p{L}\p{N}][\p{L}\p{N} -]{0,39}$/u; // input is lowercased before the test

/** The deterministic gate on critic output: sanitize, drop known vocabulary, dedupe, cap. */
export function gateTerms(proposed: string[], alreadyKnown: string, maxTerms: number): {
  accepted: string[];
  rejected: string[];
} {
  const known = new Set(alreadyKnown.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const accepted: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const raw of proposed) {
    const t = String(raw).toLowerCase().trim().replace(/\s+/g, " ");
    if (!TERM_RE.test(t) || seen.has(t)) { rejected.push(String(raw)); continue; }
    seen.add(t);
    const words = t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (words.every((w) => known.has(w))) { rejected.push(String(raw)); continue; }
    if (accepted.length >= maxTerms) { rejected.push(String(raw)); continue; }
    accepted.push(t);
  }
  return { accepted, rejected };
}

export function digestPlans(all: AgentPlan[]): PlanDigest {
  const root = all[0];
  return {
    manifests: all.map((p) => p.manifest.project),
    selected: all.flatMap((p) =>
      p.selected.map((u) => ({ id: u.id, intent: u.intent, score: u.score, loadEligible: u.loadEligible, reasons: u.reasons }))
    ),
    skipped: all.flatMap((p) => p.skipped),
    budget: root
      ? { projectedSpend: root.budget.projectedSpend, ceiling: root.budget.ceiling, remaining: root.budget.remaining, currency: root.budget.currency }
      : undefined,
  };
}

const CRITIC_SYSTEM =
  "You are the gap critic inside a deterministic KCP navigation loop. A planner selected " +
  "knowledge units for a task; you see only plan metadata (ids, intents, scores, skip reasons) — " +
  "never unit content. Your ONLY job: if the plan likely missed relevant knowledge because the " +
  "task's wording didn't lexically match the publisher's vocabulary, propose additional lowercase " +
  "search terms (single words or short phrases). You cannot change any gate: access, trust, " +
  "temporal, and budget decisions are the planner's alone, and terms you propose only affect " +
  "relevance scoring. Respond with strict JSON only: " +
  '{"terms": ["..."], "note": "one short sentence"} — an empty terms array if the plan already covers the task.';

/** The default critic: a fast Claude model proposing terms from the plan digest. */
export function claudeCritic(model: string): Critic {
  return async ({ task, round, digest, maxTerms }) => {
    const Anthropic = await loadAnthropicSdk();
    const client = new Anthropic();
    const message = await client.messages.create({
      model,
      max_tokens: 512,
      system: CRITIC_SYSTEM,
      messages: [
        {
          role: "user",
          content:
            `Task: ${task}\nCritique round: ${round}\nPropose at most ${maxTerms} terms.\n\n` +
            `Plan digest (metadata only):\n${JSON.stringify(digest, null, 2)}`,
        },
      ],
    });
    const text = message.content
      .filter((b): b is { type: "text"; text: string } & typeof b => b.type === "text")
      .map((b) => b.text)
      .join("");
    // Fail closed on anything that isn't the JSON we asked for: no terms, loop converges.
    try {
      const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      const terms = Array.isArray(json.terms) ? json.terms.map(String) : [];
      return { terms, note: typeof json.note === "string" ? json.note : undefined };
    } catch {
      return { terms: [], note: "critic output was not valid JSON — treated as no proposals" };
    }
  };
}

/** Run the plan → critique → re-plan loop. Deterministic given the critic's outputs. */
export async function runLoop(location: string, task: string, options: LoopOptions = {}): Promise<LoopResult> {
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxTerms = options.maxTerms ?? DEFAULT_MAX_TERMS;
  const model = options.loopModel ?? DEFAULT_LOOP_MODEL;
  const critic = options.critic ?? claudeCritic(model);
  const follow = options.followOptions ?? {};

  const planAll = async (t: string): Promise<AgentPlan[]> => {
    const tree = await planTree(location, t, follow);
    if (tree.error) throw new Error(`${tree.location}: ${tree.error}`);
    return plans(tree);
  };

  let expandedTask = task;
  const basePlans = await planAll(expandedTask);
  let current = basePlans;
  const selectedIds = new Set(current.flatMap((p) => p.selected.map((u) => u.id)));
  const rounds: LoopRound[] = [];
  let converged: Convergence = "max-rounds";

  for (let round = 1; round <= maxRounds; round++) {
    const critique = await critic({ task, round, digest: digestPlans(current), maxTerms });
    const { accepted, rejected } = gateTerms(critique.terms, expandedTask, maxTerms);
    if (accepted.length === 0) {
      rounds.push({
        round, model: options.critic ? undefined : model,
        proposedTerms: critique.terms, acceptedTerms: [], rejectedTerms: rejected,
        note: critique.note, addedUnits: [], plans: current,
      });
      converged = "no-terms";
      break;
    }
    expandedTask = `${expandedTask} ${accepted.join(" ")}`;
    const next = await planAll(expandedTask);
    const added: string[] = [];
    for (const p of next) {
      for (const u of p.selected) {
        if (!selectedIds.has(u.id)) { selectedIds.add(u.id); added.push(u.id); }
      }
    }
    rounds.push({
      round, model: options.critic ? undefined : model,
      proposedTerms: critique.terms, acceptedTerms: accepted, rejectedTerms: rejected,
      note: critique.note, addedUnits: added, plans: next,
    });
    current = next;
    if (added.length === 0) { converged = "no-new-units"; break; }
  }

  return { task, expandedTask, basePlans, rounds, finalPlans: current, converged };
}

/** The full `ask --loop`: run the loop, then synthesize from the final plans only. */
export async function askLoop(
  location: string,
  task: string,
  options: LoopOptions & { synthesisModel?: string } = {}
): Promise<LoopResult & { synthesis: SynthesisResult }> {
  const loop = await runLoop(location, task, options);
  // Synthesis answers the ORIGINAL task; expansion terms only steered discovery.
  const synthPlans = loop.finalPlans.map((p, i) => (i === 0 ? { ...p, task } : p));
  const synthesis = await synthesize(synthPlans, { model: options.synthesisModel, fetchGuard: options.followOptions?.fetchGuard });
  return { ...loop, synthesis };
}

// Conformance test vectors (#34) — the deterministic planner's behavior frozen
// as data. A vector is `(manifest, task, options) → expected outcome`; a second
// implementation of the KCP core (e.g. a Go port) is conformant iff it
// reproduces every vector's outcome exactly. That is the strongest proof a
// *protocol* is unambiguous: two independent implementations that agree on
// every decision validate the spec, not just the code.
//
// The `outcome` is a normalized projection of the full AgentPlan — the
// load-bearing, portable decisions, with the English skip/federation reasons
// included (the "every decision is a sentence" contract is part of the spec).

import { parseManifest } from "./client.js";
import { plan, type AgentPlan, type PlanOptions } from "./planner.js";

/** The portable, implementation-agnostic result a conformant planner must reproduce. */
export interface VectorOutcome {
  selected: { id: string; loadEligible: boolean; score: number }[];
  skipped: { id: string; reason: string }[];
  federation: { id: string; selected: boolean; reason: string; credentialNeeded?: string }[];
  trust: { requiresAttestation: boolean; agentCanAttest: boolean };
  budget: { rateTier: string; ceiling?: number; projectedSpend?: number; remaining?: number; currency?: string };
  context: { ceiling?: number; projectedTokens?: number; remaining?: number; approximate: boolean; unmeasured: number };
  warnings: string[];
}

/** A single conformance fixture: inputs + the expected outcome. Serialized to JSON in `vectors/`. */
export interface ConformanceVector {
  name: string;
  /** The spec layer this vector exercises, e.g. "§4.22". */
  spec: string;
  description: string;
  /** The manifest as raw YAML text — a conformant implementation parses this itself. */
  manifest: string;
  task: string;
  options: PlanOptions;
  expect: VectorOutcome;
}

/** Project a full plan down to its portable, comparable outcome. */
export function outcomeOf(p: AgentPlan): VectorOutcome {
  return {
    selected: p.selected.map((u) => ({ id: u.id, loadEligible: u.loadEligible, score: u.score })),
    skipped: p.skipped.map((s) => ({ id: s.id, reason: s.reason })),
    federation: p.federation.map((f) => ({
      id: f.id,
      selected: f.selected,
      reason: f.reason,
      ...(f.credentialNeeded !== undefined ? { credentialNeeded: f.credentialNeeded } : {}),
    })),
    trust: { requiresAttestation: p.trust.requiresAttestation, agentCanAttest: p.trust.agentCanAttest },
    budget: {
      rateTier: p.budget.rateTier,
      ...(p.budget.ceiling !== undefined ? { ceiling: p.budget.ceiling } : {}),
      ...(p.budget.projectedSpend !== undefined ? { projectedSpend: p.budget.projectedSpend } : {}),
      ...(p.budget.remaining !== undefined ? { remaining: p.budget.remaining } : {}),
      ...(p.budget.currency !== undefined ? { currency: p.budget.currency } : {}),
    },
    context: {
      ...(p.context.ceiling !== undefined ? { ceiling: p.context.ceiling } : {}),
      ...(p.context.projectedTokens !== undefined ? { projectedTokens: p.context.projectedTokens } : {}),
      ...(p.context.remaining !== undefined ? { remaining: p.context.remaining } : {}),
      approximate: p.context.approximate,
      unmeasured: p.context.unmeasured,
    },
    warnings: p.warnings,
  };
}

/** Parse a vector's manifest, run the planner, and return the outcome to compare against `expect`. */
export function runVector(v: ConformanceVector): VectorOutcome {
  return outcomeOf(plan(parseManifest(v.manifest, v.name), v.task, v.options));
}

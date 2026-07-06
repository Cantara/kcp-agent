// Closed-loop grounding — the second feedback edge of the reasoning loop.
//
// Terminal grounding (ground.ts) verifies what was loaded and surfaces gaps.
// This closes the loop: an unsupported claim seeds reformulation terms, the
// agent re-navigates to try to find the missing evidence, and re-grounds. It is
// a DISTINCT loop from the critique loop (loop.ts) — its own round cap, its own
// signal (unsupported claims, not term-stability) — sharing only the absorbing
// term gate and the budget ledger.
//
// Termination is guaranteed by three independent bounds, any one of which halts:
//   1. the term gate is absorbing — a term accepted once is known forever, so
//      re-navigation can only ever add units from the finite eligible set;
//   2. a hard round cap (maxRounds), separate from the critique cap;
//   3. the progress guard — a round that adds no genuinely new unit halts.
// Together they make oscillation impossible: the loaded set grows monotonically
// or the loop stops. Every terminal state that isn't "grounded" still SURFACES
// the remaining gaps — a gap is never dropped to fake completion.

import { groundAnswer, type GroundUnit, type GroundedAnswer, type Verifier } from "./ground.js";
import { gateTerms } from "./loop.js";
import { terms } from "./planner.js";

/** Re-navigate + re-synthesize for the accumulated extra terms; returns the loaded units and a fresh answer. */
export type GroundRoundFn = (accumulatedTerms: string[]) => Promise<{
  units: GroundUnit[];
  answer: string;
  /** True when eligible units were left unloaded because the budget ceiling stopped them. */
  budgetBlocked?: boolean;
}>;

export type GroundLoopStatus = "grounded" | "partial-unsupported" | "partial-budget" | "partial-rounds";

export interface GroundLoopRound {
  round: number;
  /** Terms the gaps seeded into navigation this round (empty for the base round). */
  seededTerms: string[];
  /** Units newly loaded this round vs everything loaded before it. */
  addedUnitIds: string[];
  /** Ungrounded claims remaining after grounding this round. */
  gaps: number;
}

export interface GroundLoopResult {
  status: GroundLoopStatus;
  /** The final synthesized answer text (from the last navigation round). */
  answer: string;
  /** The final grounding — surfaces any remaining gaps, whatever the terminal state. */
  final: GroundedAnswer;
  rounds: GroundLoopRound[];
}

export interface GroundLoopOptions {
  task: string;
  navigate: GroundRoundFn;
  verifier: Verifier;
  /** Re-navigation rounds beyond the base (default 2). */
  maxRounds?: number;
  /** Accepted seed terms per round (default 6). */
  maxTermsPerRound?: number;
  /** Max gaps surfaced per grounding (passed through to groundAnswer). */
  maxGaps?: number;
}

const ungrounded = (g: GroundedAnswer): string[] => g.claims.filter((c) => !c.grounded).map((c) => c.claim);

export async function groundingLoop(options: GroundLoopOptions): Promise<GroundLoopResult> {
  const maxRounds = options.maxRounds ?? 2;
  const maxTermsPerRound = options.maxTermsPerRound ?? 6;
  const rounds: GroundLoopRound[] = [];
  const seenIds = new Set<string>();
  const accumulatedTerms: string[] = [];
  let knownVocab = options.task; // absorbing gate baseline

  // Base round.
  let nav = await options.navigate([]);
  nav.units.forEach((u) => seenIds.add(u.id));
  let g = await groundAnswer(options.task, nav.answer, nav.units, { verifier: options.verifier, maxGaps: options.maxGaps });
  rounds.push({ round: 0, seededTerms: [], addedUnitIds: nav.units.map((u) => u.id), gaps: ungrounded(g).length });
  if (ungrounded(g).length === 0) return { status: "grounded", answer: nav.answer, final: g, rounds };

  for (let r = 1; r <= maxRounds; r++) {
    // Seed terms from the unsupported claims, through the absorbing gate.
    const proposed = terms(ungrounded(g).join(" "));
    const { accepted } = gateTerms(proposed, knownVocab, maxTermsPerRound);
    if (accepted.length === 0) {
      // The gate is dry — re-navigation can't widen. Halt, gaps surfaced.
      return { status: "partial-unsupported", answer: nav.answer, final: g, rounds };
    }
    accumulatedTerms.push(...accepted);
    knownVocab += " " + accepted.join(" ");

    nav = await options.navigate(accumulatedTerms);
    const addedUnitIds = nav.units.filter((u) => !seenIds.has(u.id)).map((u) => u.id);
    if (addedUnitIds.length === 0) {
      // No new evidence reachable. Distinguish a budget wall from true exhaustion.
      return { status: nav.budgetBlocked ? "partial-budget" : "partial-unsupported", answer: nav.answer, final: g, rounds };
    }
    addedUnitIds.forEach((id) => seenIds.add(id));

    g = await groundAnswer(options.task, nav.answer, nav.units, { verifier: options.verifier, maxGaps: options.maxGaps });
    rounds.push({ round: r, seededTerms: accepted, addedUnitIds, gaps: ungrounded(g).length });
    if (ungrounded(g).length === 0) return { status: "grounded", answer: nav.answer, final: g, rounds };
  }

  // Rounds exhausted with gaps remaining — surfaced, not dropped.
  return { status: "partial-rounds", answer: nav.answer, final: g, rounds };
}

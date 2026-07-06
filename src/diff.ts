// Plan diff — compare two AgentPlan artifacts and report what changed.
// Pure — no I/O, no model. A diff tells you what moved between two runs:
// units that flipped between selected/skipped, score shifts, manifest changes,
// budget/context projection differences. Because the planner is deterministic,
// every difference has a cause — the diff names the symptoms; the trace explains them.

import type { AgentPlan } from "./planner.js";

/** A unit that moved between selected and skipped (or vice versa). */
export interface UnitMove {
  id: string;
  direction: "selected_to_skipped" | "skipped_to_selected";
  /** Context from the "from" side. */
  from: { score?: number; reason?: string };
  /** Context from the "to" side. */
  to: { score?: number; reason?: string };
}

/** A unit whose score changed while remaining selected in both plans. */
export interface ScoreChange {
  id: string;
  before: number;
  after: number;
  delta: number;
}

/** A unit present in one plan but not the other. */
export interface UnitPresence {
  id: string;
  side: "a_only" | "b_only";
}

/** A numeric shift in budget or context projections. */
export interface BudgetShift {
  field: string;
  before?: number;
  after?: number;
}

/** A unit that stayed skipped in both plans but with a different reason. */
export interface ReasonChange {
  id: string;
  before: string;
  after: string;
}

/** The complete diff between two plans. */
export interface PlanDiff {
  a: { project: string; version: string; task: string; asOf: string };
  b: { project: string; version: string; task: string; asOf: string };
  identical: boolean;
  moves: UnitMove[];
  scoreChanges: ScoreChange[];
  presence: UnitPresence[];
  budgetShifts: BudgetShift[];
  reasonChanges: ReasonChange[];
  warningChanges: { added: string[]; removed: string[] };
}

/** Compare two AgentPlan artifacts and report what changed. Pure. */
export function diffPlans(a: AgentPlan, b: AgentPlan): PlanDiff {
  const aSelected = new Map(a.selected.map((u) => [u.id, u]));
  const aSkipped = new Map(a.skipped.map((s) => [s.id, s]));
  const bSelected = new Map(b.selected.map((u) => [u.id, u]));
  const bSkipped = new Map(b.skipped.map((s) => [s.id, s]));

  const allIdsA = new Set([...aSelected.keys(), ...aSkipped.keys()]);
  const allIdsB = new Set([...bSelected.keys(), ...bSkipped.keys()]);

  const moves: UnitMove[] = [];
  const scoreChanges: ScoreChange[] = [];
  const presence: UnitPresence[] = [];
  const reasonChanges: ReasonChange[] = [];

  // Walk all ids from both plans.
  const allIds = new Set([...allIdsA, ...allIdsB]);
  for (const id of allIds) {
    const inA = allIdsA.has(id);
    const inB = allIdsB.has(id);

    if (inA && !inB) { presence.push({ id, side: "a_only" }); continue; }
    if (!inA && inB) { presence.push({ id, side: "b_only" }); continue; }

    const selA = aSelected.get(id);
    const selB = bSelected.get(id);
    const skipA = aSkipped.get(id);
    const skipB = bSkipped.get(id);

    if (selA && skipB) {
      moves.push({
        id,
        direction: "selected_to_skipped",
        from: { score: selA.score },
        to: { reason: skipB.reason },
      });
    } else if (skipA && selB) {
      moves.push({
        id,
        direction: "skipped_to_selected",
        from: { reason: skipA.reason },
        to: { score: selB.score },
      });
    } else if (selA && selB && selA.score !== selB.score) {
      scoreChanges.push({ id, before: selA.score, after: selB.score, delta: selB.score - selA.score });
    } else if (skipA && skipB && skipA.reason !== skipB.reason) {
      reasonChanges.push({ id, before: skipA.reason, after: skipB.reason });
    }
  }

  // Budget/context shifts.
  const budgetShifts: BudgetShift[] = [];
  const numFields: [string, number | undefined, number | undefined][] = [
    ["budget.ceiling", a.budget.ceiling, b.budget.ceiling],
    ["budget.projectedSpend", a.budget.projectedSpend, b.budget.projectedSpend],
    ["budget.remaining", a.budget.remaining, b.budget.remaining],
    ["context.ceiling", a.context.ceiling, b.context.ceiling],
    ["context.projectedTokens", a.context.projectedTokens, b.context.projectedTokens],
    ["context.remaining", a.context.remaining, b.context.remaining],
  ];
  for (const [field, before, after] of numFields) {
    if (before !== after) budgetShifts.push({ field, before, after });
  }

  // Warning changes.
  const warnA = new Set(a.warnings);
  const warnB = new Set(b.warnings);
  const added = b.warnings.filter((w) => !warnA.has(w));
  const removed = a.warnings.filter((w) => !warnB.has(w));

  const identical =
    moves.length === 0 &&
    scoreChanges.length === 0 &&
    presence.length === 0 &&
    budgetShifts.length === 0 &&
    reasonChanges.length === 0 &&
    added.length === 0 &&
    removed.length === 0;

  return {
    a: { project: a.manifest.project, version: a.manifest.version, task: a.task, asOf: a.asOf },
    b: { project: b.manifest.project, version: b.manifest.version, task: b.task, asOf: b.asOf },
    identical,
    moves,
    scoreChanges,
    presence,
    budgetShifts,
    reasonChanges,
    warningChanges: { added, removed },
  };
}

// Decision trace — the planner's gate cascade made transparent. Every unit in
// the manifest is evaluated through an ordered series of gates; the trace
// records each verdict so a human, LLM, or downstream agent can see *why*
// the plan looks the way it does — without re-running the planner.
//
// The trace wraps plan(): it produces the canonical plan first, then annotates
// every unit with structured gate records. The canonical plan is always the
// authority — the trace is a read, not a fork.

import type { Manifest, Unit } from "./model.js";
import {
  plan,
  terms,
  scoreUnit,
  unitTokens,
  temporalStatus,
  selectableSuccessor,
  planPayment,
  DEFAULT_CAPABILITIES,
  type AgentCapabilities,
  type AgentPlan,
  type PlanOptions,
} from "./planner.js";

/** Gate names in the evaluation order the planner walks. */
export type GateName =
  | "audience"
  | "not_for"
  | "temporal"
  | "deprecated"
  | "supersession"
  | "relevance"
  | "attestation"
  | "payment"
  | "access"
  | "strict"
  | "max_units"
  | "money_budget"
  | "context_budget";

/** The full cascade in order. */
export const GATE_ORDER: readonly GateName[] = [
  "audience", "not_for", "temporal", "deprecated", "supersession",
  "relevance", "attestation", "payment", "access", "strict",
  "max_units", "money_budget", "context_budget",
] as const;

/** A single gate's verdict for a single unit. */
export interface GateVerdict {
  gate: GateName;
  passed: boolean;
  /** Human-readable detail matching the planner's reason contract. */
  detail: string;
}

/** Per-unit trace: every gate it was evaluated against. */
export interface UnitTrace {
  id: string;
  path: string;
  intent: string;
  outcome: "selected" | "skipped";
  /** Gates in evaluation order. Stops after the first rejection for skipped units. */
  gates: GateVerdict[];
  /** The gate that rejected this unit (undefined for selected units). */
  rejectedBy?: GateName;
  /** Relevance score (only when the unit passed the relevance gate). */
  score?: number;
  /** Token cost attribution (only for selected units under context budget). */
  tokens?: { value?: number; source: "declared" | "estimated" | "unmeasured" };
  /** Money cost attribution (only for pay-per-request selected units). */
  cost?: { amount?: number; currency?: string; method: string };
}

/** The complete decision trace. */
export interface DecisionTrace {
  task: string;
  taskTerms: string[];
  asOf: string;
  capabilities: AgentCapabilities;
  /** The canonical plan this trace annotates. */
  plan: AgentPlan;
  /** One trace per unit in the manifest, in manifest order. */
  units: UnitTrace[];
  /** How many units passed/failed each gate. */
  gateSummary: { gate: GateName; passed: number; failed: number }[];
}

/** Round away float noise. */
const money = (n: number): number => Number(n.toFixed(6));

/**
 * Produce a decision trace: the canonical plan annotated with per-unit gate records.
 * Pure — no I/O, no model.
 */
export function trace(manifest: Manifest, task: string, options: PlanOptions = {}): DecisionTrace {
  const p = plan(manifest, task, options);
  const caps: AgentCapabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  const asOf = options.asOf ?? new Date().toISOString().slice(0, 10);
  const taskTerms = terms(task);
  const maxUnits = options.maxUnits ?? 5;
  const budget = options.budget;
  const budgetCurrency = budget?.currency ?? "USDC";
  const upstreamSpent = budget?.spent ?? 0;
  const contextBudget = options.contextBudget;

  const selectedIds = new Set(p.selected.map((u) => u.id));
  const skippedMap = new Map(p.skipped.map((s) => [s.id, s.reason]));

  const ar = manifest.trust?.agent_requirements;
  const requiresAttestation = !!ar?.require_attestation;
  const agentCanAttest =
    !requiresAttestation ||
    (!!caps.attestationProvider && (ar?.trusted_providers ?? []).includes(caps.attestationProvider));

  // Build the traces by re-walking each unit through the gate cascade.
  // Phase 1: pre-selection gates (audience → strict). Mirrors planner lines 347-413.
  interface Candidate {
    unit: Unit;
    gates: GateVerdict[];
    rejected: boolean;
    rejectedBy?: GateName;
    score: number;
    loadEligible: boolean;
    payment: ReturnType<typeof planPayment>;
  }

  const candidates: Candidate[] = [];

  for (const unit of manifest.units) {
    const gates: GateVerdict[] = [];
    let rejected = false;
    let rejectedBy: GateName | undefined;
    let score = 0;
    let loadEligible = true;
    let payment = planPayment(unit.payment ?? manifest.payment, caps);

    const reject = (gate: GateName, detail: string) => {
      gates.push({ gate, passed: false, detail });
      rejected = true;
      rejectedBy = gate;
    };
    const pass = (gate: GateName, detail: string) => {
      gates.push({ gate, passed: true, detail });
    };

    // 1. audience
    if (unit.audience.length > 0 && !unit.audience.includes(caps.role)) {
      reject("audience", `audience ${JSON.stringify(unit.audience)} excludes role '${caps.role}'`);
    } else {
      pass("audience", unit.audience.length > 0 ? `role '${caps.role}' in ${JSON.stringify(unit.audience)}` : "no audience restriction");
    }
    if (rejected) { candidates.push({ unit, gates, rejected, rejectedBy, score, loadEligible, payment }); continue; }

    // 2. not_for
    const nf = (unit.not_for ?? []).find((n) => taskTerms.some((t) => n.toLowerCase().includes(t)));
    if (nf) {
      reject("not_for", `not_for declares it does not serve '${nf}'`);
    } else {
      pass("not_for", unit.not_for?.length ? `task terms do not match ${JSON.stringify(unit.not_for)}` : "no not_for declarations");
    }
    if (rejected) { candidates.push({ unit, gates, rejected, rejectedBy, score, loadEligible, payment }); continue; }

    // 3. temporal
    const ts = temporalStatus(unit, asOf);
    if (ts === "future") {
      reject("temporal", `not active until ${unit.temporal?.valid_from}`);
    } else if (ts === "expired") {
      const succ = unit.temporal?.superseded_by ? ` (superseded by ${unit.temporal.superseded_by})` : "";
      reject("temporal", `expired ${unit.temporal?.valid_until}${succ}`);
    } else {
      pass("temporal", unit.temporal ? `active as-of ${asOf}` : "no temporal constraint");
    }
    if (rejected) { candidates.push({ unit, gates, rejected, rejectedBy, score, loadEligible, payment }); continue; }

    // 4. deprecated
    if (unit.deprecated) {
      reject("deprecated", "deprecated");
    } else {
      pass("deprecated", "not deprecated");
    }
    if (rejected) { candidates.push({ unit, gates, rejected, rejectedBy, score, loadEligible, payment }); continue; }

    // 5. supersession
    const successor = selectableSuccessor(unit, manifest, asOf, caps.role);
    if (successor) {
      reject("supersession", `superseded by ${successor} (successor active)`);
    } else {
      pass("supersession", unit.temporal?.superseded_by ? `successor '${unit.temporal.superseded_by}' not active` : "no supersession declared");
    }
    if (rejected) { candidates.push({ unit, gates, rejected, rejectedBy, score, loadEligible, payment }); continue; }

    // 6. relevance
    const { score: s, reasons } = scoreUnit(unit, taskTerms);
    score = s;
    if (score === 0) {
      reject("relevance", "no task-relevance match");
    } else {
      pass("relevance", `score ${score}: ${reasons.join("; ")}`);
    }
    if (rejected) { candidates.push({ unit, gates, rejected, rejectedBy, score, loadEligible, payment }); continue; }

    // 7. attestation
    const unitRequiresAttestation = requiresAttestation && unit.access === "restricted";
    if (unitRequiresAttestation && !agentCanAttest) {
      loadEligible = false;
      pass("attestation", "restricted: requires attestation the agent cannot present (loadEligible=false)");
    } else {
      pass("attestation", unitRequiresAttestation ? "agent can present required attestation" : "no attestation required");
    }

    // 8. payment
    if (!payment.affordable) {
      loadEligible = false;
      pass("payment", `unaffordable: ${payment.method} (loadEligible=false)`);
    } else {
      pass("payment", payment.method === "free" ? "free" : `${payment.method}: ${payment.cost}`);
    }

    // 9. access
    if ((unit.access === "authenticated" || unit.access === "restricted") && caps.credentials.length === 0) {
      if (unit.access === "restricted") loadEligible = false;
      pass("access", `access '${unit.access}': agent holds no credentials${unit.access === "restricted" ? " (loadEligible=false)" : ""}`);
    } else {
      pass("access", unit.access ? `access '${unit.access}' — agent has credentials` : "public access");
    }

    // 10. strict
    if (options.strict && !loadEligible) {
      reject("strict", "not load-eligible under strict mode");
    } else {
      pass("strict", options.strict ? "load-eligible under strict mode" : "non-strict mode");
    }
    if (rejected) { candidates.push({ unit, gates, rejected, rejectedBy, score, loadEligible, payment }); continue; }

    candidates.push({ unit, gates, rejected, rejectedBy, score, loadEligible, payment });
  }

  // Phase 2: greedy loop gates (max_units, money_budget, context_budget).
  // Sort candidates that passed pre-selection, same as planner line 415.
  const passed = candidates.filter((c) => !c.rejected);
  passed.sort((a, b) => b.score - a.score || a.unit.id.localeCompare(b.unit.id));

  let accepted = 0;
  let spend = 0;
  let usedTokens = 0;

  for (const c of passed) {
    // 11. max_units
    if (accepted >= maxUnits) {
      c.rejected = true;
      c.rejectedBy = "max_units";
      c.gates.push({ gate: "max_units", passed: false, detail: `position ${accepted + 1} exceeds cap of ${maxUnits}` });
      continue;
    }
    c.gates.push({ gate: "max_units", passed: true, detail: `position ${accepted + 1} within cap of ${maxUnits}` });

    // 12. money_budget
    const price = c.payment.pricePerRequest;
    if (budget && c.loadEligible && price !== undefined && price > 0) {
      if (c.payment.currency !== budgetCurrency) {
        c.rejected = true;
        c.rejectedBy = "money_budget";
        c.gates.push({ gate: "money_budget", passed: false, detail: `costs ${c.payment.cost}, budget is in ${budgetCurrency}` });
        continue;
      }
      if (upstreamSpent + spend + price > budget.amount + 1e-9) {
        c.rejected = true;
        c.rejectedBy = "money_budget";
        c.gates.push({ gate: "money_budget", passed: false, detail: `${price} would exceed remaining ${money(budget.amount - upstreamSpent - spend)} of ${budget.amount} ${budgetCurrency}` });
        continue;
      }
      spend += price;
      c.gates.push({ gate: "money_budget", passed: true, detail: `${price} within budget (${money(spend)} of ${budget.amount} ${budgetCurrency} spent)` });
    } else {
      c.gates.push({ gate: "money_budget", passed: true, detail: budget ? "free unit" : "no budget ceiling set" });
    }

    // 13. context_budget
    if (contextBudget !== undefined && c.loadEligible) {
      const { tokens, measured, approximate } = unitTokens(c.unit);
      if (!measured) {
        if (options.strict) {
          c.rejected = true;
          c.rejectedBy = "context_budget";
          c.gates.push({ gate: "context_budget", passed: false, detail: "size undeclared — excluded under strict" });
          continue;
        }
        c.gates.push({ gate: "context_budget", passed: true, detail: "unmeasured (admitted, projection is a lower bound)" });
      } else if (usedTokens + (tokens ?? 0) > contextBudget + 1e-9) {
        const fmtT = (n: number) => Math.round(n).toLocaleString("en-US");
        c.rejected = true;
        c.rejectedBy = "context_budget";
        c.gates.push({ gate: "context_budget", passed: false, detail: `${fmtT(tokens ?? 0)} tokens would exceed remaining ${fmtT(contextBudget - usedTokens)} of ${fmtT(contextBudget)}` });
        continue;
      } else {
        usedTokens += tokens ?? 0;
        c.gates.push({ gate: "context_budget", passed: true, detail: `${Math.round(tokens ?? 0).toLocaleString("en-US")} tokens (${Math.round(usedTokens).toLocaleString("en-US")} of ${contextBudget.toLocaleString("en-US")} used)` });
      }
    } else {
      c.gates.push({ gate: "context_budget", passed: true, detail: contextBudget !== undefined ? "not load-eligible" : "no context budget set" });
    }

    accepted++;
  }

  // Build UnitTrace from candidates, in manifest order.
  const unitTraces: UnitTrace[] = candidates.map((c) => {
    const outcome = selectedIds.has(c.unit.id) ? "selected" : "skipped";
    const ut: UnitTrace = {
      id: c.unit.id,
      path: c.unit.path,
      intent: c.unit.intent,
      outcome: outcome as "selected" | "skipped",
      gates: c.gates,
      rejectedBy: c.rejectedBy,
    };
    if (c.score > 0) ut.score = c.score;
    if (outcome === "selected") {
      const tInfo = unitTokens(c.unit);
      ut.tokens = {
        value: tInfo.tokens,
        source: tInfo.measured ? (tInfo.approximate ? "estimated" : "declared") : "unmeasured",
      };
      if (c.payment.method !== "free" && c.payment.pricePerRequest !== undefined) {
        ut.cost = { amount: c.payment.pricePerRequest, currency: c.payment.currency, method: c.payment.method };
      }
    }
    return ut;
  });

  // Gate summary: count passes/failures per gate across all units.
  const gateSummary = GATE_ORDER.map((gate) => {
    let passed = 0;
    let failed = 0;
    for (const ut of unitTraces) {
      const v = ut.gates.find((g) => g.gate === gate);
      if (v) {
        if (v.passed) passed++;
        else failed++;
      }
    }
    return { gate, passed, failed };
  });

  return {
    task,
    taskTerms,
    asOf: p.asOf,
    capabilities: caps,
    plan: p,
    units: unitTraces,
    gateSummary,
  };
}

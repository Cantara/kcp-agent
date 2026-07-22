// The deterministic KCP planner — the LLM-free heart of the agent.
//
// Given a task and a manifest, it produces an inspectable *load plan*: which
// units to load and in what order, which to skip and exactly why, how sub-
// manifests are selected across the federation, and what the whole thing costs.
// No model is involved — the plan is an auditable artifact you can read before
// any content is loaded or any request is paid for. This is the trusted-render
// principle ("audit before action") extended to the whole agent loop.

import type { Manifest, Unit, PaymentMethod } from "./model.js";
import type { SignatureResult } from "./verify.js";
import { checkServing, type ServingCheck } from "./serving.js";

export interface AgentCapabilities {
  /** Role the agent presents (default "agent"). Units target audiences. */
  role: string;
  /** Payment methods the agent can settle (e.g. ["free", "x402"]). */
  paymentMethods: string[];
  /** Credential kinds the agent holds (e.g. ["api_key", "oauth2"]). */
  credentials: string[];
  /** Attestation provider the agent can prove (matched against trusted_providers). */
  attestationProvider?: string;
}

export const DEFAULT_CAPABILITIES: AgentCapabilities = {
  role: "agent",
  paymentMethods: ["free"],
  credentials: [],
  attestationProvider: undefined,
};

export interface PlanOptions {
  capabilities?: Partial<AgentCapabilities>;
  /** Runtime environment for federation `context` selection (dev/test/staging/prod). */
  env?: string;
  /** Point-in-time for temporal evaluation (ISO date). Defaults to today (UTC). */
  asOf?: string;
  /** Max units to select. */
  maxUnits?: number;
  /** Fail-closed: gate any unit that is not load-eligible instead of listing it. */
  strict?: boolean;
  /**
   * Spend ceiling for pay-per-request units. Selection stays greedy by score;
   * units that would blow the ceiling are skipped with the arithmetic.
   * `spent` is what upstream manifests in a federated walk already committed —
   * the ceiling is tree-wide, not per manifest.
   */
  budget?: { amount: number; currency?: string; spent?: number };
  /**
   * Token ceiling for what a plan loads into the model's context window (#33).
   * Mirrors `budget`: greedy by score, a unit that would blow the ceiling is
   * skipped with the arithmetic. A unit's size is its declared `size_tokens`,
   * or `bytes/4` when only `bytes` is declared. A unit with neither is admitted
   * but counted `unmeasured` (the projection is a lower bound) — unless `strict`,
   * which excludes it fail-closed.
   */
  contextBudget?: number;
}

export interface PaymentPlan {
  method: string; // the chosen method type, or "none"
  cost?: string; // e.g. "0.002 USDC/request"
  pricePerRequest?: number; // numeric cost for budget arithmetic
  currency?: string;
  affordable: boolean;
}

export interface PlannedUnit {
  id: string;
  path: string;
  intent: string;
  score: number;
  reasons: string[];
  payment: PaymentPlan;
  requiresAttestation: boolean;
  loadEligible: boolean;
}

export interface SkippedUnit {
  id: string;
  reason: string;
}

export interface FederationPlan {
  id: string;
  url: string;
  selected: boolean;
  reason: string;
  credentialNeeded?: string;
  docsUrl?: string;
}

export interface BudgetPlan {
  rateTier: string;
  requestsPerMinute?: number | "unlimited";
  perRequestCosts: { unit: string; cost: string }[];
  /** Spend ceiling, when the agent planned with one. */
  ceiling?: number;
  currency?: string;
  /** Spend already committed by upstream manifests in this federated walk (omitted when zero). */
  alreadyCommitted?: number;
  /** Total per-request cost of the selected units. */
  projectedSpend?: number;
  remaining?: number;
  note: string;
}

export interface ContextPlan {
  /** Token ceiling, when the agent planned with one. */
  ceiling?: number;
  /** Sum of the selected units' token cost (declared or estimated). */
  projectedTokens?: number;
  remaining?: number;
  /** True when any selected unit's size was estimated from bytes rather than declared. */
  approximate: boolean;
  /** Count of selected units with no declared size — the projection is a lower bound by this many. */
  unmeasured: number;
  note: string;
}

export interface AgentPlan {
  task: string;
  manifest: {
    project: string;
    version: string;
    kcpVersion?: string;
    source?: string;
    /** sha256 of the exact manifest text — attached by the loading layer, so a saved plan pins the bytes it was computed from. */
    sha256?: string;
  };
  trust: { requiresAttestation: boolean; agentCanAttest: boolean; note: string };
  environment?: string;
  asOf: string;
  /** The planner inputs echoed into the artifact — everything `kcp-agent replay` needs to recompute this plan. */
  options: { capabilities: AgentCapabilities; maxUnits: number; strict: boolean; budget?: { amount: number; currency?: string; spent?: number }; contextBudget?: number };
  selected: PlannedUnit[];
  skipped: SkippedUnit[];
  federation: FederationPlan[];
  budget: BudgetPlan;
  context: ContextPlan;
  warnings: string[];
  /** Signature verification result — attached by the loading layer, never by the pure planner. */
  signature?: SignatureResult;
  /** Serving Endpoint Binding check (§3.12 / C22) — present when the manifest declares a serving block. */
  serving?: ServingCheck;
}

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "do", "does", "how", "what", "why", "when",
  "where", "which", "who", "to", "of", "in", "on", "for", "and", "or", "i", "we", "you", "it",
  "this", "that", "with", "my", "our", "can", "should", "will", "be", "get", "getting",
]);

/** Tokenize a task/text into matchable terms — shared with `validate` so the lint sees exactly what the planner sees. */
export function terms(task: string): string[] {
  return task
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u) // any-script letters/digits — "strømnett" is one term, not two fragments
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** Score a unit against the task terms — mirrors the intent/trigger/id/path signal `kcp query` uses. */
export function scoreUnit(unit: Unit, taskTerms: string[]): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const intent = unit.intent.toLowerCase();
  const triggers = unit.triggers.map((t) => t.toLowerCase());
  const idPath = `${unit.id} ${unit.path}`.toLowerCase();

  let intentHits = 0;
  let triggerHits = 0;
  let idHits = 0;
  for (const t of taskTerms) {
    if (intent.includes(t)) intentHits++;
    if (triggers.some((tr) => tr.includes(t) || t.includes(tr))) triggerHits++;
    if (idPath.includes(t)) idHits++;
  }
  if (intentHits) { score += intentHits * 3; reasons.push(`intent matches ${intentHits} term(s)`); }
  if (triggerHits) { score += triggerHits * 4; reasons.push(`triggers match ${triggerHits} term(s)`); }
  if (idHits) { score += idHits * 2; reasons.push(`id/path matches ${idHits} term(s)`); }
  return { score, reasons };
}

/** UTC "today" as YYYY-MM-DD, without relying on locale. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** @internal — exported for the trace module; not part of the public API contract. */
export function temporalStatus(unit: Unit, asOf: string): "active" | "future" | "expired" {
  const t = unit.temporal;
  if (!t) return "active";
  if (t.valid_from && t.valid_from > asOf) return "future";
  if (t.valid_until && t.valid_until < asOf) return "expired";
  return "active";
}

/**
 * Supersession precedence (spec §4.22, v0.25.1): validity windows may overlap
 * during transitions, and `superseded_by` disambiguates the overlap — a unit
 * whose declared successor is itself selectable SHOULD NOT be selected.
 * Returns the successor id when it is active as of `asOf` and audience-eligible.
 */
/** @internal — exported for the trace module; not part of the public API contract. */
export function selectableSuccessor(unit: Unit, manifest: Manifest, asOf: string, role: string): string | undefined {
  const succId = unit.temporal?.superseded_by;
  if (!succId) return undefined;
  const succ = manifest.units.find((u) => u.id === succId);
  if (!succ || succ.deprecated) return undefined;
  if (temporalStatus(succ, asOf) !== "active") return undefined;
  if (succ.audience.length > 0 && !succ.audience.includes(role)) return undefined;
  return succId;
}

/** Choose the first payment method the agent supports, from a unit/root payment block.
 *  @internal — exported for the trace module; not part of the public API contract. */
export function planPayment(payment: Unit["payment"], caps: AgentCapabilities): PaymentPlan {
  const methods = payment?.methods;
  if (!methods || methods.length === 0) {
    return { method: "free", cost: undefined, affordable: true }; // no payment declared = free
  }
  for (const m of methods) {
    if (!caps.paymentMethods.includes(m.type)) continue;
    if (m.type === "free") return { method: "free", affordable: true };
    if (m.type === "x402") {
      const price = Number(m.price_per_request);
      return {
        method: "x402",
        cost: `${m.price_per_request} ${m.currency}/request`,
        pricePerRequest: Number.isNaN(price) ? undefined : price,
        currency: m.currency,
        affordable: true,
      };
    }
    return { method: m.type, affordable: true };
  }
  const need = methods.map((m) => m.type).filter((t) => t !== "free");
  return { method: `needs ${need.join(" or ")}`, affordable: false };
}

/** Round away float noise in currency arithmetic. */
const money = (n: number): number => Number(n.toFixed(6));

/** Thousands-separated integer for readable token arithmetic (1240 → "1,240"). */
const fmtTokens = (n: number): string => Math.round(n).toLocaleString("en-US");

/**
 * The token cost the planner should weigh for a unit, computed from metadata
 * BEFORE any fetch (audit-before-action). Declared `size_tokens` is faithful;
 * `bytes/4` is a deterministic estimate; neither declared means unmeasured.
 */
export function unitTokens(unit: Unit): { tokens?: number; approximate: boolean; measured: boolean } {
  if (unit.size_tokens !== undefined) return { tokens: unit.size_tokens, approximate: false, measured: true };
  if (unit.bytes !== undefined) return { tokens: Math.ceil(unit.bytes / 4), approximate: true, measured: true };
  return { tokens: undefined, approximate: false, measured: false };
}

/** Build the ContextPlan from the finally-selected units and the token ceiling. */
function planContext(
  manifest: Manifest,
  selected: PlannedUnit[],
  ceiling: number | undefined,
): ContextPlan {
  const byId = new Map(manifest.units.map((u) => [u.id, u] as const));
  let projectedTokens = 0;
  let approximate = false;
  let unmeasured = 0;
  for (const s of selected) {
    if (!s.loadEligible) continue; // only units that will actually load consume the window
    const info = unitTokens(byId.get(s.id) ?? ({} as Unit));
    if (!info.measured) { unmeasured++; continue; }
    projectedTokens += info.tokens ?? 0;
    if (info.approximate) approximate = true;
  }
  if (ceiling === undefined) {
    return { approximate, unmeasured, note: "no context budget set." };
  }
  const remaining = ceiling - projectedTokens;
  const flags = [approximate ? "some sizes estimated" : "", unmeasured ? `${unmeasured} unmeasured` : ""].filter(Boolean);
  return {
    ceiling,
    projectedTokens,
    remaining,
    approximate,
    unmeasured,
    note: `projected ${fmtTokens(projectedTokens)} of ${fmtTokens(ceiling)} tokens; ${fmtTokens(remaining)} remaining${flags.length ? ` (${flags.join(", ")})` : ""}.`,
  };
}

/** Resolve the rate-limit tier the agent falls into, and its per-minute ceiling. */
function planBudget(
  manifest: Manifest,
  caps: AgentCapabilities,
  selected: PlannedUnit[],
  budget?: { amount: number; currency?: string; spent?: number }
): BudgetPlan {
  const rl = manifest.rate_limits;
  let tier = "default";
  if (caps.paymentMethods.includes("subscription") && rl?.premium) tier = "premium";
  else if (caps.credentials.length > 0 && rl?.authenticated) tier = "authenticated";
  const tierBlock = rl ? (rl as Record<string, { requests_per_minute?: number | "unlimited" }>)[tier] : undefined;
  // Budget concerns what will actually be loaded: only load-eligible units are
  // charged by the greedy selection, so cost projection matches it exactly.
  const loadable = selected.filter((u) => u.loadEligible);
  const perRequestCosts = loadable
    .filter((u) => u.payment.method === "x402" && u.payment.cost)
    .map((u) => ({ unit: u.id, cost: u.payment.cost as string }));
  const projectedSpend = money(
    loadable.reduce((sum, u) => sum + (u.payment.pricePerRequest ?? 0), 0)
  );
  const currency = budget?.currency ?? "USDC";
  const spent = money(budget?.spent ?? 0);
  const remaining = budget ? money(budget.amount - spent - projectedSpend) : undefined;
  return {
    rateTier: tier,
    requestsPerMinute: tierBlock?.requests_per_minute,
    perRequestCosts,
    ...(budget
      ? {
          ceiling: budget.amount,
          currency,
          ...(spent > 0 ? { alreadyCommitted: spent } : {}),
          projectedSpend,
          remaining,
        }
      : {}),
    note: budget
      ? `projected spend ${projectedSpend}${spent > 0 ? ` (+${spent} committed upstream)` : ""} of ${budget.amount} ${currency}; ${remaining} remaining.`
      : perRequestCosts.length > 0
        ? `${perRequestCosts.length} selected unit(s) are pay-per-request; budget before loading.`
        : "all selected units are free to load at the resolved tier.",
  };
}

/** Produce a deterministic, inspectable plan. Pure — no I/O, no model. */
export function plan(manifest: Manifest, task: string, options: PlanOptions = {}): AgentPlan {
  const caps: AgentCapabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  const asOf = options.asOf ?? todayUtc();
  const maxUnits = options.maxUnits ?? 5;
  const warnings: string[] = [];
  const taskTerms = terms(task);
  if (taskTerms.length === 0) warnings.push("task produced no search terms after stopword removal");

  // Serving Endpoint Binding (§16.5 C22): the manifest's source is the final
  // post-redirect retrieval URL (set by the loading layer). If it is not in
  // the declared serving.manifest list, the plan must not tier above `known`
  // and must warn naming both the retrieval URL and the declared list. Pure —
  // both inputs are already on the manifest.
  const serving = checkServing(manifest.serving, manifest.source);
  if (serving?.status === "unbound") warnings.push(`serving binding: ${serving.detail}`);

  const ar = manifest.trust?.agent_requirements;
  const requiresAttestation = !!ar?.require_attestation;
  const agentCanAttest =
    !requiresAttestation ||
    (!!caps.attestationProvider && (ar?.trusted_providers ?? []).includes(caps.attestationProvider));

  const selected: PlannedUnit[] = [];
  const skipped: SkippedUnit[] = [];

  for (const unit of manifest.units) {
    // audience gate
    if (unit.audience.length > 0 && !unit.audience.includes(caps.role)) {
      skipped.push({ id: unit.id, reason: `audience ${JSON.stringify(unit.audience)} excludes role '${caps.role}'` });
      continue;
    }
    // negative space (not_for)
    const nf = (unit.not_for ?? []).find((n) => taskTerms.some((t) => n.toLowerCase().includes(t)));
    if (nf) {
      skipped.push({ id: unit.id, reason: `not_for declares it does not serve '${nf}'` });
      continue;
    }
    // temporal
    const ts = temporalStatus(unit, asOf);
    if (ts === "future") { skipped.push({ id: unit.id, reason: `not active until ${unit.temporal?.valid_from}` }); continue; }
    if (ts === "expired") {
      const succ = unit.temporal?.superseded_by ? ` (superseded by ${unit.temporal.superseded_by})` : "";
      skipped.push({ id: unit.id, reason: `expired ${unit.temporal?.valid_until}${succ}` });
      continue;
    }
    if (unit.deprecated) { skipped.push({ id: unit.id, reason: "deprecated" }); continue; }

    // supersession precedence over temporal overlap (spec §4.22, v0.25.1)
    const successor = selectableSuccessor(unit, manifest, asOf, caps.role);
    if (successor) {
      skipped.push({ id: unit.id, reason: `superseded by ${successor} (successor active)` });
      continue;
    }

    // relevance
    const { score, reasons } = scoreUnit(unit, taskTerms);
    if (score === 0) { skipped.push({ id: unit.id, reason: "no task-relevance match" }); continue; }

    // skill eligibility: a procedure/skill (kind: skill) is a governed unit that
    // fails closed — it is load/invoke-eligible only with an explicit grant
    // (load_eligible: true). Non-skill units and eligible skills pass. Soft-gate
    // so --trace shows the verdict; strict mode converts it to a skip below.
    let loadEligible = true;
    if (unit.kind === "skill" && unit.load_eligible !== true) {
      loadEligible = false;
      reasons.push("kind: skill not invoke-eligible: no explicit eligibility grant");
    }

    // trust: restricted units need attestation the agent can present
    const unitRequiresAttestation = requiresAttestation && unit.access === "restricted";
    if (unitRequiresAttestation && !agentCanAttest) {
      loadEligible = false;
      reasons.push("restricted: requires attestation the agent cannot present");
    }
    // economics
    const payment = planPayment(unit.payment ?? manifest.payment, caps);
    if (!payment.affordable) { loadEligible = false; reasons.push(`unaffordable: ${payment.method}`); }
    // access: authenticated/restricted needs a credential. Payment never
    // substitutes for identity — `access` declares the authentication axis
    // only (spec §4.11, v0.25.1), and a genuinely gated+paid unit requires
    // auth *before* payment (RFC-0005). An anonymous-paid unit is declared
    // `access: public` with a payment block, so it never reaches this gate.
    if ((unit.access === "authenticated" || unit.access === "restricted") && caps.credentials.length === 0) {
      reasons.push(`access '${unit.access}': agent holds no credentials`);
      if (unit.access === "restricted") loadEligible = false;
      if (payment.method === "x402") {
        reasons.push(
          `hint: '${unit.access}' + x402 — if this unit is anonymous-paid the manifest should mark it public (spec §4.11, v0.25.1)`
        );
      }
    }

    if (options.strict && !loadEligible) {
      skipped.push({ id: unit.id, reason: reasons[reasons.length - 1] ?? "not load-eligible" });
      continue;
    }
    selected.push({
      id: unit.id, path: unit.path, intent: unit.intent, score, reasons,
      payment, requiresAttestation: unitRequiresAttestation, loadEligible,
    });
  }

  selected.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  // Greedy selection by score: take each unit if it fits the remaining budget,
  // else skip it with the arithmetic and keep walking — a cheaper lower-scored
  // unit may still fit (deterministic, explainable; no knapsack cleverness).
  const budget = options.budget;
  const budgetCurrency = budget?.currency ?? "USDC";
  const upstreamSpent = budget?.spent ?? 0; // committed by earlier manifests in a federated walk — the ceiling is tree-wide
  const contextBudget = options.contextBudget;
  const unitById = new Map(manifest.units.map((mu) => [mu.id, mu] as const));
  let spend = 0;
  let usedTokens = 0;
  let sawUnmeasured = 0;
  let beyondMax = 0;
  const capped: PlannedUnit[] = [];
  for (const u of selected) {
    if (capped.length >= maxUnits) { beyondMax++; continue; }
    const price = u.payment.pricePerRequest;
    if (budget && u.loadEligible && price !== undefined && price > 0) {
      if (u.payment.currency !== budgetCurrency) {
        skipped.push({ id: u.id, reason: `over budget: costs ${u.payment.cost}, budget is in ${budgetCurrency}` });
        continue;
      }
      if (upstreamSpent + spend + price > budget.amount + 1e-9) {
        skipped.push({
          id: u.id,
          reason: `over budget: ${price} would exceed remaining ${money(budget.amount - upstreamSpent - spend)} of ${budget.amount} ${budgetCurrency}`,
        });
        continue;
      }
      spend += price;
    }
    // Context ceiling: only load-eligible units consume the window. A unit that
    // would blow it is skipped with the arithmetic; a smaller one still fits.
    if (contextBudget !== undefined && u.loadEligible) {
      const { tokens, measured } = unitTokens(unitById.get(u.id) ?? ({} as Unit));
      if (!measured) {
        if (options.strict) {
          skipped.push({ id: u.id, reason: "size undeclared — excluded under strict (declare size_tokens or bytes)" });
          continue;
        }
        sawUnmeasured++;
      } else if (usedTokens + (tokens ?? 0) > contextBudget + 1e-9) {
        skipped.push({
          id: u.id,
          reason: `over context budget: ${fmtTokens(tokens ?? 0)} tokens would exceed remaining ${fmtTokens(contextBudget - usedTokens)} of ${fmtTokens(contextBudget)}`,
        });
        continue;
      } else {
        usedTokens += tokens ?? 0;
      }
    }
    capped.push(u);
  }
  if (beyondMax) {
    warnings.push(`${beyondMax} relevant unit(s) beyond maxUnits=${maxUnits} not selected`);
  }
  if (contextBudget !== undefined && sawUnmeasured > 0) {
    warnings.push(`${sawUnmeasured} selected unit(s) declare no size — the context projection is a lower bound (unmeasured)`);
  }

  // federation: select sub-manifests by env context, note credential planning.
  // Fail-closed: a context-tagged ref is only eligible when the agent declares
  // an env it matches — no env declared means no context-tagged ref is followed.
  const federation = manifest.manifests.map((ref) => {
    const inEnv = !ref.context || (options.env !== undefined && ref.context.includes(options.env));
    const ai = ref.agent_identity;
    let credentialNeeded: string | undefined;
    if (ai?.required && ai.credential_hint && !caps.credentials.includes(ai.credential_hint)) {
      credentialNeeded = ai.credential_hint;
    }
    const reason = !inEnv
      ? options.env !== undefined
        ? `context ${JSON.stringify(ref.context)} excludes env '${options.env}'`
        : `context ${JSON.stringify(ref.context)} requires a declared env; none given (fail-closed)`
      : credentialNeeded
        ? `needs ${credentialNeeded} before fetch`
        : "eligible";
    return { id: ref.id, url: ref.url, selected: inEnv, reason, credentialNeeded, docsUrl: ai?.docs_url };
  });

  const budgetPlan = planBudget(manifest, caps, capped, options.budget);
  const contextPlan = planContext(manifest, capped, contextBudget);

  return {
    task,
    manifest: { project: manifest.project, version: manifest.version, kcpVersion: manifest.kcp_version, source: manifest.source },
    trust: {
      requiresAttestation,
      agentCanAttest,
      note: requiresAttestation
        ? agentCanAttest
          ? "manifest requires attestation; the agent can present it"
          : "manifest requires attestation; the agent CANNOT — restricted units are gated"
        : "no manifest-level attestation requirement",
    },
    environment: options.env,
    asOf,
    options: {
      capabilities: caps,
      maxUnits,
      strict: !!options.strict,
      ...(budget ? { budget } : {}),
      ...(contextBudget !== undefined ? { contextBudget } : {}),
    },
    selected: capped,
    skipped,
    federation,
    budget: budgetPlan,
    context: contextPlan,
    warnings,
    ...(serving ? { serving } : {}),
  };
}

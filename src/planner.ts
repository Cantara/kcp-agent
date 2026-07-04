// The deterministic KCP planner — the LLM-free heart of the agent.
//
// Given a task and a manifest, it produces an inspectable *load plan*: which
// units to load and in what order, which to skip and exactly why, how sub-
// manifests are selected across the federation, and what the whole thing costs.
// No model is involved — the plan is an auditable artifact you can read before
// any content is loaded or any request is paid for. This is the trusted-render
// principle ("audit before action") extended to the whole agent loop.

import type { Manifest, Unit, PaymentMethod } from "./model.js";

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
}

export interface PaymentPlan {
  method: string; // the chosen method type, or "none"
  cost?: string; // e.g. "0.002 USDC/request"
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
  note: string;
}

export interface AgentPlan {
  task: string;
  manifest: { project: string; version: string; kcpVersion?: string; source?: string };
  trust: { requiresAttestation: boolean; agentCanAttest: boolean; note: string };
  environment?: string;
  asOf: string;
  selected: PlannedUnit[];
  skipped: SkippedUnit[];
  federation: FederationPlan[];
  budget: BudgetPlan;
  warnings: string[];
}

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "do", "does", "how", "what", "why", "when",
  "where", "which", "who", "to", "of", "in", "on", "for", "and", "or", "i", "we", "you", "it",
  "this", "that", "with", "my", "our", "can", "should", "will", "be", "get", "getting",
]);

function terms(task: string): string[] {
  return task
    .toLowerCase()
    .split(/[^a-z0-9]+/)
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

function temporalStatus(unit: Unit, asOf: string): "active" | "future" | "expired" {
  const t = unit.temporal;
  if (!t) return "active";
  if (t.valid_from && t.valid_from > asOf) return "future";
  if (t.valid_until && t.valid_until < asOf) return "expired";
  return "active";
}

/** Choose the first payment method the agent supports, from a unit/root payment block. */
function planPayment(payment: Unit["payment"], caps: AgentCapabilities): PaymentPlan {
  const methods = payment?.methods;
  if (!methods || methods.length === 0) {
    return { method: "free", cost: undefined, affordable: true }; // no payment declared = free
  }
  for (const m of methods) {
    if (!caps.paymentMethods.includes(m.type)) continue;
    if (m.type === "free") return { method: "free", affordable: true };
    if (m.type === "x402") {
      return { method: "x402", cost: `${m.price_per_request} ${m.currency}/request`, affordable: true };
    }
    return { method: m.type, affordable: true };
  }
  const need = methods.map((m) => m.type).filter((t) => t !== "free");
  return { method: `needs ${need.join(" or ")}`, affordable: false };
}

/** Resolve the rate-limit tier the agent falls into, and its per-minute ceiling. */
function planBudget(manifest: Manifest, caps: AgentCapabilities, selected: PlannedUnit[]): BudgetPlan {
  const rl = manifest.rate_limits;
  let tier = "default";
  if (caps.paymentMethods.includes("subscription") && rl?.premium) tier = "premium";
  else if (caps.credentials.length > 0 && rl?.authenticated) tier = "authenticated";
  const tierBlock = rl ? (rl as Record<string, { requests_per_minute?: number | "unlimited" }>)[tier] : undefined;
  const perRequestCosts = selected
    .filter((u) => u.payment.method === "x402" && u.payment.cost)
    .map((u) => ({ unit: u.id, cost: u.payment.cost as string }));
  return {
    rateTier: tier,
    requestsPerMinute: tierBlock?.requests_per_minute,
    perRequestCosts,
    note:
      perRequestCosts.length > 0
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

    // relevance
    const { score, reasons } = scoreUnit(unit, taskTerms);
    if (score === 0) { skipped.push({ id: unit.id, reason: "no task-relevance match" }); continue; }

    // trust: restricted units need attestation the agent can present
    const unitRequiresAttestation = requiresAttestation && unit.access === "restricted";
    let loadEligible = true;
    if (unitRequiresAttestation && !agentCanAttest) {
      loadEligible = false;
      reasons.push("restricted: requires attestation the agent cannot present");
    }
    // access: authenticated/restricted needs a credential
    if ((unit.access === "authenticated" || unit.access === "restricted") && caps.credentials.length === 0) {
      reasons.push(`access '${unit.access}': agent holds no credentials`);
      if (unit.access === "restricted") loadEligible = false;
    }
    // economics
    const payment = planPayment(unit.payment ?? manifest.payment, caps);
    if (!payment.affordable) { loadEligible = false; reasons.push(`unaffordable: ${payment.method}`); }

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
  const capped = selected.slice(0, maxUnits);
  if (selected.length > capped.length) {
    warnings.push(`${selected.length - capped.length} relevant unit(s) beyond maxUnits=${maxUnits} not selected`);
  }

  // federation: select sub-manifests by env context, note credential planning
  const federation = manifest.manifests.map((ref) => {
    const inEnv = !ref.context || (options.env ? ref.context.includes(options.env) : true);
    const ai = ref.agent_identity;
    let credentialNeeded: string | undefined;
    if (ai?.required && ai.credential_hint && !caps.credentials.includes(ai.credential_hint)) {
      credentialNeeded = ai.credential_hint;
    }
    const reason = !inEnv
      ? `context ${JSON.stringify(ref.context)} excludes env '${options.env}'`
      : credentialNeeded
        ? `needs ${credentialNeeded} before fetch`
        : "eligible";
    return { id: ref.id, url: ref.url, selected: inEnv, reason, credentialNeeded, docsUrl: ai?.docs_url };
  });

  const budget = planBudget(manifest, caps, capped);

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
    selected: capped,
    skipped,
    federation,
    budget,
    warnings,
  };
}

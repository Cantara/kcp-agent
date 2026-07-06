//! The deterministic KCP planner — a Rust port of `src/planner.ts`.
//!
//! Given a task and a manifest, `plan()` produces an inspectable load plan:
//! which units to load and in what order, which to skip and exactly why, how
//! sub-manifests are selected, and what the whole thing costs. Pure — no I/O,
//! no model, no clock (the point-in-time is the injected `as_of`).

use crate::budget::{fmt_tokens, money, plan_budget, plan_context, plan_payment, unit_tokens};
use crate::model::{Count, Manifest, Unit};
use serde::Deserialize;

// ── inputs ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub role: String,
    pub payment_methods: Vec<String>,
    pub credentials: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attestation_provider: Option<String>,
}

impl Default for AgentCapabilities {
    fn default() -> Self {
        AgentCapabilities {
            role: "agent".to_string(),
            payment_methods: vec!["free".to_string()],
            credentials: vec![],
            attestation_provider: None,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitiesInput {
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub payment_methods: Option<Vec<String>>,
    #[serde(default)]
    pub credentials: Option<Vec<String>>,
    #[serde(default)]
    pub attestation_provider: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetInput {
    pub amount: f64,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub spent: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanOptions {
    #[serde(default)]
    pub capabilities: Option<CapabilitiesInput>,
    #[serde(default)]
    pub env: Option<String>,
    #[serde(default)]
    pub as_of: Option<String>,
    #[serde(default)]
    pub max_units: Option<i64>,
    #[serde(default)]
    pub strict: Option<bool>,
    #[serde(default)]
    pub budget: Option<BudgetInput>,
    #[serde(default)]
    pub context_budget: Option<i64>,
}

impl PlanOptions {
    pub fn caps(&self) -> AgentCapabilities {
        let d = AgentCapabilities::default();
        match &self.capabilities {
            None => d,
            Some(c) => AgentCapabilities {
                role: c.role.clone().unwrap_or(d.role),
                payment_methods: c.payment_methods.clone().unwrap_or(d.payment_methods),
                credentials: c.credentials.clone().unwrap_or(d.credentials),
                attestation_provider: c.attestation_provider.clone(),
            },
        }
    }
}

// ── outputs ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PaymentPlan {
    pub method: String,
    pub cost: Option<String>,
    pub price_per_request: Option<f64>,
    pub currency: Option<String>,
    pub affordable: bool,
}

#[derive(Debug, Clone)]
pub struct PlannedUnit {
    pub id: String,
    pub path: String,
    pub intent: String,
    pub score: i64,
    pub reasons: Vec<String>,
    pub payment: PaymentPlan,
    pub requires_attestation: bool,
    pub load_eligible: bool,
}

#[derive(Debug, Clone)]
pub struct SkippedUnit {
    pub id: String,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub struct FederationPlan {
    pub id: String,
    pub url: String,
    pub selected: bool,
    pub reason: String,
    pub credential_needed: Option<String>,
    pub docs_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct BudgetPlan {
    pub rate_tier: String,
    pub requests_per_minute: Option<Count>,
    pub per_request_costs: Vec<(String, String)>,
    pub ceiling: Option<f64>,
    pub currency: Option<String>,
    pub already_committed: Option<f64>,
    pub projected_spend: Option<f64>,
    pub remaining: Option<f64>,
    pub note: String,
}

#[derive(Debug, Clone)]
pub struct ContextPlan {
    pub ceiling: Option<i64>,
    pub projected_tokens: Option<i64>,
    pub remaining: Option<i64>,
    pub approximate: bool,
    pub unmeasured: i64,
    pub note: String,
}

#[derive(Debug, Clone)]
pub struct TrustInfo {
    pub requires_attestation: bool,
    pub agent_can_attest: bool,
    pub note: String,
}

#[derive(Debug, Clone)]
pub struct AgentPlan {
    pub task: String,
    pub manifest_project: String,
    pub manifest_version: String,
    pub trust: TrustInfo,
    pub environment: Option<String>,
    pub as_of: String,
    pub selected: Vec<PlannedUnit>,
    pub skipped: Vec<SkippedUnit>,
    pub federation: Vec<FederationPlan>,
    pub budget: BudgetPlan,
    pub context: ContextPlan,
    pub warnings: Vec<String>,
}

// ── scoring ──────────────────────────────────────────────────────────────────

const STOPWORDS: &[&str] = &[
    "the", "a", "an", "is", "are", "was", "were", "do", "does", "how", "what", "why", "when",
    "where", "which", "who", "to", "of", "in", "on", "for", "and", "or", "i", "we", "you", "it",
    "this", "that", "with", "my", "our", "can", "should", "will", "be", "get", "getting",
];

/// Tokenize a task/text into matchable terms — lowercased, split on any
/// non-letter/digit boundary (Unicode-aware), ≤ 2-char and stopwords dropped.
pub fn terms(task: &str) -> Vec<String> {
    task.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.chars().count() > 2 && !STOPWORDS.contains(t))
        .map(|t| t.to_string())
        .collect()
}

/// Score a unit against task terms — intent (+3), trigger (+4, bidirectional
/// substring), id/path (+2). Returns the score and the per-signal reasons.
pub fn score_unit(unit: &Unit, task_terms: &[String]) -> (i64, Vec<String>) {
    let intent = unit.intent.to_lowercase();
    let triggers: Vec<String> = unit.triggers.iter().map(|t| t.to_lowercase()).collect();
    let id_path = format!("{} {}", unit.id, unit.path).to_lowercase();

    let (mut intent_hits, mut trigger_hits, mut id_hits) = (0i64, 0i64, 0i64);
    for t in task_terms {
        if intent.contains(t) {
            intent_hits += 1;
        }
        if triggers.iter().any(|tr| tr.contains(t) || t.contains(tr)) {
            trigger_hits += 1;
        }
        if id_path.contains(t) {
            id_hits += 1;
        }
    }
    let mut score = 0i64;
    let mut reasons = Vec::new();
    if intent_hits > 0 {
        score += intent_hits * 3;
        reasons.push(format!("intent matches {} term(s)", intent_hits));
    }
    if trigger_hits > 0 {
        score += trigger_hits * 4;
        reasons.push(format!("triggers match {} term(s)", trigger_hits));
    }
    if id_hits > 0 {
        score += id_hits * 2;
        reasons.push(format!("id/path matches {} term(s)", id_hits));
    }
    (score, reasons)
}

// ── temporal ─────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
pub enum TemporalStatus {
    Active,
    Future,
    Expired,
}

pub fn temporal_status(unit: &Unit, as_of: &str) -> TemporalStatus {
    match &unit.temporal {
        None => TemporalStatus::Active,
        Some(t) => {
            if t.valid_from.as_deref().map_or(false, |v| v > as_of) {
                TemporalStatus::Future
            } else if t.valid_until.as_deref().map_or(false, |v| v < as_of) {
                TemporalStatus::Expired
            } else {
                TemporalStatus::Active
            }
        }
    }
}

/// Supersession precedence (spec §4.22): a unit whose declared successor is
/// itself selectable at `as_of` should not be selected.
pub fn selectable_successor(unit: &Unit, manifest: &Manifest, as_of: &str, role: &str) -> Option<String> {
    let succ_id = unit.temporal.as_ref()?.superseded_by.as_ref()?;
    let succ = manifest.units.iter().find(|u| &u.id == succ_id)?;
    if succ.deprecated == Some(true) {
        return None;
    }
    if temporal_status(succ, as_of) != TemporalStatus::Active {
        return None;
    }
    if !succ.audience.is_empty() && !succ.audience.contains(&role.to_string()) {
        return None;
    }
    Some(succ_id.clone())
}

/// Compact `["a","b"]` JSON — matches `JSON.stringify` of a string array (no spaces).
fn json_arr(v: &[String]) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string())
}

// ── the planner ──────────────────────────────────────────────────────────────

/// Produce a deterministic, inspectable plan. Pure — no I/O, no model.
pub fn plan(manifest: &Manifest, task: &str, options: &PlanOptions) -> AgentPlan {
    let caps = options.caps();
    let today = "1970-01-01".to_string(); // as_of is required by every vector; a real caller injects today.
    let as_of = options.as_of.clone().unwrap_or(today);
    let max_units = options.max_units.unwrap_or(5);
    let mut warnings: Vec<String> = Vec::new();
    let task_terms = terms(task);
    if task_terms.is_empty() {
        warnings.push("task produced no search terms after stopword removal".to_string());
    }

    let ar = manifest.trust.as_ref().and_then(|t| t.agent_requirements.as_ref());
    let requires_attestation = ar.and_then(|a| a.require_attestation).unwrap_or(false);
    let agent_can_attest = !requires_attestation
        || (caps.attestation_provider.is_some()
            && ar
                .map(|a| a.trusted_providers.contains(caps.attestation_provider.as_ref().unwrap()))
                .unwrap_or(false));

    let mut selected: Vec<PlannedUnit> = Vec::new();
    let mut skipped: Vec<SkippedUnit> = Vec::new();

    for unit in &manifest.units {
        // 1. audience
        if !unit.audience.is_empty() && !unit.audience.contains(&caps.role) {
            skipped.push(SkippedUnit {
                id: unit.id.clone(),
                reason: format!("audience {} excludes role '{}'", json_arr(&unit.audience), caps.role),
            });
            continue;
        }
        // 2. not_for
        if let Some(nf) = unit.not_for.iter().find(|n| {
            let low = n.to_lowercase();
            task_terms.iter().any(|t| low.contains(t))
        }) {
            skipped.push(SkippedUnit {
                id: unit.id.clone(),
                reason: format!("not_for declares it does not serve '{}'", nf),
            });
            continue;
        }
        // 3. temporal
        match temporal_status(unit, &as_of) {
            TemporalStatus::Future => {
                skipped.push(SkippedUnit {
                    id: unit.id.clone(),
                    reason: format!("not active until {}", unit.temporal.as_ref().and_then(|t| t.valid_from.as_deref()).unwrap_or("")),
                });
                continue;
            }
            TemporalStatus::Expired => {
                let succ = unit
                    .temporal
                    .as_ref()
                    .and_then(|t| t.superseded_by.as_deref())
                    .map(|s| format!(" (superseded by {})", s))
                    .unwrap_or_default();
                skipped.push(SkippedUnit {
                    id: unit.id.clone(),
                    reason: format!("expired {}{}", unit.temporal.as_ref().and_then(|t| t.valid_until.as_deref()).unwrap_or(""), succ),
                });
                continue;
            }
            TemporalStatus::Active => {}
        }
        // 4. deprecated
        if unit.deprecated == Some(true) {
            skipped.push(SkippedUnit { id: unit.id.clone(), reason: "deprecated".to_string() });
            continue;
        }
        // 5. supersession precedence
        if let Some(successor) = selectable_successor(unit, manifest, &as_of, &caps.role) {
            skipped.push(SkippedUnit {
                id: unit.id.clone(),
                reason: format!("superseded by {} (successor active)", successor),
            });
            continue;
        }
        // 6. relevance
        let (score, mut reasons) = score_unit(unit, &task_terms);
        if score == 0 {
            skipped.push(SkippedUnit { id: unit.id.clone(), reason: "no task-relevance match".to_string() });
            continue;
        }
        // 7. attestation
        let unit_requires_attestation = requires_attestation && unit.access.as_deref() == Some("restricted");
        let mut load_eligible = true;
        if unit_requires_attestation && !agent_can_attest {
            load_eligible = false;
            reasons.push("restricted: requires attestation the agent cannot present".to_string());
        }
        // 8. payment
        let payment = plan_payment(unit.payment.as_ref().or(manifest.payment.as_ref()), &caps);
        if !payment.affordable {
            load_eligible = false;
            reasons.push(format!("unaffordable: {}", payment.method));
        }
        // 9. access is the auth axis
        let access = unit.access.as_deref();
        if (access == Some("authenticated") || access == Some("restricted")) && caps.credentials.is_empty() {
            reasons.push(format!("access '{}': agent holds no credentials", access.unwrap()));
            if access == Some("restricted") {
                load_eligible = false;
            }
            if payment.method == "x402" {
                reasons.push(format!(
                    "hint: '{}' + x402 — if this unit is anonymous-paid the manifest should mark it public (spec §4.11, v0.25.1)",
                    access.unwrap()
                ));
            }
        }
        // 10. strict
        if options.strict == Some(true) && !load_eligible {
            let reason = reasons.last().cloned().unwrap_or_else(|| "not load-eligible".to_string());
            skipped.push(SkippedUnit { id: unit.id.clone(), reason });
            continue;
        }
        selected.push(PlannedUnit {
            id: unit.id.clone(),
            path: unit.path.clone(),
            intent: unit.intent.clone(),
            score,
            reasons,
            payment,
            requires_attestation: unit_requires_attestation,
            load_eligible,
        });
    }

    // sort by score desc, then id asc (total, deterministic tie-break)
    selected.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.id.cmp(&b.id)));

    // greedy selection: maxUnits, then money budget, then context budget
    let budget = options.budget.as_ref();
    let budget_currency = budget.and_then(|b| b.currency.clone()).unwrap_or_else(|| "USDC".to_string());
    let upstream_spent = budget.and_then(|b| b.spent).unwrap_or(0.0);
    let context_budget = options.context_budget;
    let mut spend = 0.0f64;
    let mut used_tokens = 0i64;
    let mut saw_unmeasured = 0i64;
    let mut beyond_max = 0i64;
    let mut capped: Vec<PlannedUnit> = Vec::new();

    for u in selected.into_iter() {
        if (capped.len() as i64) >= max_units {
            beyond_max += 1;
            continue;
        }
        let price = u.payment.price_per_request;
        if let Some(b) = budget {
            if u.load_eligible {
                if let Some(p) = price {
                    if p > 0.0 {
                        if u.payment.currency.as_deref() != Some(budget_currency.as_str()) {
                            skipped.push(SkippedUnit {
                                id: u.id.clone(),
                                reason: format!(
                                    "over budget: costs {}, budget is in {}",
                                    u.payment.cost.clone().unwrap_or_default(),
                                    budget_currency
                                ),
                            });
                            continue;
                        }
                        if upstream_spent + spend + p > b.amount + 1e-9 {
                            skipped.push(SkippedUnit {
                                id: u.id.clone(),
                                reason: format!(
                                    "over budget: {} would exceed remaining {} of {} {}",
                                    fmt_num(p),
                                    fmt_num(money(b.amount - upstream_spent - spend)),
                                    fmt_num(b.amount),
                                    budget_currency
                                ),
                            });
                            continue;
                        }
                        spend += p;
                    }
                }
            }
        }
        if let Some(cb) = context_budget {
            if u.load_eligible {
                let info = manifest.units.iter().find(|mu| mu.id == u.id).map(unit_tokens);
                match info {
                    Some(ti) if !ti.measured => {
                        if options.strict == Some(true) {
                            skipped.push(SkippedUnit {
                                id: u.id.clone(),
                                reason: "size undeclared — excluded under strict (declare size_tokens or bytes)".to_string(),
                            });
                            continue;
                        }
                        saw_unmeasured += 1;
                    }
                    Some(ti) => {
                        let tokens = ti.tokens.unwrap_or(0);
                        if used_tokens + tokens > cb {
                            skipped.push(SkippedUnit {
                                id: u.id.clone(),
                                reason: format!(
                                    "over context budget: {} tokens would exceed remaining {} of {}",
                                    fmt_tokens(tokens),
                                    fmt_tokens(cb - used_tokens),
                                    fmt_tokens(cb)
                                ),
                            });
                            continue;
                        }
                        used_tokens += tokens;
                    }
                    None => {}
                }
            }
        }
        capped.push(u);
    }

    if beyond_max > 0 {
        warnings.push(format!("{} relevant unit(s) beyond maxUnits={} not selected", beyond_max, max_units));
    }
    if context_budget.is_some() && saw_unmeasured > 0 {
        warnings.push(format!(
            "{} selected unit(s) declare no size — the context projection is a lower bound (unmeasured)",
            saw_unmeasured
        ));
    }

    // federation
    let federation: Vec<FederationPlan> = manifest
        .manifests
        .iter()
        .map(|r| {
            let in_env = r.context.is_none()
                || (options.env.is_some() && r.context.as_ref().unwrap().contains(options.env.as_ref().unwrap()));
            let ai = r.agent_identity.as_ref();
            let credential_needed = ai.and_then(|a| {
                if a.required == Some(true) {
                    if let Some(hint) = &a.credential_hint {
                        if !caps.credentials.contains(hint) {
                            return Some(hint.clone());
                        }
                    }
                }
                None
            });
            let reason = if !in_env {
                match &options.env {
                    Some(env) => format!("context {} excludes env '{}'", json_arr(r.context.as_ref().unwrap()), env),
                    None => format!(
                        "context {} requires a declared env; none given (fail-closed)",
                        json_arr(r.context.as_ref().unwrap())
                    ),
                }
            } else if let Some(cn) = &credential_needed {
                format!("needs {} before fetch", cn)
            } else {
                "eligible".to_string()
            };
            FederationPlan {
                id: r.id.clone(),
                url: r.url.clone(),
                selected: in_env,
                reason,
                credential_needed,
                docs_url: ai.and_then(|a| a.docs_url.clone()),
            }
        })
        .collect();

    let budget_plan = plan_budget(manifest, &caps, &capped, budget);
    let context_plan = plan_context(manifest, &capped, context_budget);

    let trust_note = if requires_attestation {
        if agent_can_attest {
            "manifest requires attestation; the agent can present it"
        } else {
            "manifest requires attestation; the agent CANNOT — restricted units are gated"
        }
    } else {
        "no manifest-level attestation requirement"
    }
    .to_string();

    AgentPlan {
        task: task.to_string(),
        manifest_project: manifest.project.clone(),
        manifest_version: manifest.version.clone(),
        trust: TrustInfo { requires_attestation, agent_can_attest, note: trust_note },
        environment: options.env.clone(),
        as_of,
        selected: capped,
        skipped,
        federation,
        budget: budget_plan,
        context: context_plan,
        warnings,
    }
}

/// Format an f64 the way JS `${n}` does for the clean decimals used in budgets
/// (shortest round-trip, no trailing zeros): 0.0 → "0", 0.05 → "0.05".
pub fn fmt_num(n: f64) -> String {
    format!("{}", n)
}

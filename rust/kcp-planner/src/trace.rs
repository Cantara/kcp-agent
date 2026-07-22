//! Decision trace — a Rust port of `src/trace.ts`. Re-walks every unit through
//! the gate cascade and records each verdict, so a human/LLM/agent can see *why*
//! a plan looks the way it does. The canonical `plan()` is the authority; the
//! trace is a read, annotated with structured per-gate detail. Pure.

use crate::budget::{fmt_tokens, money, unit_tokens};
use crate::model::{Manifest, Unit};
use crate::planner::{
    fmt_num, plan, score_unit, selectable_successor, temporal_status, terms, AgentCapabilities, AgentPlan, PaymentPlan, PlanOptions, TemporalStatus,
};
use crate::budget::plan_payment;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GateName {
    Audience,
    NotFor,
    Temporal,
    Deprecated,
    Supersession,
    Relevance,
    SkillEligibility,
    Attestation,
    Payment,
    Access,
    Strict,
    MaxUnits,
    MoneyBudget,
    ContextBudget,
}

pub const GATE_ORDER: [GateName; 14] = [
    GateName::Audience,
    GateName::NotFor,
    GateName::Temporal,
    GateName::Deprecated,
    GateName::Supersession,
    GateName::Relevance,
    GateName::SkillEligibility,
    GateName::Attestation,
    GateName::Payment,
    GateName::Access,
    GateName::Strict,
    GateName::MaxUnits,
    GateName::MoneyBudget,
    GateName::ContextBudget,
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GateVerdict {
    pub gate: GateName,
    pub passed: bool,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TokensOut {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<i64>,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CostOut {
    pub amount: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    pub method: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UnitTrace {
    pub id: String,
    pub path: String,
    pub intent: String,
    pub outcome: String,
    pub gates: Vec<GateVerdict>,
    #[serde(rename = "rejectedBy", default, skip_serializing_if = "Option::is_none")]
    pub rejected_by: Option<GateName>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<TokensOut>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<CostOut>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GateSummaryEntry {
    pub gate: GateName,
    pub passed: i64,
    pub failed: i64,
}

/// The trace projection compared against golden fixtures (the embedded canonical
/// `plan` is omitted — it's covered by the plan conformance vectors).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceOutcome {
    pub task_terms: Vec<String>,
    pub as_of: String,
    pub capabilities: AgentCapabilities,
    pub units: Vec<UnitTrace>,
    pub gate_summary: Vec<GateSummaryEntry>,
}

/// The full decision trace (includes the canonical plan).
#[derive(Debug, Clone)]
pub struct DecisionTrace {
    pub task: String,
    pub task_terms: Vec<String>,
    pub as_of: String,
    pub capabilities: AgentCapabilities,
    pub plan: AgentPlan,
    pub units: Vec<UnitTrace>,
    pub gate_summary: Vec<GateSummaryEntry>,
}

/// Project the trace to its golden-fixture-comparable outcome.
pub fn trace_outcome(t: &DecisionTrace) -> TraceOutcome {
    TraceOutcome {
        task_terms: t.task_terms.clone(),
        as_of: t.as_of.clone(),
        capabilities: t.capabilities.clone(),
        units: t.units.clone(),
        gate_summary: t.gate_summary.clone(),
    }
}

struct Candidate<'a> {
    unit: &'a Unit,
    gates: Vec<GateVerdict>,
    rejected: bool,
    rejected_by: Option<GateName>,
    score: i64,
    load_eligible: bool,
    payment: PaymentPlan,
}

fn json_arr(v: &[String]) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string())
}

/// Produce a decision trace: the canonical plan annotated with per-unit gate records. Pure.
pub fn trace(manifest: &Manifest, task: &str, options: &PlanOptions) -> DecisionTrace {
    let p = plan(manifest, task, options);
    let caps = options.caps();
    let as_of = p.as_of.clone();
    let task_terms = terms(task);
    let max_units = options.max_units.unwrap_or(5);
    let budget = options.budget.as_ref();
    let budget_currency = budget.and_then(|b| b.currency.clone()).unwrap_or_else(|| "USDC".to_string());
    let upstream_spent = budget.and_then(|b| b.spent).unwrap_or(0.0);
    let context_budget = options.context_budget;

    let selected_ids: std::collections::HashSet<&str> = p.selected.iter().map(|u| u.id.as_str()).collect();

    let ar = manifest.trust.as_ref().and_then(|t| t.agent_requirements.as_ref());
    let requires_attestation = ar.and_then(|a| a.require_attestation).unwrap_or(false);
    let agent_can_attest = !requires_attestation
        || (caps.attestation_provider.is_some()
            && ar.map(|a| a.trusted_providers.contains(caps.attestation_provider.as_ref().unwrap())).unwrap_or(false));

    let mut candidates: Vec<Candidate> = Vec::new();

    for unit in &manifest.units {
        let mut gates: Vec<GateVerdict> = Vec::new();
        let mut rejected = false;
        let mut rejected_by: Option<GateName> = None;
        let mut score = 0i64;
        let mut load_eligible = true;
        let payment = plan_payment(unit.payment.as_ref().or(manifest.payment.as_ref()), &caps);

        macro_rules! reject {
            ($g:expr, $d:expr) => {{
                gates.push(GateVerdict { gate: $g, passed: false, detail: $d });
                rejected = true;
                rejected_by = Some($g);
            }};
        }
        macro_rules! pass {
            ($g:expr, $d:expr) => {{
                gates.push(GateVerdict { gate: $g, passed: true, detail: $d });
            }};
        }

        // 1. audience
        if !unit.audience.is_empty() && !unit.audience.contains(&caps.role) {
            reject!(GateName::Audience, format!("audience {} excludes role '{}'", json_arr(&unit.audience), caps.role));
        } else {
            pass!(GateName::Audience, if !unit.audience.is_empty() { format!("role '{}' in {}", caps.role, json_arr(&unit.audience)) } else { "no audience restriction".to_string() });
        }
        if rejected {
            candidates.push(Candidate { unit, gates, rejected, rejected_by, score, load_eligible, payment });
            continue;
        }

        // 2. not_for
        let nf = unit.not_for.iter().find(|n| {
            let low = n.to_lowercase();
            task_terms.iter().any(|t| low.contains(t))
        });
        if let Some(nf) = nf {
            reject!(GateName::NotFor, format!("not_for declares it does not serve '{}'", nf));
        } else {
            pass!(GateName::NotFor, if !unit.not_for.is_empty() { format!("task terms do not match {}", json_arr(&unit.not_for)) } else { "no not_for declarations".to_string() });
        }
        if rejected {
            candidates.push(Candidate { unit, gates, rejected, rejected_by, score, load_eligible, payment });
            continue;
        }

        // 3. temporal
        match temporal_status(unit, &as_of) {
            TemporalStatus::Future => reject!(GateName::Temporal, format!("not active until {}", unit.temporal.as_ref().and_then(|t| t.valid_from.as_deref()).unwrap_or(""))),
            TemporalStatus::Expired => {
                let succ = unit.temporal.as_ref().and_then(|t| t.superseded_by.as_deref()).map(|s| format!(" (superseded by {})", s)).unwrap_or_default();
                reject!(GateName::Temporal, format!("expired {}{}", unit.temporal.as_ref().and_then(|t| t.valid_until.as_deref()).unwrap_or(""), succ));
            }
            TemporalStatus::Active => pass!(GateName::Temporal, if unit.temporal.is_some() { format!("active as-of {}", as_of) } else { "no temporal constraint".to_string() }),
        }
        if rejected {
            candidates.push(Candidate { unit, gates, rejected, rejected_by, score, load_eligible, payment });
            continue;
        }

        // 4. deprecated
        if unit.deprecated == Some(true) {
            reject!(GateName::Deprecated, "deprecated".to_string());
        } else {
            pass!(GateName::Deprecated, "not deprecated".to_string());
        }
        if rejected {
            candidates.push(Candidate { unit, gates, rejected, rejected_by, score, load_eligible, payment });
            continue;
        }

        // 5. supersession
        if let Some(successor) = selectable_successor(unit, manifest, &as_of, &caps.role) {
            reject!(GateName::Supersession, format!("superseded by {} (successor active)", successor));
        } else {
            pass!(GateName::Supersession, match unit.temporal.as_ref().and_then(|t| t.superseded_by.as_deref()) {
                Some(s) => format!("successor '{}' not active", s),
                None => "no supersession declared".to_string(),
            });
        }
        if rejected {
            candidates.push(Candidate { unit, gates, rejected, rejected_by, score, load_eligible, payment });
            continue;
        }

        // 6. relevance
        let (s, reasons) = score_unit(unit, &task_terms);
        score = s;
        if score == 0 {
            reject!(GateName::Relevance, "no task-relevance match".to_string());
        } else {
            pass!(GateName::Relevance, format!("score {}: {}", score, reasons.join("; ")));
        }
        if rejected {
            candidates.push(Candidate { unit, gates, rejected, rejected_by, score, load_eligible, payment });
            continue;
        }

        // 7. skill_eligibility — a governed procedure/skill (kind: skill) fails closed:
        // load/invoke-eligible only with an explicit load_eligible grant. Soft-gate in
        // non-strict mode (mirrors attestation/payment: pass with loadEligible=false so
        // the plan still lists it); under strict it fail-closes at its own gate, which
        // keeps the trace outcome equal to the canonical plan and attributes the skip
        // precisely to skill_eligibility rather than the generic strict gate.
        if unit.kind.as_deref() == Some("skill") && unit.load_eligible != Some(true) {
            load_eligible = false;
            if options.strict == Some(true) {
                reject!(GateName::SkillEligibility, "kind: skill not invoke-eligible: no explicit eligibility grant".to_string());
            } else {
                pass!(GateName::SkillEligibility, "kind: skill not invoke-eligible: no explicit eligibility grant (loadEligible=false)".to_string());
            }
        } else {
            pass!(GateName::SkillEligibility, if unit.kind.as_deref() == Some("skill") { "kind: skill with explicit eligibility grant".to_string() } else { "not a skill".to_string() });
        }
        if rejected {
            candidates.push(Candidate { unit, gates, rejected, rejected_by, score, load_eligible, payment });
            continue;
        }

        // 8. attestation
        let unit_requires_attestation = requires_attestation && unit.access.as_deref() == Some("restricted");
        if unit_requires_attestation && !agent_can_attest {
            load_eligible = false;
            pass!(GateName::Attestation, "restricted: requires attestation the agent cannot present (loadEligible=false)".to_string());
        } else {
            pass!(GateName::Attestation, if unit_requires_attestation { "agent can present required attestation".to_string() } else { "no attestation required".to_string() });
        }

        // 9. payment
        if !payment.affordable {
            load_eligible = false;
            pass!(GateName::Payment, format!("unaffordable: {} (loadEligible=false)", payment.method));
        } else {
            pass!(GateName::Payment, if payment.method == "free" { "free".to_string() } else { format!("{}: {}", payment.method, payment.cost.clone().unwrap_or_default()) });
        }

        // 10. access
        let access = unit.access.as_deref();
        if (access == Some("authenticated") || access == Some("restricted")) && caps.credentials.is_empty() {
            if access == Some("restricted") {
                load_eligible = false;
            }
            pass!(GateName::Access, format!("access '{}': agent holds no credentials{}", access.unwrap(), if access == Some("restricted") { " (loadEligible=false)" } else { "" }));
        } else {
            pass!(GateName::Access, match access {
                Some(a) => format!("access '{}' — agent has credentials", a),
                None => "public access".to_string(),
            });
        }

        // 11. strict
        if options.strict == Some(true) && !load_eligible {
            reject!(GateName::Strict, "not load-eligible under strict mode".to_string());
        } else {
            pass!(GateName::Strict, if options.strict == Some(true) { "load-eligible under strict mode".to_string() } else { "non-strict mode".to_string() });
        }

        candidates.push(Candidate { unit, gates, rejected, rejected_by, score, load_eligible, payment });
    }

    // Phase 2: greedy loop gates over candidates that passed pre-selection.
    let mut order: Vec<usize> = (0..candidates.len()).filter(|&i| !candidates[i].rejected).collect();
    order.sort_by(|&a, &b| candidates[b].score.cmp(&candidates[a].score).then_with(|| candidates[a].unit.id.cmp(&candidates[b].unit.id)));

    let mut accepted = 0i64;
    let mut spend = 0.0f64;
    let mut used_tokens = 0i64;

    for &i in &order {
        // 12. max_units
        if accepted >= max_units {
            candidates[i].rejected = true;
            candidates[i].rejected_by = Some(GateName::MaxUnits);
            candidates[i].gates.push(GateVerdict { gate: GateName::MaxUnits, passed: false, detail: format!("position {} exceeds cap of {}", accepted + 1, max_units) });
            continue;
        }
        candidates[i].gates.push(GateVerdict { gate: GateName::MaxUnits, passed: true, detail: format!("position {} within cap of {}", accepted + 1, max_units) });

        // 13. money_budget
        let price = candidates[i].payment.price_per_request;
        let mut money_rejected = false;
        if let Some(b) = budget {
            if candidates[i].load_eligible {
                if let Some(pp) = price {
                    if pp > 0.0 {
                        if candidates[i].payment.currency.as_deref() != Some(budget_currency.as_str()) {
                            candidates[i].rejected = true;
                            candidates[i].rejected_by = Some(GateName::MoneyBudget);
                            let detail = format!("costs {}, budget is in {}", candidates[i].payment.cost.clone().unwrap_or_default(), budget_currency);
                            candidates[i].gates.push(GateVerdict { gate: GateName::MoneyBudget, passed: false, detail });
                            money_rejected = true;
                        } else if upstream_spent + spend + pp > b.amount + 1e-9 {
                            candidates[i].rejected = true;
                            candidates[i].rejected_by = Some(GateName::MoneyBudget);
                            let detail = format!("{} would exceed remaining {} of {} {}", fmt_num(pp), fmt_num(money(b.amount - upstream_spent - spend)), fmt_num(b.amount), budget_currency);
                            candidates[i].gates.push(GateVerdict { gate: GateName::MoneyBudget, passed: false, detail });
                            money_rejected = true;
                        } else {
                            spend += pp;
                            let detail = format!("{} within budget ({} of {} {} spent)", fmt_num(pp), fmt_num(money(spend)), fmt_num(b.amount), budget_currency);
                            candidates[i].gates.push(GateVerdict { gate: GateName::MoneyBudget, passed: true, detail });
                        }
                    } else {
                        candidates[i].gates.push(GateVerdict { gate: GateName::MoneyBudget, passed: true, detail: "free unit".to_string() });
                    }
                } else {
                    candidates[i].gates.push(GateVerdict { gate: GateName::MoneyBudget, passed: true, detail: "free unit".to_string() });
                }
            } else {
                candidates[i].gates.push(GateVerdict { gate: GateName::MoneyBudget, passed: true, detail: "free unit".to_string() });
            }
        } else {
            candidates[i].gates.push(GateVerdict { gate: GateName::MoneyBudget, passed: true, detail: "no budget ceiling set".to_string() });
        }
        if money_rejected {
            continue;
        }

        // 14. context_budget
        if let Some(cb) = context_budget {
            if candidates[i].load_eligible {
                let ti = unit_tokens(candidates[i].unit);
                if !ti.measured {
                    if options.strict == Some(true) {
                        candidates[i].rejected = true;
                        candidates[i].rejected_by = Some(GateName::ContextBudget);
                        candidates[i].gates.push(GateVerdict { gate: GateName::ContextBudget, passed: false, detail: "size undeclared — excluded under strict".to_string() });
                        continue;
                    }
                    candidates[i].gates.push(GateVerdict { gate: GateName::ContextBudget, passed: true, detail: "unmeasured (admitted, projection is a lower bound)".to_string() });
                } else {
                    let tokens = ti.tokens.unwrap_or(0);
                    if used_tokens + tokens > cb {
                        candidates[i].rejected = true;
                        candidates[i].rejected_by = Some(GateName::ContextBudget);
                        let detail = format!("{} tokens would exceed remaining {} of {}", fmt_tokens(tokens), fmt_tokens(cb - used_tokens), fmt_tokens(cb));
                        candidates[i].gates.push(GateVerdict { gate: GateName::ContextBudget, passed: false, detail });
                        continue;
                    }
                    used_tokens += tokens;
                    let detail = format!("{} tokens ({} of {} used)", fmt_tokens(tokens), fmt_tokens(used_tokens), fmt_tokens(cb));
                    candidates[i].gates.push(GateVerdict { gate: GateName::ContextBudget, passed: true, detail });
                }
            } else {
                candidates[i].gates.push(GateVerdict { gate: GateName::ContextBudget, passed: true, detail: "not load-eligible".to_string() });
            }
        } else {
            candidates[i].gates.push(GateVerdict { gate: GateName::ContextBudget, passed: true, detail: "no context budget set".to_string() });
        }

        accepted += 1;
    }

    // Build UnitTrace in manifest order.
    let units: Vec<UnitTrace> = candidates
        .iter()
        .map(|c| {
            let outcome = if selected_ids.contains(c.unit.id.as_str()) { "selected" } else { "skipped" };
            let mut ut = UnitTrace {
                id: c.unit.id.clone(),
                path: c.unit.path.clone(),
                intent: c.unit.intent.clone(),
                outcome: outcome.to_string(),
                gates: c.gates.clone(),
                rejected_by: c.rejected_by,
                score: if c.score > 0 { Some(c.score) } else { None },
                tokens: None,
                cost: None,
            };
            if outcome == "selected" {
                let ti = unit_tokens(c.unit);
                ut.tokens = Some(TokensOut {
                    value: ti.tokens,
                    source: if ti.measured { if ti.approximate { "estimated" } else { "declared" } } else { "unmeasured" }.to_string(),
                });
                if c.payment.method != "free" {
                    if let Some(amount) = c.payment.price_per_request {
                        ut.cost = Some(CostOut { amount, currency: c.payment.currency.clone(), method: c.payment.method.clone() });
                    }
                }
            }
            ut
        })
        .collect();

    let gate_summary: Vec<GateSummaryEntry> = GATE_ORDER
        .iter()
        .map(|&gate| {
            let mut passed = 0i64;
            let mut failed = 0i64;
            for ut in &units {
                if let Some(v) = ut.gates.iter().find(|g| g.gate == gate) {
                    if v.passed {
                        passed += 1;
                    } else {
                        failed += 1;
                    }
                }
            }
            GateSummaryEntry { gate, passed, failed }
        })
        .collect();

    DecisionTrace { task: task.to_string(), task_terms, as_of, capabilities: caps, plan: p, units, gate_summary }
}

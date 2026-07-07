//! Read a saved plan artifact (`plan --json` output) back into an [`AgentPlan`]
//! for `diff`. Only the fields `diff_plans` inspects are reconstructed — unit
//! ids/scores, skip reasons, the budget/context projections, and warnings — the
//! rest get inert defaults. Mirrors the TS `diff` command, which likewise reads
//! the artifact and unwraps a `.plan` field when the file is a tree/ask wrapper.

use crate::planner::{AgentPlan, BudgetPlan, ContextPlan, PaymentPlan, PlannedUnit, SkippedUnit, TrustInfo};
use serde_json::Value;

/// Parse a plan-artifact JSON string into an `AgentPlan`. Accepts a raw plan or a
/// wrapper object carrying the plan under `.plan` (tree/ask output).
pub fn plan_from_artifact(text: &str) -> Result<AgentPlan, String> {
    let root: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let v = match root.get("plan") {
        Some(p) if p.is_object() => p,
        _ => &root,
    };
    if !v.is_object() {
        return Err("not a plan object".to_string());
    }

    let s = |key: &str| v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let manifest = v.get("manifest");
    let man_str = |key: &str| manifest.and_then(|m| m.get(key)).and_then(|x| x.as_str()).unwrap_or("").to_string();

    let selected = v
        .get("selected")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .map(|u| PlannedUnit {
                    id: u.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    path: u.get("path").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    intent: u.get("intent").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    score: u.get("score").and_then(|x| x.as_i64()).unwrap_or(0),
                    reasons: Vec::new(),
                    payment: PaymentPlan { method: "free".to_string(), cost: None, price_per_request: None, currency: None, affordable: true },
                    requires_attestation: false,
                    load_eligible: u.get("loadEligible").and_then(|x| x.as_bool()).unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default();

    let skipped = v
        .get("skipped")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .map(|sk| SkippedUnit {
                    id: sk.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    reason: sk.get("reason").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default();

    let bud = v.get("budget");
    let bud_f = |key: &str| bud.and_then(|b| b.get(key)).and_then(|x| x.as_f64());
    let ctx = v.get("context");
    let ctx_i = |key: &str| ctx.and_then(|c| c.get(key)).and_then(|x| x.as_i64());

    let warnings = v
        .get("warnings")
        .and_then(|x| x.as_array())
        .map(|arr| arr.iter().filter_map(|w| w.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();

    Ok(AgentPlan {
        task: s("task"),
        manifest_project: man_str("project"),
        manifest_version: man_str("version"),
        trust: TrustInfo { requires_attestation: false, agent_can_attest: false, note: String::new() },
        environment: v.get("environment").and_then(|x| x.as_str()).map(|s| s.to_string()),
        as_of: s("asOf"),
        selected,
        skipped,
        federation: Vec::new(),
        budget: BudgetPlan {
            rate_tier: String::new(),
            requests_per_minute: None,
            per_request_costs: Vec::new(),
            ceiling: bud_f("ceiling"),
            currency: None,
            already_committed: None,
            projected_spend: bud_f("projectedSpend"),
            remaining: bud_f("remaining"),
            note: String::new(),
        },
        context: ContextPlan {
            ceiling: ctx_i("ceiling"),
            projected_tokens: ctx_i("projectedTokens"),
            remaining: ctx_i("remaining"),
            approximate: false,
            unmeasured: 0,
            note: String::new(),
        },
        warnings,
    })
}

//! JSON serialization of a plan artifact, byte-compatible with the TypeScript
//! `kcp-agent plan --json`. Hand-built (rather than derived) so field order,
//! optional-field omission, and JS-style number formatting match exactly.

use crate::model::{Count, Manifest};
use crate::planner::{AgentPlan, PlanOptions};
use crate::trace::DecisionTrace;
use crate::verify::SignatureResult;
use serde_json::{Map, Value};

/// Emit a whole-valued f64 as a JSON integer (like `JSON.stringify(0)` → `0`,
/// not `0.0`); otherwise as a float. Matches JS number stringification.
fn num(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < 9.0e15 {
        Value::Number((f as i64).into())
    } else {
        serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
    }
}

fn obj(pairs: Vec<(&str, Value)>) -> Value {
    let mut m = Map::new();
    for (k, v) in pairs {
        m.insert(k.to_string(), v);
    }
    Value::Object(m)
}

fn count(c: &Count) -> Value {
    match c {
        Count::N(n) => Value::Number((*n).into()),
        Count::Unlimited => Value::String("unlimited".to_string()),
    }
}

/// The `signature` block the CLI attaches to a plan (mirrors `SignatureResult`
/// from the TS `verifyManifestText`, default-verify path). See `verify.rs`.
fn signature_block(s: &SignatureResult) -> Value {
    let mut p = vec![("status", Value::from(s.status.clone())), ("detail", Value::from(s.detail.clone()))];
    if let Some(kid) = &s.key_id {
        p.push(("keyId", Value::from(kid.clone())));
    }
    obj(p)
}

/// Serialize a `SignatureResult` as `{ status, detail, keyId? }` (for a plan tree
/// node's top-level `signature` field).
pub fn signature_to_value(s: &SignatureResult) -> Value {
    signature_block(s)
}

/// Build the full plan artifact, matching the TypeScript CLI's `plan --json`.
pub fn plan_to_json(p: &AgentPlan, manifest: &Manifest, options: &PlanOptions, source: &str, sha256: &str, signature: &SignatureResult) -> Value {
    plan_to_value(p, manifest.kcp_version.as_deref(), options, source, Some(sha256), Some(signature))
}

/// Build a plan object matching the TS `AgentPlan` on the wire. Takes `kcp_version`
/// directly (project/version come from the plan) so a federation tree node can be
/// serialized without keeping its whole manifest. `sha256` and `signature` are
/// attached by the loading layer — present in the `plan --json` artifact, absent
/// from the raw plan embedded in a `--trace`.
pub fn plan_to_value(
    p: &AgentPlan,
    kcp_version: Option<&str>,
    options: &PlanOptions,
    source: &str,
    sha256: Option<&str>,
    signature: Option<&SignatureResult>,
) -> Value {
    let caps = options.caps();

    // manifest { project, version, kcpVersion?, source, sha256? }
    let mut man = vec![("project", Value::from(p.manifest_project.clone())), ("version", Value::from(p.manifest_version.clone()))];
    if let Some(kv) = kcp_version {
        man.push(("kcpVersion", Value::from(kv)));
    }
    man.push(("source", Value::from(source)));
    if let Some(sha) = sha256 {
        man.push(("sha256", Value::from(sha)));
    }

    // options { capabilities, maxUnits, strict, budget?, contextBudget? }
    let mut cap_pairs = vec![
        ("role", Value::from(caps.role.clone())),
        ("paymentMethods", Value::from(caps.payment_methods.clone())),
        ("credentials", Value::from(caps.credentials.clone())),
    ];
    if let Some(ap) = &caps.attestation_provider {
        cap_pairs.push(("attestationProvider", Value::from(ap.clone())));
    }
    let mut opt_pairs = vec![
        ("capabilities", obj(cap_pairs)),
        ("maxUnits", Value::from(options.max_units.unwrap_or(5))),
        ("strict", Value::from(options.strict.unwrap_or(false))),
    ];
    if let Some(b) = &options.budget {
        let mut bp = vec![("amount", num(b.amount))];
        if let Some(c) = &b.currency {
            bp.push(("currency", Value::from(c.clone())));
        }
        if let Some(s) = b.spent {
            bp.push(("spent", num(s)));
        }
        opt_pairs.push(("budget", obj(bp)));
    }
    if let Some(cb) = options.context_budget {
        opt_pairs.push(("contextBudget", Value::from(cb)));
    }

    // selected
    let selected: Vec<Value> = p
        .selected
        .iter()
        .map(|u| {
            let mut pay = vec![("method", Value::from(u.payment.method.clone()))];
            if let Some(c) = &u.payment.cost {
                pay.push(("cost", Value::from(c.clone())));
            }
            if let Some(ppr) = u.payment.price_per_request {
                pay.push(("pricePerRequest", num(ppr)));
            }
            if let Some(cur) = &u.payment.currency {
                pay.push(("currency", Value::from(cur.clone())));
            }
            pay.push(("affordable", Value::from(u.payment.affordable)));
            obj(vec![
                ("id", Value::from(u.id.clone())),
                ("path", Value::from(u.path.clone())),
                ("intent", Value::from(u.intent.clone())),
                ("score", Value::from(u.score)),
                ("reasons", Value::from(u.reasons.clone())),
                ("payment", obj(pay)),
                ("requiresAttestation", Value::from(u.requires_attestation)),
                ("loadEligible", Value::from(u.load_eligible)),
            ])
        })
        .collect();

    let skipped: Vec<Value> = p.skipped.iter().map(|s| obj(vec![("id", Value::from(s.id.clone())), ("reason", Value::from(s.reason.clone()))])).collect();

    let federation: Vec<Value> = p
        .federation
        .iter()
        .map(|fed| {
            let mut fp = vec![
                ("id", Value::from(fed.id.clone())),
                ("url", Value::from(fed.url.clone())),
                ("selected", Value::from(fed.selected)),
                ("reason", Value::from(fed.reason.clone())),
            ];
            if let Some(cn) = &fed.credential_needed {
                fp.push(("credentialNeeded", Value::from(cn.clone())));
            }
            if let Some(du) = &fed.docs_url {
                fp.push(("docsUrl", Value::from(du.clone())));
            }
            obj(fp)
        })
        .collect();

    // budget
    let mut bud = vec![("rateTier", Value::from(p.budget.rate_tier.clone()))];
    if let Some(rpm) = &p.budget.requests_per_minute {
        bud.push(("requestsPerMinute", count(rpm)));
    }
    let prc: Vec<Value> = p.budget.per_request_costs.iter().map(|(unit, cost)| obj(vec![("unit", Value::from(unit.clone())), ("cost", Value::from(cost.clone()))])).collect();
    bud.push(("perRequestCosts", Value::Array(prc)));
    if let Some(c) = p.budget.ceiling {
        bud.push(("ceiling", num(c)));
    }
    if let Some(cur) = &p.budget.currency {
        bud.push(("currency", Value::from(cur.clone())));
    }
    if let Some(ac) = p.budget.already_committed {
        bud.push(("alreadyCommitted", num(ac)));
    }
    if let Some(ps) = p.budget.projected_spend {
        bud.push(("projectedSpend", num(ps)));
    }
    if let Some(r) = p.budget.remaining {
        bud.push(("remaining", num(r)));
    }
    bud.push(("note", Value::from(p.budget.note.clone())));

    // context
    let mut ctx = vec![];
    if let Some(c) = p.context.ceiling {
        ctx.push(("ceiling", Value::from(c)));
    }
    if let Some(pt) = p.context.projected_tokens {
        ctx.push(("projectedTokens", Value::from(pt)));
    }
    if let Some(r) = p.context.remaining {
        ctx.push(("remaining", Value::from(r)));
    }
    ctx.push(("approximate", Value::from(p.context.approximate)));
    ctx.push(("unmeasured", Value::from(p.context.unmeasured)));
    ctx.push(("note", Value::from(p.context.note.clone())));

    let mut top = vec![
        ("task", Value::from(p.task.clone())),
        ("manifest", obj(man)),
        ("trust", obj(vec![
            ("requiresAttestation", Value::from(p.trust.requires_attestation)),
            ("agentCanAttest", Value::from(p.trust.agent_can_attest)),
            ("note", Value::from(p.trust.note.clone())),
        ])),
    ];
    if let Some(env) = &p.environment {
        top.push(("environment", Value::from(env.clone())));
    }
    top.push(("asOf", Value::from(p.as_of.clone())));
    top.push(("options", obj(opt_pairs)));
    top.push(("selected", Value::Array(selected)));
    top.push(("skipped", Value::Array(skipped)));
    top.push(("federation", Value::Array(federation)));
    top.push(("budget", obj(bud)));
    top.push(("context", obj(ctx)));
    top.push(("warnings", Value::from(p.warnings.clone())));
    if let Some(sig) = signature {
        top.push(("signature", signature_block(sig)));
    }

    obj(top)
}

/// Build the decision-trace artifact, matching the TS CLI's `plan --trace --json`.
/// The embedded `plan` is the *raw* plan (no sha256/signature — the reference
/// serializes `plan()` output directly, before the loading layer augments it).
pub fn trace_to_json(t: &DecisionTrace, manifest: &Manifest, options: &PlanOptions, source: &str) -> Value {
    obj(vec![
        ("task", Value::from(t.task.clone())),
        ("taskTerms", Value::from(t.task_terms.clone())),
        ("asOf", Value::from(t.as_of.clone())),
        ("capabilities", serde_json::to_value(&t.capabilities).unwrap_or(Value::Null)),
        ("plan", plan_to_value(&t.plan, manifest.kcp_version.as_deref(), options, source, None, None)),
        ("units", serde_json::to_value(&t.units).unwrap_or(Value::Null)),
        ("gateSummary", serde_json::to_value(&t.gate_summary).unwrap_or(Value::Null)),
    ])
}

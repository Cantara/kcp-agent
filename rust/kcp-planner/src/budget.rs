//! Budget planning helpers — a Rust port of the payment / rate-limit / token
//! machinery in `src/planner.ts`. Greedy by score; money rounds to 6 decimals
//! to match TypeScript's `Number(n.toFixed(6))`.

use crate::model::{Count, Manifest, Payment, Unit};
use crate::planner::{fmt_num, AgentCapabilities, BudgetInput, BudgetPlan, ContextPlan, PaymentPlan, PlannedUnit};

/// Round away float noise in currency arithmetic — matches `Number(n.toFixed(6))`.
pub fn money(n: f64) -> f64 {
    format!("{:.6}", n).parse::<f64>().unwrap_or(n)
}

/// Thousands-separated integer for readable token arithmetic (1240 → "1,240").
pub fn fmt_tokens(n: i64) -> String {
    let neg = n < 0;
    let digits = n.abs().to_string();
    let bytes = digits.as_bytes();
    let mut out = String::new();
    for (i, c) in bytes.iter().enumerate() {
        if i > 0 && (bytes.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(*c as char);
    }
    if neg {
        format!("-{}", out)
    } else {
        out
    }
}

/// Choose the first payment method the agent supports, from a unit/root payment block.
pub fn plan_payment(payment: Option<&Payment>, caps: &AgentCapabilities) -> PaymentPlan {
    let methods = payment.and_then(|p| p.methods.as_ref());
    let methods = match methods {
        Some(m) if !m.is_empty() => m,
        _ => {
            return PaymentPlan { method: "free".to_string(), cost: None, price_per_request: None, currency: None, affordable: true };
        }
    };
    for m in methods {
        if !caps.payment_methods.contains(&m.r#type) {
            continue;
        }
        if m.r#type == "free" {
            return PaymentPlan { method: "free".to_string(), cost: None, price_per_request: None, currency: None, affordable: true };
        }
        if m.r#type == "x402" {
            let price = m.price_per_request.as_ref().and_then(|s| s.parse::<f64>().ok());
            let currency = m.currency.clone().unwrap_or_default();
            return PaymentPlan {
                method: "x402".to_string(),
                cost: Some(format!("{} {}/request", m.price_per_request.clone().unwrap_or_default(), currency)),
                price_per_request: price,
                currency: m.currency.clone(),
                affordable: true,
            };
        }
        return PaymentPlan { method: m.r#type.clone(), cost: None, price_per_request: None, currency: None, affordable: true };
    }
    let need: Vec<String> = methods.iter().map(|m| m.r#type.clone()).filter(|t| t != "free").collect();
    PaymentPlan { method: format!("needs {}", need.join(" or ")), cost: None, price_per_request: None, currency: None, affordable: false }
}

pub struct TokenInfo {
    pub tokens: Option<i64>,
    pub approximate: bool,
    pub measured: bool,
}

/// The token cost the planner weighs for a unit, from metadata (audit-before-action).
pub fn unit_tokens(unit: &Unit) -> TokenInfo {
    if let Some(st) = unit.size_tokens {
        return TokenInfo { tokens: Some(st), approximate: false, measured: true };
    }
    if let Some(b) = unit.bytes {
        // ceil(bytes / 4)
        return TokenInfo { tokens: Some((b + 3) / 4), approximate: true, measured: true };
    }
    TokenInfo { tokens: None, approximate: false, measured: false }
}

fn tier_block<'a>(m: &'a Manifest, tier: &str) -> Option<Option<Count>> {
    let rl = m.rate_limits.as_ref()?;
    let t = match tier {
        "premium" => rl.premium.as_ref(),
        "authenticated" => rl.authenticated.as_ref(),
        _ => rl.default.as_ref(),
    };
    Some(t.and_then(|b| b.requests_per_minute.clone()))
}

/// Resolve the rate-limit tier, per-request costs, and the spend projection.
pub fn plan_budget(manifest: &Manifest, caps: &AgentCapabilities, selected: &[PlannedUnit], budget: Option<&BudgetInput>) -> BudgetPlan {
    let rl = manifest.rate_limits.as_ref();
    let mut tier = "default".to_string();
    if caps.payment_methods.iter().any(|m| m == "subscription") && rl.map_or(false, |r| r.premium.is_some()) {
        tier = "premium".to_string();
    } else if !caps.credentials.is_empty() && rl.map_or(false, |r| r.authenticated.is_some()) {
        tier = "authenticated".to_string();
    }
    let requests_per_minute = tier_block(manifest, &tier).flatten();

    let loadable: Vec<&PlannedUnit> = selected.iter().filter(|u| u.load_eligible).collect();
    let per_request_costs: Vec<(String, String)> = loadable
        .iter()
        .filter(|u| u.payment.method == "x402" && u.payment.cost.is_some())
        .map(|u| (u.id.clone(), u.payment.cost.clone().unwrap()))
        .collect();
    let projected_spend = money(loadable.iter().map(|u| u.payment.price_per_request.unwrap_or(0.0)).sum());

    match budget {
        None => BudgetPlan {
            rate_tier: tier,
            requests_per_minute,
            per_request_costs: per_request_costs.clone(),
            ceiling: None,
            currency: None,
            already_committed: None,
            projected_spend: None,
            remaining: None,
            note: if !per_request_costs.is_empty() {
                format!("{} selected unit(s) are pay-per-request; budget before loading.", per_request_costs.len())
            } else {
                "all selected units are free to load at the resolved tier.".to_string()
            },
        },
        Some(b) => {
            let currency = b.currency.clone().unwrap_or_else(|| "USDC".to_string());
            let spent = money(b.spent.unwrap_or(0.0));
            let remaining = money(b.amount - spent - projected_spend);
            let note = format!(
                "projected spend {}{} of {} {}; {} remaining.",
                fmt_num(projected_spend),
                if spent > 0.0 { format!(" (+{} committed upstream)", fmt_num(spent)) } else { String::new() },
                fmt_num(b.amount),
                currency,
                fmt_num(remaining)
            );
            BudgetPlan {
                rate_tier: tier,
                requests_per_minute,
                per_request_costs,
                ceiling: Some(b.amount),
                currency: Some(currency),
                already_committed: if spent > 0.0 { Some(spent) } else { None },
                projected_spend: Some(projected_spend),
                remaining: Some(remaining),
                note,
            }
        }
    }
}

/// Build the ContextPlan from the finally-selected units and the token ceiling.
pub fn plan_context(manifest: &Manifest, selected: &[PlannedUnit], ceiling: Option<i64>) -> ContextPlan {
    let mut projected_tokens = 0i64;
    let mut approximate = false;
    let mut unmeasured = 0i64;
    for s in selected {
        if !s.load_eligible {
            continue;
        }
        let unit = manifest.units.iter().find(|u| u.id == s.id);
        let info = match unit {
            Some(u) => unit_tokens(u),
            None => TokenInfo { tokens: None, approximate: false, measured: false },
        };
        if !info.measured {
            unmeasured += 1;
            continue;
        }
        projected_tokens += info.tokens.unwrap_or(0);
        if info.approximate {
            approximate = true;
        }
    }
    match ceiling {
        None => ContextPlan {
            ceiling: None,
            projected_tokens: None,
            remaining: None,
            approximate,
            unmeasured,
            note: "no context budget set.".to_string(),
        },
        Some(c) => {
            let remaining = c - projected_tokens;
            let mut flags: Vec<String> = Vec::new();
            if approximate {
                flags.push("some sizes estimated".to_string());
            }
            if unmeasured > 0 {
                flags.push(format!("{} unmeasured", unmeasured));
            }
            let flag_str = if flags.is_empty() { String::new() } else { format!(" ({})", flags.join(", ")) };
            ContextPlan {
                ceiling: Some(c),
                projected_tokens: Some(projected_tokens),
                remaining: Some(remaining),
                approximate,
                unmeasured,
                note: format!("projected {} of {} tokens; {} remaining{}.", fmt_tokens(projected_tokens), fmt_tokens(c), fmt_tokens(remaining), flag_str),
            }
        }
    }
}

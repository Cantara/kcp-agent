//! Conformance vectors — a Rust port of `src/vectors.ts`. `VectorOutcome` is the
//! portable projection of a plan; a conformant implementation reproduces every
//! vector's `expect` exactly. Deserialized from the shared `vectors/*.json`
//! corpus and compared structurally (derive `PartialEq`).

use crate::model::parse_manifest;
use crate::planner::{plan, AgentPlan, PlanOptions};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SelectedOutcome {
    pub id: String,
    #[serde(rename = "loadEligible")]
    pub load_eligible: bool,
    pub score: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkippedOutcome {
    pub id: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FederationOutcome {
    pub id: String,
    pub selected: bool,
    pub reason: String,
    #[serde(rename = "credentialNeeded", default, skip_serializing_if = "Option::is_none")]
    pub credential_needed: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrustOutcome {
    #[serde(rename = "requiresAttestation")]
    pub requires_attestation: bool,
    #[serde(rename = "agentCanAttest")]
    pub agent_can_attest: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BudgetOutcome {
    #[serde(rename = "rateTier")]
    pub rate_tier: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ceiling: Option<f64>,
    #[serde(rename = "projectedSpend", default, skip_serializing_if = "Option::is_none")]
    pub projected_spend: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remaining: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContextOutcome {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ceiling: Option<i64>,
    #[serde(rename = "projectedTokens", default, skip_serializing_if = "Option::is_none")]
    pub projected_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remaining: Option<i64>,
    pub approximate: bool,
    pub unmeasured: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VectorOutcome {
    pub selected: Vec<SelectedOutcome>,
    pub skipped: Vec<SkippedOutcome>,
    pub federation: Vec<FederationOutcome>,
    pub trust: TrustOutcome,
    pub budget: BudgetOutcome,
    pub context: ContextOutcome,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConformanceVector {
    pub name: String,
    #[serde(default)]
    pub spec: String,
    #[serde(default)]
    pub description: String,
    pub manifest: String,
    pub task: String,
    #[serde(default)]
    pub options: PlanOptions,
    pub expect: VectorOutcome,
}

/// Project a full plan down to its portable, comparable outcome.
pub fn outcome_of(p: &AgentPlan) -> VectorOutcome {
    VectorOutcome {
        selected: p
            .selected
            .iter()
            .map(|u| SelectedOutcome { id: u.id.clone(), load_eligible: u.load_eligible, score: u.score })
            .collect(),
        skipped: p.skipped.iter().map(|s| SkippedOutcome { id: s.id.clone(), reason: s.reason.clone() }).collect(),
        federation: p
            .federation
            .iter()
            .map(|f| FederationOutcome { id: f.id.clone(), selected: f.selected, reason: f.reason.clone(), credential_needed: f.credential_needed.clone() })
            .collect(),
        trust: TrustOutcome { requires_attestation: p.trust.requires_attestation, agent_can_attest: p.trust.agent_can_attest },
        budget: BudgetOutcome {
            rate_tier: p.budget.rate_tier.clone(),
            ceiling: p.budget.ceiling,
            projected_spend: p.budget.projected_spend,
            remaining: p.budget.remaining,
            currency: p.budget.currency.clone(),
        },
        context: ContextOutcome {
            ceiling: p.context.ceiling,
            projected_tokens: p.context.projected_tokens,
            remaining: p.context.remaining,
            approximate: p.context.approximate,
            unmeasured: p.context.unmeasured,
        },
        warnings: p.warnings.clone(),
    }
}

/// Parse a vector's manifest, run the planner, and return the outcome.
pub fn run_vector(v: &ConformanceVector) -> VectorOutcome {
    let manifest = parse_manifest(&v.manifest, Some(&v.name)).unwrap_or_else(|e| panic!("vector '{}': manifest parse error: {}", v.name, e));
    outcome_of(&plan(&manifest, &v.task, &v.options))
}

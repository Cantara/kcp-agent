//! Plan diff — a Rust port of `src/diff.ts`. Compare two `AgentPlan`s and report
//! what moved: units that flipped selected/skipped, score shifts, presence,
//! budget/context projection changes, skip-reason changes, warning changes.
//! Pure. Deterministic: the id walk preserves first-seen order (a.selected,
//! a.skipped, b.selected, b.skipped) exactly like the TypeScript `Set` union.

use crate::planner::AgentPlan;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MoveSide {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UnitMove {
    pub id: String,
    pub direction: String,
    pub from: MoveSide,
    pub to: MoveSide,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScoreChange {
    pub id: String,
    pub before: i64,
    pub after: i64,
    pub delta: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UnitPresence {
    pub id: String,
    pub side: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BudgetShift {
    pub field: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReasonChange {
    pub id: String,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WarningChanges {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiffEnd {
    pub project: String,
    pub version: String,
    pub task: String,
    #[serde(rename = "asOf")]
    pub as_of: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanDiff {
    pub a: DiffEnd,
    pub b: DiffEnd,
    pub identical: bool,
    pub moves: Vec<UnitMove>,
    pub score_changes: Vec<ScoreChange>,
    pub presence: Vec<UnitPresence>,
    pub budget_shifts: Vec<BudgetShift>,
    pub reason_changes: Vec<ReasonChange>,
    pub warning_changes: WarningChanges,
}

/// Ordered, deduped union of ids across the four buckets — matches TS `Set` order.
fn ordered_ids(plan: &AgentPlan) -> Vec<String> {
    let mut ids = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for id in plan.selected.iter().map(|u| &u.id).chain(plan.skipped.iter().map(|s| &s.id)) {
        if seen.insert(id.clone()) {
            ids.push(id.clone());
        }
    }
    ids
}

/// Compare two plans and report what changed. Pure.
pub fn diff_plans(a: &AgentPlan, b: &AgentPlan) -> PlanDiff {
    let a_sel: std::collections::HashMap<&str, i64> = a.selected.iter().map(|u| (u.id.as_str(), u.score)).collect();
    let a_skip: std::collections::HashMap<&str, &str> = a.skipped.iter().map(|s| (s.id.as_str(), s.reason.as_str())).collect();
    let b_sel: std::collections::HashMap<&str, i64> = b.selected.iter().map(|u| (u.id.as_str(), u.score)).collect();
    let b_skip: std::collections::HashMap<&str, &str> = b.skipped.iter().map(|s| (s.id.as_str(), s.reason.as_str())).collect();

    let ids_a = ordered_ids(a);
    let ids_b = ordered_ids(b);
    let mut all_ids = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for id in ids_a.iter().chain(ids_b.iter()) {
        if seen.insert(id.clone()) {
            all_ids.push(id.clone());
        }
    }

    let in_a = |id: &str| a_sel.contains_key(id) || a_skip.contains_key(id);
    let in_b = |id: &str| b_sel.contains_key(id) || b_skip.contains_key(id);

    let mut moves = Vec::new();
    let mut score_changes = Vec::new();
    let mut presence = Vec::new();
    let mut reason_changes = Vec::new();

    for id in &all_ids {
        let ida = in_a(id);
        let idb = in_b(id);
        if ida && !idb {
            presence.push(UnitPresence { id: id.clone(), side: "a_only".to_string() });
            continue;
        }
        if !ida && idb {
            presence.push(UnitPresence { id: id.clone(), side: "b_only".to_string() });
            continue;
        }
        let sel_a = a_sel.get(id.as_str()).copied();
        let sel_b = b_sel.get(id.as_str()).copied();
        let skip_a = a_skip.get(id.as_str()).copied();
        let skip_b = b_skip.get(id.as_str()).copied();

        if let (Some(sa), Some(rb)) = (sel_a, skip_b) {
            moves.push(UnitMove {
                id: id.clone(),
                direction: "selected_to_skipped".to_string(),
                from: MoveSide { score: Some(sa), reason: None },
                to: MoveSide { score: None, reason: Some(rb.to_string()) },
            });
        } else if let (Some(ra), Some(sb)) = (skip_a, sel_b) {
            moves.push(UnitMove {
                id: id.clone(),
                direction: "skipped_to_selected".to_string(),
                from: MoveSide { score: None, reason: Some(ra.to_string()) },
                to: MoveSide { score: Some(sb), reason: None },
            });
        } else if let (Some(sa), Some(sb)) = (sel_a, sel_b) {
            if sa != sb {
                score_changes.push(ScoreChange { id: id.clone(), before: sa, after: sb, delta: sb - sa });
            }
        } else if let (Some(ra), Some(rb)) = (skip_a, skip_b) {
            if ra != rb {
                reason_changes.push(ReasonChange { id: id.clone(), before: ra.to_string(), after: rb.to_string() });
            }
        }
    }

    let mut budget_shifts = Vec::new();
    let i2f = |o: Option<i64>| o.map(|n| n as f64);
    let fields: [(&str, Option<f64>, Option<f64>); 6] = [
        ("budget.ceiling", a.budget.ceiling, b.budget.ceiling),
        ("budget.projectedSpend", a.budget.projected_spend, b.budget.projected_spend),
        ("budget.remaining", a.budget.remaining, b.budget.remaining),
        ("context.ceiling", i2f(a.context.ceiling), i2f(b.context.ceiling)),
        ("context.projectedTokens", i2f(a.context.projected_tokens), i2f(b.context.projected_tokens)),
        ("context.remaining", i2f(a.context.remaining), i2f(b.context.remaining)),
    ];
    for (field, before, after) in fields {
        if before != after {
            budget_shifts.push(BudgetShift { field: field.to_string(), before, after });
        }
    }

    let added: Vec<String> = b.warnings.iter().filter(|w| !a.warnings.contains(w)).cloned().collect();
    let removed: Vec<String> = a.warnings.iter().filter(|w| !b.warnings.contains(w)).cloned().collect();

    let identical = moves.is_empty()
        && score_changes.is_empty()
        && presence.is_empty()
        && budget_shifts.is_empty()
        && reason_changes.is_empty()
        && added.is_empty()
        && removed.is_empty();

    PlanDiff {
        a: DiffEnd { project: a.manifest_project.clone(), version: a.manifest_version.clone(), task: a.task.clone(), as_of: a.as_of.clone() },
        b: DiffEnd { project: b.manifest_project.clone(), version: b.manifest_version.clone(), task: b.task.clone(), as_of: b.as_of.clone() },
        identical,
        moves,
        score_changes,
        presence,
        budget_shifts,
        reason_changes,
        warning_changes: WarningChanges { added, removed },
    }
}

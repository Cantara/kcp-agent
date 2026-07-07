//! Replay — determinism as a verifiable property (a port of `src/replay.ts`). A
//! saved `plan --json` artifact carries each manifest's sha256 and an echo of the
//! planner inputs. Replay re-fetches every manifest, compares the bytes, re-runs
//! the pure planner from the saved inputs, and compares the fresh plan to the
//! saved one — identical, or drifted with the fields that moved. The saved plan
//! is evidence; replay is the cross-examination.

use sha2::{Digest, Sha256};
use serde_json::{json, Value};

use crate::client::load_manifest_text;
use crate::fetch::FetchGuard;
use crate::json::plan_to_value;
use crate::model::parse_manifest;
use crate::planner::{plan, PlanOptions};
use crate::verify::SignatureResult;

#[derive(Debug, Clone, serde::Serialize)]
pub struct ReplayCheck {
    pub source: String,
    pub project: String,
    pub status: String, // "identical" | "drifted" | "error"
    pub detail: String,
    /// Top-level plan fields that differ, when drifted at the plan level.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<String>>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ReplayReport {
    pub artifact: String,
    pub checks: Vec<ReplayCheck>,
    pub ok: bool,
}

/// Accept any artifact shape the CLI emits: a single plan, a `--follow` tree, or
/// an `ask --json` wrapper. Returns the saved plan objects (as JSON values).
pub fn collect_saved_plans(json: &Value) -> Result<Vec<Value>, String> {
    if let Value::Object(map) = json {
        if map.get("task").map(|t| t.is_string()).unwrap_or(false) && map.get("selected").map(|s| s.is_array()).unwrap_or(false) {
            return Ok(vec![json.clone()]);
        }
        if map.get("children").map(|c| c.is_array()).unwrap_or(false) {
            let mut out = Vec::new();
            walk_tree(json, &mut out);
            return Ok(out);
        }
        if let Some(p) = map.get("plan") {
            return collect_saved_plans(p);
        }
    }
    Err("unrecognized artifact — expected the JSON output of `kcp-planner plan --json` (a plan or a --follow tree)".to_string())
}

fn walk_tree(node: &Value, out: &mut Vec<Value>) {
    if let Some(p) = node.get("plan") {
        if p.is_object() {
            out.push(p.clone());
        }
    }
    if let Some(Value::Array(children)) = node.get("children") {
        for child in children {
            walk_tree(child, out);
        }
    }
}

/// Strip what the pure planner cannot reproduce: the loading layer's signature
/// and manifest sha256. Mirrors TS `comparable`.
fn comparable(mut p: Value) -> Value {
    if let Value::Object(map) = &mut p {
        map.remove("signature");
        if let Some(Value::Object(m)) = map.get_mut("manifest") {
            m.remove("sha256");
        }
    }
    p
}

/// Reconstruct the planner inputs the artifact echoed. NB: mirrors the reference
/// exactly, including that it does **not** re-apply `contextBudget` on replay.
fn saved_options(saved: &Value) -> Result<PlanOptions, String> {
    let opts = saved.get("options").cloned().unwrap_or(Value::Null);
    let reconstructed = json!({
        "capabilities": opts.get("capabilities").cloned().unwrap_or(Value::Null),
        "env": saved.get("environment").cloned().unwrap_or(Value::Null),
        "asOf": saved.get("asOf").cloned().unwrap_or(Value::Null),
        "maxUnits": opts.get("maxUnits").cloned().unwrap_or(Value::Null),
        "strict": opts.get("strict").cloned().unwrap_or(Value::Null),
        "budget": opts.get("budget").cloned().unwrap_or(Value::Null),
    });
    serde_json::from_value(reconstructed).map_err(|e| e.to_string())
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut cur = v;
    for p in path {
        cur = cur.get(p)?;
    }
    cur.as_str()
}

/// Replay every plan in a saved artifact against the live manifests.
pub async fn replay_artifact(artifact_json: &Value, artifact_name: &str, guard: &FetchGuard) -> ReplayReport {
    let saved_plans = match collect_saved_plans(artifact_json) {
        Ok(v) => v,
        Err(e) => return ReplayReport { artifact: artifact_name.to_string(), checks: vec![ReplayCheck { source: "(none)".into(), project: "(unknown)".into(), status: "error".into(), detail: e, fields: None }], ok: false },
    };
    let mut checks = Vec::new();

    for s in &saved_plans {
        let project = str_at(s, &["manifest", "project"]).unwrap_or("(unknown)").to_string();
        let source = match str_at(s, &["manifest", "source"]) {
            Some(x) => x.to_string(),
            None => {
                checks.push(ReplayCheck { source: "(none)".into(), project, status: "error".into(), detail: "saved plan has no manifest.source to re-fetch".into(), fields: None });
                continue;
            }
        };
        if s.get("options").map(|o| o.is_null()).unwrap_or(true) {
            checks.push(ReplayCheck { source, project, status: "error".into(), detail: "saved plan carries no echoed planner options — the artifact predates replay support; re-plan to refresh it".into(), fields: None });
            continue;
        }

        let (text, resolved_source) = match load_manifest_text(&source, guard).await {
            Ok(v) => v,
            Err(e) => {
                checks.push(ReplayCheck { source, project, status: "error".into(), detail: format!("fetch failed: {}", e), fields: None });
                continue;
            }
        };

        // Bytes first: a changed manifest makes the plan stale by definition.
        let digest = format!("{:x}", Sha256::digest(text.as_bytes()));
        let saved_sha = str_at(s, &["manifest", "sha256"]).map(|x| x.to_string());
        if let Some(saved_sha) = &saved_sha {
            if &digest != saved_sha {
                checks.push(ReplayCheck { source, project, status: "drifted".into(), detail: format!("manifest bytes changed: sha256 {}… ≠ saved {}…", &digest[..12], &saved_sha[..12.min(saved_sha.len())]), fields: None });
                continue;
            }
        }

        let options = match saved_options(s) {
            Ok(o) => o,
            Err(e) => {
                checks.push(ReplayCheck { source, project, status: "error".into(), detail: format!("re-plan failed: bad saved options: {}", e), fields: None });
                continue;
            }
        };
        let manifest = match parse_manifest(&text, Some(&resolved_source)) {
            Ok(m) => m,
            Err(e) => {
                checks.push(ReplayCheck { source, project, status: "error".into(), detail: format!("re-plan failed: {}", e), fields: None });
                continue;
            }
        };
        let task = s.get("task").and_then(|t| t.as_str()).unwrap_or("");
        let fresh = plan(&manifest, task, &options);
        let fresh_sig = SignatureResult { status: String::new(), detail: String::new(), key_id: None };
        // No sha256/signature — the pure, comparable projection.
        let fresh_val = comparable(plan_to_value(&fresh, &manifest, &options, &resolved_source, None, Some(&fresh_sig)));
        let saved_val = comparable(s.clone());

        if saved_val == fresh_val {
            let detail = format!(
                "{} selected, {} skipped — plan reproduced byte-identically{}",
                fresh.selected.len(),
                fresh.skipped.len(),
                if saved_sha.is_some() { ", manifest sha256 matches" } else { " (saved artifact carried no manifest sha256)" }
            );
            checks.push(ReplayCheck { source, project, status: "identical".into(), detail, fields: None });
            continue;
        }
        // Which top-level fields moved?
        let mut keys: Vec<String> = Vec::new();
        for k in saved_val.as_object().into_iter().flatten().map(|(k, _)| k).chain(fresh_val.as_object().into_iter().flatten().map(|(k, _)| k)) {
            if !keys.contains(k) {
                keys.push(k.clone());
            }
        }
        let mut fields: Vec<String> = keys.into_iter().filter(|k| saved_val.get(k) != fresh_val.get(k)).collect();
        fields.sort();
        checks.push(ReplayCheck { source, project, status: "drifted".into(), detail: format!("plan differs in: {}", fields.join(", ")), fields: Some(fields) });
    }

    let ok = !checks.is_empty() && checks.iter().all(|c| c.status == "identical");
    ReplayReport { artifact: artifact_name.to_string(), checks, ok }
}

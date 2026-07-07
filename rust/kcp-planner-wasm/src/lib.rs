//! WebAssembly bindings for the deterministic KCP planner.
//!
//! "Protocol, not library" made literal: the same Rust core that builds to the
//! `kcp-planner` CLI compiles to a WASM module that runs in a browser tab and
//! produces byte-identical plans. The boundary is deliberately thin — every
//! function takes strings and returns a JSON string, so the JS glue stays small
//! and the contract is just "JSON in, JSON out".
//!
//! Errors never trap: a bad manifest or malformed options comes back as
//! `{"error": "..."}`, so the playground can render the message instead of
//! hitting a WASM abort.

use kcp_planner::{
    diff_plans as core_diff, parse_manifest, plan as core_plan, plan_from_artifact, plan_to_json, trace as core_trace, trace_to_json, validate_manifest,
    verify_manifest_text, Finding, PlanOptions, ValidationReport,
};
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;

/// Label used for `manifest.source` when a manifest arrives as raw text (no path).
const SOURCE: &str = "playground.yaml";

/// Install a panic hook so a Rust panic surfaces as a readable `console.error`
/// in browser devtools rather than an opaque `unreachable`.
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

fn error_json(message: String) -> String {
    serde_json::json!({ "error": message }).to_string()
}

fn parse_options(options_json: &str) -> Result<PlanOptions, String> {
    if options_json.trim().is_empty() {
        return Ok(PlanOptions::default());
    }
    serde_json::from_str(options_json).map_err(|e| format!("invalid options JSON: {}", e))
}

/// Plan: parse a YAML manifest, run the planner, return the plan artifact as
/// pretty JSON — byte-identical to `kcp-planner plan --json` for the same inputs.
#[wasm_bindgen]
pub fn plan(manifest_yaml: &str, task: &str, options_json: &str) -> String {
    let manifest = match parse_manifest(manifest_yaml, Some(SOURCE)) {
        Ok(m) => m,
        Err(e) => return error_json(format!("manifest does not parse: {}", e)),
    };
    let options = match parse_options(options_json) {
        Ok(o) => o,
        Err(e) => return error_json(e),
    };
    let p = core_plan(&manifest, task, &options);
    let sha256 = format!("{:x}", Sha256::digest(manifest_yaml.as_bytes()));
    // No filesystem in the browser: a locatable local signature can't be fetched,
    // so signed manifests read as `unverifiable` here (never fail-open) while
    // unsigned manifests match the CLI exactly.
    let sig = verify_manifest_text(manifest_yaml, manifest.signing.as_ref(), Some(SOURCE));
    let v = plan_to_json(&p, &manifest, &options, SOURCE, &sha256, &sig);
    serde_json::to_string_pretty(&v).unwrap_or_else(|e| error_json(e.to_string()))
}

/// Trace: the full decision cascade for every unit, as pretty JSON — identical
/// to `kcp-planner plan --trace --json`.
#[wasm_bindgen]
pub fn trace(manifest_yaml: &str, task: &str, options_json: &str) -> String {
    let manifest = match parse_manifest(manifest_yaml, Some(SOURCE)) {
        Ok(m) => m,
        Err(e) => return error_json(format!("manifest does not parse: {}", e)),
    };
    let options = match parse_options(options_json) {
        Ok(o) => o,
        Err(e) => return error_json(e),
    };
    let t = core_trace(&manifest, task, &options);
    let v = trace_to_json(&t, &manifest, &options, SOURCE);
    serde_json::to_string_pretty(&v).unwrap_or_else(|e| error_json(e.to_string()))
}

/// Diff: compare two saved plan artifacts, as pretty JSON — identical to
/// `kcp-planner diff a.json b.json --json`.
#[wasm_bindgen]
pub fn diff_plans(plan_a_json: &str, plan_b_json: &str) -> String {
    let a = match plan_from_artifact(plan_a_json) {
        Ok(p) => p,
        Err(e) => return error_json(format!("plan A: {}", e)),
    };
    let b = match plan_from_artifact(plan_b_json) {
        Ok(p) => p,
        Err(e) => return error_json(format!("plan B: {}", e)),
    };
    let d = core_diff(&a, &b);
    serde_json::to_string_pretty(&d).unwrap_or_else(|e| error_json(e.to_string()))
}

/// Validate: lint a manifest YAML, return the report as pretty JSON — identical
/// to `kcp-planner validate --json` (minus unit-path existence, which needs a
/// filesystem the browser doesn't have).
#[wasm_bindgen]
pub fn validate(manifest_yaml: &str) -> String {
    let today = today_utc();
    let manifest = match parse_manifest(manifest_yaml, Some(SOURCE)) {
        Ok(m) => m,
        Err(e) => {
            let report = ValidationReport {
                source: SOURCE.to_string(),
                project: None,
                findings: vec![Finding { level: "error".to_string(), where_: "manifest".to_string(), message: format!("does not parse: {}", e) }],
                ok: false,
            };
            return serde_json::to_string_pretty(&report).unwrap_or_else(|e| error_json(e.to_string()));
        }
    };
    // base_dir = None: everything except unit-path existence (no filesystem).
    let findings = validate_manifest(&manifest, None, &today);
    let ok = !findings.iter().any(|f| f.level == "error");
    let report = ValidationReport { source: SOURCE.to_string(), project: Some(manifest.project.clone()), findings, ok };
    serde_json::to_string_pretty(&report).unwrap_or_else(|e| error_json(e.to_string()))
}

/// Today (UTC) as YYYY-MM-DD, read from the JS `Date` — the one clock the linter
/// needs (for the expired-without-successor warning).
fn today_utc() -> String {
    let iso = js_sys::Date::new_0().to_iso_string();
    let s: String = iso.into();
    s.chars().take(10).collect()
}

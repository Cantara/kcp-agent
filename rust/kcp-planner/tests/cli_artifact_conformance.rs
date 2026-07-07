//! CLI artifact serialization — pins the parts the struct-level conformance
//! tests don't reach: the `trace --json` envelope (embedded plan must be the
//! *raw* plan, no sha256/signature) and the `diff` round-trip through a saved
//! plan artifact (whole-valued budget/context shifts must serialize as integers,
//! not `3000.0`). Both were real byte-parity bugs found against the TS CLI.

use std::path::PathBuf;

use kcp_planner::{diff_plans, parse_manifest, plan, plan_from_artifact, plan_to_json, trace, trace_to_json, verify_manifest_text, PlanOptions};

fn examples_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples")
}

fn load(dir: &str) -> (String, String) {
    let source = examples_dir().join(dir).join("knowledge.yaml");
    let text = std::fs::read_to_string(&source).unwrap_or_else(|e| panic!("read {}: {}", source.display(), e));
    (text, source.to_string_lossy().to_string())
}

#[test]
fn trace_json_embeds_the_raw_plan() {
    let (text, source) = load("fjordwire");
    let manifest = parse_manifest(&text, Some(&source)).expect("manifest");
    let opts = PlanOptions::default();
    let t = trace(&manifest, "authenticate device", &opts);
    let v = trace_to_json(&t, &manifest, &opts, &source);

    for key in ["task", "taskTerms", "asOf", "capabilities", "plan", "units", "gateSummary"] {
        assert!(v.get(key).is_some(), "trace json missing '{}'", key);
    }
    let plan = &v["plan"];
    // The embedded plan is the raw plan() output — the loading layer's sha256 and
    // signature are attached only on `plan --json`, never here.
    assert!(plan["manifest"].get("sha256").is_none(), "trace's embedded plan must not carry sha256");
    assert!(plan.get("signature").is_none(), "trace's embedded plan must not carry a signature");
    assert_eq!(plan["manifest"]["source"].as_str(), Some(source.as_str()));
}

#[test]
fn diff_round_trips_through_a_saved_artifact() {
    let (text, source) = load("fjordwire");
    let manifest = parse_manifest(&text, Some(&source)).expect("manifest");

    let base = PlanOptions::default();
    let constrained = PlanOptions { context_budget: Some(3000), max_units: Some(2), ..Default::default() };

    let pa = plan(&manifest, "authenticate device", &base);
    let pb = plan(&manifest, "authenticate device", &constrained);

    // Serialize both as saved artifacts, then read them back the way `diff` does.
    let sig = verify_manifest_text(&text, manifest.signing.as_ref(), Some(&source));
    let ja = plan_to_json(&pa, &manifest, &base, &source, "sha_a", &sig);
    let jb = plan_to_json(&pb, &manifest, &constrained, &source, "sha_b", &sig);
    let ra = plan_from_artifact(&serde_json::to_string(&ja).unwrap()).expect("read a");
    let rb = plan_from_artifact(&serde_json::to_string(&jb).unwrap()).expect("read b");

    // The diff of the round-tripped plans equals the diff of the originals.
    let direct = diff_plans(&pa, &pb);
    let via_artifact = diff_plans(&ra, &rb);
    assert_eq!(direct, via_artifact, "diff must survive the artifact round-trip");

    // A whole-valued context-budget shift serializes as an integer, never `3000.0`.
    let out = serde_json::to_string(&via_artifact).unwrap();
    assert!(out.contains("\"after\":3000") || out.contains("\"before\":3000"), "expected an integer context shift in {}", out);
    assert!(!out.contains("3000.0"), "budget/context shifts must not serialize as floats: {}", out);
}

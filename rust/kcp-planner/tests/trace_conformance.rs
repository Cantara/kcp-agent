//! Decision-trace conformance — the Rust `trace()` reproduces the TypeScript
//! reference's per-gate verdicts (detail strings and all) for every fixture,
//! generated from the shared vector manifests by scripts/gen-rust-fixtures.mjs.

use kcp_planner::{parse_manifest, trace, trace_outcome, PlanOptions, TraceOutcome};
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Deserialize)]
struct TraceFixture {
    name: String,
    manifest: String,
    task: String,
    #[serde(default)]
    options: PlanOptions,
    expect: TraceOutcome,
}

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/trace")
}

#[test]
fn all_trace_fixtures_pass() {
    let pattern = dir().join("*.json");
    let mut count = 0;
    let mut failures = Vec::new();
    for entry in glob::glob(pattern.to_str().unwrap()).expect("glob") {
        let path = entry.expect("entry");
        let fx: TraceFixture = serde_json::from_str(&std::fs::read_to_string(&path).unwrap())
            .unwrap_or_else(|e| panic!("parse {}: {}", path.display(), e));
        let manifest = parse_manifest(&fx.manifest, Some(&fx.name)).expect("manifest");
        let actual = trace_outcome(&trace(&manifest, &fx.task, &fx.options));
        if actual != fx.expect {
            failures.push(format!(
                "\n=== {} ===\n  expected: {}\n  actual:   {}",
                fx.name,
                serde_json::to_string(&fx.expect).unwrap(),
                serde_json::to_string(&actual).unwrap()
            ));
        }
        count += 1;
    }
    assert!(count >= 10, "expected >= 10 trace fixtures, found {}", count);
    assert!(failures.is_empty(), "{} trace fixture(s) failed:{}", failures.len(), failures.join(""));
}

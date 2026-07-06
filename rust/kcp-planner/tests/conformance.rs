//! Conformance harness — the proof. Load every `vectors/*.json` from the shared
//! corpus, run it through the Rust planner, and deep-equal the outcome against
//! `expect`. If every vector passes, this implementation is conformant with the
//! TypeScript reference — the spec is unambiguous.

use kcp_planner::{run_vector, ConformanceVector};
use std::path::PathBuf;

/// The repo-root `vectors/` dir, resolved from this crate's location.
fn vectors_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vectors")
}

fn load_vectors() -> Vec<(String, ConformanceVector)> {
    let pattern = vectors_dir().join("*.json");
    let mut out = Vec::new();
    for entry in glob::glob(pattern.to_str().unwrap()).expect("glob pattern") {
        let path = entry.expect("dir entry");
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
        let v: ConformanceVector =
            serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {}", path.display(), e));
        out.push((path.file_name().unwrap().to_string_lossy().to_string(), v));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[test]
fn corpus_is_non_trivial() {
    let vectors = load_vectors();
    assert!(vectors.len() >= 10, "expected >= 10 vectors, found {}", vectors.len());
}

#[test]
fn all_vectors_pass() {
    let vectors = load_vectors();
    let mut failures = Vec::new();
    for (file, v) in &vectors {
        let actual = run_vector(v);
        if actual != v.expect {
            failures.push(format!(
                "\n=== {} ({}) ===\n  expected: {}\n  actual:   {}",
                v.name,
                file,
                serde_json::to_string(&v.expect).unwrap(),
                serde_json::to_string(&actual).unwrap()
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} vectors failed:{}",
        failures.len(),
        vectors.len(),
        failures.join("")
    );
}

/// Every vector's `name` matches its filename — a stable, addressable corpus.
#[test]
fn vector_names_match_filenames() {
    for (file, v) in load_vectors() {
        assert_eq!(format!("{}.json", v.name), file);
    }
}

//! Signature-verification conformance — pins the offline ed25519 behavior against
//! the repo's example manifests so it can't silently regress (a fail-open in a
//! trust check is the worst kind of drift). The signed examples carry a local
//! `knowledge.yaml.sig` envelope; the planner must reproduce the same
//! `verified`/`unsigned`/`invalid` verdicts the TS reference does.

use std::path::PathBuf;

use kcp_planner::{parse_manifest, verify_manifest_text};

fn examples_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples")
}

fn load(dir: &str) -> (String, String) {
    let source = examples_dir().join(dir).join("knowledge.yaml");
    let text = std::fs::read_to_string(&source).unwrap_or_else(|e| panic!("read {}: {}", source.display(), e));
    (text, source.to_string_lossy().to_string())
}

#[test]
fn signed_examples_verify_offline() {
    for dir in ["sealed", "incident/fjellcert", "milky-way/hub", "summer/tourism"] {
        let (text, source) = load(dir);
        let manifest = parse_manifest(&text, Some(&source)).expect("parse");
        let sig = verify_manifest_text(&text, manifest.signing.as_ref(), Some(&source));
        assert_eq!(sig.status, "verified", "{} should verify, got {:?}", dir, sig);
        assert!(sig.key_id.is_some(), "{} should carry a key id", dir);
    }
}

#[test]
fn tampered_manifest_is_invalid() {
    let (text, source) = load("sealed");
    let manifest = parse_manifest(&text, Some(&source)).expect("parse");
    // Flip a byte the signature covers — verification must fail closed.
    let tampered = format!("{}\n# tampered\n", text.trim_end());
    let sig = verify_manifest_text(&tampered, manifest.signing.as_ref(), Some(&source));
    assert_eq!(sig.status, "invalid", "tampered manifest must be invalid, got {:?}", sig);
}

#[test]
fn unsigned_manifest_reports_unsigned() {
    let (text, source) = load("fjordwire");
    let manifest = parse_manifest(&text, Some(&source)).expect("parse");
    let sig = verify_manifest_text(&text, manifest.signing.as_ref(), Some(&source));
    assert_eq!(sig.status, "unsigned");
    assert_eq!(sig.detail, "manifest declares no signature");
    assert!(sig.key_id.is_none());
}

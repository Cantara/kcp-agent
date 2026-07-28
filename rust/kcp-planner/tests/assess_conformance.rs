//! Conformance harness for the confidence gate — `vectors/assess/*.json`.
//!
//! `assess()` adjudicates deterministically, but had no vectors, so this port could not
//! claim conformance on the confidence gate and it stayed a TypeScript feature rather than
//! part of the protocol. If every vector here passes, this implementation adjudicates
//! identically to the reference — including the wording of the verdict detail, which is
//! what a human reads in an audit.
//!
//! The evaluator is injected and non-deterministic in production, so a vector supplies its
//! *result* rather than a judge: `evaluator` for a fixed signal, `evaluatorError` for one
//! that fails. The vectors pin adjudication, never generation.
//!
//! These live in `vectors/assess/` because the planner harness globs `vectors/*.json`
//! non-recursively; a differently-shaped vector beside those would be loaded as a planner
//! vector and fail.

use kcp_planner::assess::{
    assess, Aggregate, AssessInput, ConfidenceSignal, ConfidenceVerdict, SignalSource,
};
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedSignal {
    source: String,
    score: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Expected {
    passed: bool,
    score: f64,
    threshold: f64,
    #[serde(default)]
    severity: Option<String>,
    signals: Vec<ExpectedSignal>,
    detail: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VectorOptions {
    threshold: f64,
    #[serde(default)]
    severity: Option<String>,
    #[serde(default)]
    aggregate: Option<String>,
    #[serde(default)]
    as_of: Option<String>,
    #[serde(default)]
    include_self_report: Option<bool>,
    #[serde(default)]
    self_report: Option<SignalLiteral>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SignalLiteral {
    #[serde(default)]
    source: Option<String>,
    score: f64,
    reasoning: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssessVector {
    name: String,
    gate: String,
    task: String,
    answer: String,
    options: VectorOptions,
    #[serde(default)]
    evaluator: Option<SignalLiteral>,
    #[serde(default)]
    evaluator_error: Option<String>,
    #[serde(default)]
    expect: Option<Expected>,
    #[serde(default)]
    expect_error: Option<String>,
}

fn assess_vectors_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vectors/assess")
}

fn load_vectors() -> Vec<(String, AssessVector)> {
    let pattern = assess_vectors_dir().join("*.json");
    let mut out = Vec::new();
    for entry in glob::glob(pattern.to_str().unwrap()).expect("glob pattern") {
        let path = entry.expect("dir entry");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
        let v: AssessVector = serde_json::from_str(&text)
            .unwrap_or_else(|e| panic!("parse {}: {}", path.display(), e));
        out.push((path.file_name().unwrap().to_string_lossy().to_string(), v));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn source_name(source: SignalSource) -> &'static str {
    match source {
        SignalSource::SelfReport => "self",
        SignalSource::Evaluator => "evaluator",
    }
}

fn signal_from(literal: &SignalLiteral, default_source: SignalSource) -> ConfidenceSignal {
    let source = match literal.source.as_deref() {
        Some("self") => SignalSource::SelfReport,
        Some("evaluator") => SignalSource::Evaluator,
        _ => default_source,
    };
    ConfidenceSignal { source, score: literal.score, reasoning: literal.reasoning.clone() }
}

/// A corpus that silently emptied would make every assertion below vacuous.
#[test]
fn corpus_is_non_trivial() {
    let vectors = load_vectors();
    assert!(
        vectors.len() >= 15,
        "expected the assess corpus, found {} vector(s)",
        vectors.len()
    );
    for (file, v) in &vectors {
        assert_eq!(v.gate, "confidence", "{file} declares its gate");
        // A vector whose name and filename disagree is findable by one and reported by the
        // other, which makes a failure harder to trace back than it needs to be.
        assert_eq!(
            format!("{}.json", v.name),
            *file,
            "vector name and filename disagree"
        );
    }
}

#[test]
fn every_assess_vector_conforms() {
    for (file, v) in load_vectors() {
        let options = kcp_planner::assess::AssessOptions {
            threshold: v.options.threshold,
            severity: v.options.severity.clone(),
            self_report: v
                .options
                .self_report
                .as_ref()
                .map(|s| signal_from(s, SignalSource::SelfReport)),
            include_self_report: v.options.include_self_report.unwrap_or(true),
            aggregate: match v.options.aggregate.as_deref() {
                Some("mean") => Aggregate::Mean,
                _ => Aggregate::Min,
            },
            as_of: v.options.as_of.clone(),
        };

        // Built here so the closure borrows a value that outlives the call.
        let evaluator_signal = v.evaluator.as_ref().map(|e| signal_from(e, SignalSource::Evaluator));
        let evaluator_error = v.evaluator_error.clone();

        let evaluator_fn = |_input: &AssessInput| -> Result<ConfidenceSignal, String> {
            if let Some(err) = &evaluator_error {
                return Err(err.clone());
            }
            Ok(evaluator_signal.clone().expect("vector supplies an evaluator signal"))
        };

        let evaluator: Option<&dyn kcp_planner::assess::ConfidenceEvaluator> =
            if v.evaluator.is_some() || v.evaluator_error.is_some() { Some(&evaluator_fn) } else { None };

        let result = assess(&v.task, &v.answer, &[], &options, evaluator);

        if let Some(want_err) = &v.expect_error {
            match result {
                Err(got) => assert_eq!(&got, want_err, "{file}: error message"),
                Ok(_) => panic!("{file}: expected an error, got a verdict"),
            }
            continue;
        }

        let got: ConfidenceVerdict = result.unwrap_or_else(|e| panic!("{file}: unexpected error {e}"));
        let want = v.expect.as_ref().unwrap_or_else(|| panic!("{file}: vector has neither expect nor expectError"));

        assert_eq!(got.gate, "confidence", "{file}: gate");
        assert_eq!(got.passed, want.passed, "{file}: passed");
        // The reference represents "no score obtainable" as 0; this port models it as
        // None. Same adjudication, different encoding of the same fact — so the comparison
        // maps None to 0 rather than pretending the shapes are identical.
        let got_score = got.score.unwrap_or(0.0);
        assert!(
            (got_score - want.score).abs() < 1e-9,
            "{file}: score {got_score} vs {}",
            want.score
        );
        assert!(
            (got.threshold - want.threshold).abs() < 1e-9,
            "{file}: threshold {} vs {}",
            got.threshold,
            want.threshold
        );
        assert_eq!(got.severity, want.severity, "{file}: severity");
        assert_eq!(got.detail, want.detail, "{file}: detail");

        assert_eq!(got.signals.len(), want.signals.len(), "{file}: signal count");
        for (i, (g, w)) in got.signals.iter().zip(want.signals.iter()).enumerate() {
            assert_eq!(source_name(g.source), w.source, "{file}: signal {i} source");
            assert!((g.score - w.score).abs() < 1e-9, "{file}: signal {i} score");
        }
    }
}

//! `assess()` conformance — hand-authored, translating `test/assess.test.ts`
//! 1:1. `assess()` is explicitly outside the gate cascade (no shared vector
//! corpus covers it — see the header comment in both the TS source and
//! `src/assess.rs`), so this is the only test coverage for the Rust port.

use kcp_planner::{
    assess, extract_self_report, Aggregate, AssessOptions, ConfidenceEvaluator, ConfidenceSignal, ConfidenceVerdict,
    GroundUnit, SignalSource,
};

fn unit(id: &str, content: &str) -> GroundUnit {
    GroundUnit { id: id.to_string(), sha256: format!("sha-{}", id), content: content.to_string() }
}

fn units() -> Vec<GroundUnit> {
    vec![unit("risk-policy", "Risk assessments require dual sign-off.")]
}

fn signal(source: SignalSource, score: f64, reasoning: &str) -> ConfidenceSignal {
    ConfidenceSignal { source, score, reasoning: reasoning.to_string() }
}

/// A fixed-score evaluator — the Rust equivalent of the TS tests'
/// `evaluatorOf(score, reasoning)` helper.
struct FixedEvaluator {
    score: f64,
    reasoning: &'static str,
}

impl ConfidenceEvaluator for FixedEvaluator {
    fn evaluate(&self, _input: &kcp_planner::AssessInput) -> Result<ConfidenceSignal, String> {
        Ok(signal(SignalSource::Evaluator, self.score, self.reasoning))
    }
}

fn evaluator_of(score: f64, reasoning: &'static str) -> FixedEvaluator {
    FixedEvaluator { score, reasoning }
}

/// The TS tests' `broken` evaluator — always fails.
struct BrokenEvaluator;
impl ConfidenceEvaluator for BrokenEvaluator {
    fn evaluate(&self, _input: &kcp_planner::AssessInput) -> Result<ConfidenceSignal, String> {
        Err("provider offline".to_string())
    }
}

fn assert_ok(r: Result<ConfidenceVerdict, String>) -> ConfidenceVerdict {
    r.unwrap_or_else(|e| panic!("assess() unexpectedly errored: {}", e))
}

#[test]
fn passes_when_the_adjudicated_score_clears_the_threshold() {
    let opts = AssessOptions {
        threshold: 0.7,
        self_report: Some(signal(SignalSource::SelfReport, 0.9, "clear-cut case")),
        ..Default::default()
    };
    let v = assert_ok(assess("draft risk assessment", "Low risk.", &units(), &opts, None));
    assert_eq!(v.gate, "confidence");
    assert!(v.passed);
    assert_eq!(v.score, Some(0.9));
    assert_eq!(v.threshold, 0.7);
    assert_eq!(v.signals.len(), 1);
    assert!(v.detail.contains("0.9"));
    assert!(v.detail.contains("0.7"));
}

#[test]
fn fails_with_a_written_specific_reason_when_below_threshold() {
    let opts = AssessOptions {
        threshold: 0.7,
        severity: Some("critical".to_string()),
        self_report: Some(signal(SignalSource::SelfReport, 0.55, "conflicting inputs")),
        ..Default::default()
    };
    let v = assert_ok(assess("draft risk assessment", "Unsure.", &units(), &opts, None));
    assert!(!v.passed);
    assert_eq!(v.score, Some(0.55));
    assert_eq!(v.severity.as_deref(), Some("critical"));
    assert!(v.detail.contains("0.55"));
    assert!(v.detail.contains("conflicting inputs"));
}

#[test]
fn aggregates_multiple_signals_with_min_by_default_fail_closed() {
    let opts = AssessOptions { threshold: 0.7, ..Default::default() };
    let ev = evaluator_of(0.6, "citations are thin");
    let v = assert_ok(assess("task", "Answer. Confidence: 0.9", &units(), &opts, Some(&ev)));
    assert_eq!(v.signals.len(), 2);
    assert_eq!(v.score, Some(0.6));
    assert!(!v.passed);
    assert!(v.detail.contains("citations are thin"));
}

#[test]
fn aggregate_mean_averages_the_signals() {
    let opts = AssessOptions { threshold: 0.7, aggregate: Aggregate::Mean, ..Default::default() };
    let ev = evaluator_of(0.6, "because");
    let v = assert_ok(assess("task", "Answer. Confidence: 0.9", &units(), &opts, Some(&ev)));
    assert!((v.score.unwrap() - 0.75).abs() < 1e-9);
    assert!(v.passed);
}

#[test]
fn no_obtainable_signal_fails_closed_with_a_specific_detail() {
    let opts = AssessOptions { threshold: 0.7, ..Default::default() };
    let v = assert_ok(assess("task", "An answer with no self-report.", &units(), &opts, None));
    assert!(!v.passed);
    assert_eq!(v.score, Some(0.0));
    assert_eq!(v.signals.len(), 0);
    assert!(v.detail.to_lowercase().contains("no confidence signal"));
}

#[test]
fn evaluator_failure_fails_closed_the_error_becomes_the_detail() {
    let opts = AssessOptions { threshold: 0.7, ..Default::default() };
    let broken = BrokenEvaluator;
    let v = assert_ok(assess("task", "Answer. Confidence: 0.95", &units(), &opts, Some(&broken)));
    assert!(!v.passed);
    assert!(v.detail.contains("provider offline"));
}

#[test]
fn evaluator_out_of_range_score_fails_closed() {
    let opts = AssessOptions { threshold: 0.7, ..Default::default() };
    let ev = evaluator_of(42.0, "not calibrated");
    let v = assert_ok(assess("task", "Answer.", &units(), &opts, Some(&ev)));
    assert!(!v.passed);
    let lower = v.detail.to_lowercase();
    assert!(lower.contains("out of range") || lower.contains("invalid"));
}

#[test]
fn raw_signals_are_preserved_verbatim_for_calibration() {
    let opts = AssessOptions { threshold: 0.5, ..Default::default() };
    let ev = evaluator_of(0.9, "well grounded");
    let v = assert_ok(assess("task", "Answer. Confidence: 80%", &units(), &opts, Some(&ev)));
    let mut sources: Vec<String> = v.signals.iter().map(|s| s.source.to_string()).collect();
    sources.sort();
    assert_eq!(sources, vec!["evaluator".to_string(), "self".to_string()]);
    for s in &v.signals {
        assert!(!s.reasoning.is_empty());
    }
}

#[test]
fn include_self_report_false_ignores_the_answers_self_report() {
    let opts = AssessOptions { threshold: 0.7, include_self_report: false, ..Default::default() };
    let ev = evaluator_of(0.9, "because");
    let v = assert_ok(assess("task", "Answer. Confidence: 0.2", &units(), &opts, Some(&ev)));
    assert_eq!(v.signals.len(), 1);
    assert_eq!(v.score, Some(0.9));
    assert!(v.passed);
}

#[test]
fn stamps_as_of_caller_provided_wins_for_reproducibility() {
    let opts = AssessOptions {
        threshold: 0.7,
        self_report: Some(signal(SignalSource::SelfReport, 0.8, "because")),
        as_of: Some("2026-07-20".to_string()),
        ..Default::default()
    };
    let v = assert_ok(assess("task", "Answer.", &units(), &opts, None));
    assert_eq!(v.as_of.as_deref(), Some("2026-07-20"));
}

#[test]
fn rejects_an_invalid_threshold_caller_error_not_a_verdict() {
    let opts = AssessOptions { threshold: 7.0, ..Default::default() };
    let err = assess("task", "Answer.", &units(), &opts, None).unwrap_err();
    assert!(err.to_lowercase().contains("threshold"));

    let opts2 = AssessOptions { threshold: -0.1, ..Default::default() };
    let err2 = assess("task", "Answer.", &units(), &opts2, None).unwrap_err();
    assert!(err2.to_lowercase().contains("threshold"));
}

mod extract_self_report_tests {
    use super::*;

    #[test]
    fn parses_a_decimal_confidence_line() {
        let s = extract_self_report("The risk is low.\n\nConfidence: 0.82").unwrap();
        assert!((s.score - 0.82).abs() < 1e-9);
        assert_eq!(s.source, SignalSource::SelfReport);
    }

    #[test]
    fn parses_a_percentage() {
        let s = extract_self_report("Confidence: 82%").unwrap();
        assert!((s.score - 0.82).abs() < 1e-9);
    }

    #[test]
    fn takes_the_last_report_when_several_appear() {
        let s = extract_self_report("Confidence: 0.9 early on.\nFinal confidence: 0.6").unwrap();
        assert!((s.score - 0.6).abs() < 1e-9);
    }

    #[test]
    fn returns_none_when_no_self_report_exists() {
        assert!(extract_self_report("Just an answer.").is_none());
    }

    #[test]
    fn clamps_runaway_percentages_into_range() {
        let s = extract_self_report("Confidence: 150%").unwrap();
        assert_eq!(s.score, 1.0);
    }
}

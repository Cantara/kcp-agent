//! Post-synthesis confidence gate — a Rust port of `src/assess.ts`.
//!
//! The planner decides what may be *loaded*; grounding (unported — no Rust
//! `ground.rs`/`synthesize.rs` equivalent outside the `network` feature yet)
//! decides what may be *asserted*; `assess()` decides whether a conclusion
//! clears the caller's confidence threshold before it is acted on. It runs
//! downstream of synthesis — confidence is a property of the *output* — which
//! is exactly why it is not, and never will be, gate #15 in the pre-selection
//! cascade: `plan()`/`trace()` are pure over manifest metadata, and nothing
//! generated exists when they run.
//!
//! Same trust posture as grounding: confidence is a *proposal* (a self-report
//! extracted from the answer, an injected evaluator's judgment, or both); the
//! gate *adjudicates* deterministically — threshold comparison and aggregation
//! are pure code, and anything unmeasurable fails closed.
//!
//! [`ConfidenceVerdict`] deliberately does not reuse or extend
//! [`crate::trace::GateVerdict`] — `assess()` is explicitly outside the gate
//! cascade (mirroring the TS source's own header comment), so it is never
//! inserted into [`crate::trace::DecisionTrace`] and the shared conformance
//! vectors are untouched.
//!
//! Synchronous by design: this crate has no async runtime outside the
//! `network` feature, and the WASM build (`default-features = false`) drops
//! `network` entirely — `assess()` must stay usable from WASM, so the
//! evaluator is a plain, synchronous closure/trait object, never `async`.
//! Self-report extraction is hand-rolled string scanning, not a `regex` crate
//! dependency — the same "minimal dependency tree" convention documented at
//! the top of `validate.rs`.
//!
//! The threshold is caller-supplied, not manifest data: "halt critical tasks
//! below 70%" is org policy, not knowledge provenance.

/// A loaded, hash-pinned unit — the minimal shape `assess()` needs from
/// grounding. Deliberately local and independent of `synthesize::LoadedUnit`
/// (which is `#[cfg(feature = "network")]`-gated and would drag tokio/reqwest
/// into the WASM build).
#[derive(Debug, Clone, PartialEq)]
pub struct GroundUnit {
    pub id: String,
    pub sha256: String,
    pub content: String,
}

/// Where a confidence measurement came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalSource {
    /// Extracted from (or supplied alongside) the synthesized answer itself.
    SelfReport,
    /// Judged by a separate, injected evaluator.
    Evaluator,
}

impl SignalSource {
    fn as_str(self) -> &'static str {
        match self {
            SignalSource::SelfReport => "self",
            SignalSource::Evaluator => "evaluator",
        }
    }
}

impl std::fmt::Display for SignalSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One confidence measurement — kept verbatim so orgs can calibrate over time.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfidenceSignal {
    pub source: SignalSource,
    /// 0..1.
    pub score: f64,
    /// Why — generated at gate time, never reconstructed from logs.
    pub reasoning: String,
}

/// The gate's verdict. Binary, with a written, specific reason — a separate,
/// downstream artifact from the pre-selection gates' `GateVerdict`, extended
/// with the evidence the decision was made from.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfidenceVerdict {
    pub gate: &'static str,
    pub passed: bool,
    pub threshold: f64,
    /// Adjudicated value (min of signals by default — fail-closed).
    pub score: Option<f64>,
    /// Raw inputs, preserved for calibration and audit.
    pub signals: Vec<ConfidenceSignal>,
    /// Written, specific reason matching the gates' detail contract.
    pub detail: String,
    /// Why this threshold applied (e.g. "critical"), when the caller says so.
    pub severity: Option<String>,
    pub as_of: Option<String>,
}

/// The inputs an evaluator judges: the task, the answer to evaluate, and the
/// units the answer was allowed to draw on.
pub struct AssessInput<'a> {
    pub task: &'a str,
    pub answer: &'a str,
    pub units: &'a [GroundUnit],
}

/// An injected judge — an LLM in production, deterministic in tests.
/// Synchronous: no async runtime is assumed to exist (WASM-safe).
pub trait ConfidenceEvaluator {
    fn evaluate(&self, input: &AssessInput) -> Result<ConfidenceSignal, String>;
}

/// Any matching closure is a `ConfidenceEvaluator` — callers don't need to
/// name a type for a one-off evaluator.
impl<F> ConfidenceEvaluator for F
where
    F: Fn(&AssessInput) -> Result<ConfidenceSignal, String>,
{
    fn evaluate(&self, input: &AssessInput) -> Result<ConfidenceSignal, String> {
        self(input)
    }
}

/// How multiple signals combine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Aggregate {
    /// Fail-closed: the lowest signal wins.
    #[default]
    Min,
    Mean,
}

#[derive(Debug, Clone)]
pub struct AssessOptions {
    /// Pass/fail line, 0..1. Org policy, supplied by the caller.
    pub threshold: f64,
    /// Recorded on the verdict (e.g. "critical") — why this threshold applied.
    pub severity: Option<String>,
    /// Explicit self-report from the synthesis layer (wins over extraction).
    pub self_report: Option<ConfidenceSignal>,
    /// Extract a self-report from the answer text (default true).
    pub include_self_report: bool,
    /// How multiple signals combine (default `Min` — fail-closed).
    pub aggregate: Aggregate,
    /// Verdict timestamp override, for reproducibility. This crate has no
    /// clock (see `planner::plan`'s `as_of` — "a real caller injects
    /// today"); when omitted, the same fixed epoch placeholder the planner
    /// uses (`"1970-01-01"`) is stamped instead of reading the system clock.
    pub as_of: Option<String>,
}

impl Default for AssessOptions {
    fn default() -> Self {
        AssessOptions {
            threshold: 0.0,
            severity: None,
            self_report: None,
            include_self_report: true,
            aggregate: Aggregate::Min,
            as_of: None,
        }
    }
}

const NO_CLOCK_AS_OF: &str = "1970-01-01";

fn in_range(n: f64) -> bool {
    !n.is_nan() && (0.0..=1.0).contains(&n)
}

/// Round away float noise without hiding calibration precision (mirrors TS
/// `Number(n.toFixed(6))`).
fn round6(n: f64) -> f64 {
    (n * 1_000_000.0).round() / 1_000_000.0
}

/// Pull the model's own certainty out of its answer: the last
/// "confidence: 0.82" / "confidence: 82%" style report wins. Hand-rolled
/// scan (no `regex` dependency) equivalent to
/// `/confidence[:\s]+([0-9]*\.?[0-9]+)\s*(%)?/gi`, last match wins.
pub fn extract_self_report(answer: &str) -> Option<ConfidenceSignal> {
    // ASCII-lowercase only: preserves byte offsets 1:1 with `answer` (unlike
    // a full Unicode `to_lowercase`, which can change byte length), so the
    // match position found here indexes directly into the original string.
    let lower = answer.to_ascii_lowercase();
    let hay = lower.as_bytes();
    let needle = b"confidence";

    let mut last: Option<(f64, usize)> = None; // (score, byte offset of "confidence")
    let mut i = 0usize;
    while i + needle.len() <= hay.len() {
        if &hay[i..i + needle.len()] == needle {
            let sep_start = i + needle.len();
            let mut j = sep_start;
            while j < hay.len() && (hay[j] == b':' || (hay[j] as char).is_whitespace()) {
                j += 1;
            }
            if j > sep_start {
                if let Some((num_text, mut k)) = scan_number(hay, j) {
                    while k < hay.len() && (hay[k] as char).is_whitespace() {
                        k += 1;
                    }
                    let is_percent = k < hay.len() && hay[k] == b'%';
                    if let Ok(mut score) = num_text.parse::<f64>() {
                        if is_percent || score > 1.0 {
                            score /= 100.0;
                        }
                        score = score.clamp(0.0, 1.0);
                        last = Some((score, i));
                    }
                }
            }
        }
        i += 1;
    }

    let (score, match_start) = last?;
    let orig = answer.as_bytes();
    let start = orig[..match_start].iter().rposition(|&b| b == b'\n').map(|p| p + 1).unwrap_or(0);
    let end = orig[match_start..].iter().position(|&b| b == b'\n').map(|p| match_start + p).unwrap_or(orig.len());
    let line = answer[start..end].trim().to_string();
    Some(ConfidenceSignal { source: SignalSource::SelfReport, score, reasoning: format!("self-reported: \"{}\"", line) })
}

/// Scan `[0-9]*\.?[0-9]+` starting at `start`. Returns the matched text and
/// the byte offset just past it, or `None` if no digit is present at all.
fn scan_number(hay: &[u8], start: usize) -> Option<(String, usize)> {
    let mut lead_end = start;
    while lead_end < hay.len() && hay[lead_end].is_ascii_digit() {
        lead_end += 1;
    }
    let has_leading_digits = lead_end > start;

    let mut end = lead_end;
    if lead_end < hay.len() && hay[lead_end] == b'.' {
        let frac_start = lead_end + 1;
        let mut frac_end = frac_start;
        while frac_end < hay.len() && hay[frac_end].is_ascii_digit() {
            frac_end += 1;
        }
        if frac_end > frac_start {
            // Dot + at least one fractional digit — consume it.
            end = frac_end;
        } else if !has_leading_digits {
            // Dot with nothing usable on either side: no match.
            return None;
        }
        // Otherwise: leave the dot unconsumed, `end` stays at `lead_end`,
        // and the leading digits alone satisfy the trailing `[0-9]+`.
    } else if !has_leading_digits {
        return None;
    }

    let text = std::str::from_utf8(&hay[start..end]).ok()?.to_string();
    Some((text, end))
}

fn make_verdict(
    threshold: f64,
    severity: Option<String>,
    as_of: String,
    passed: bool,
    score: f64,
    signals: Vec<ConfidenceSignal>,
    detail: String,
) -> ConfidenceVerdict {
    ConfidenceVerdict { gate: "confidence", passed, threshold, score: Some(score), signals, detail, severity, as_of: Some(as_of) }
}

/// The gate. Gathers signals (self-report and/or evaluator), adjudicates
/// against the threshold, and returns a binary verdict with a written reason.
/// Fail-closed: no obtainable signal, an evaluator error, or an out-of-range
/// score all fail with a specific detail.
///
/// `Err` only for a caller error (an invalid threshold) — never for a
/// measurement failure, which is instead a `passed: false` verdict.
pub fn assess(
    task: &str,
    answer: &str,
    units: &[GroundUnit],
    options: &AssessOptions,
    evaluator: Option<&dyn ConfidenceEvaluator>,
) -> Result<ConfidenceVerdict, String> {
    if !in_range(options.threshold) {
        return Err(format!("invalid threshold {} — expected 0..1", options.threshold));
    }
    let as_of = options.as_of.clone().unwrap_or_else(|| NO_CLOCK_AS_OF.to_string());
    let severity = options.severity.clone();

    let mut signals: Vec<ConfidenceSignal> = Vec::new();

    let self_signal = if let Some(s) = &options.self_report {
        Some(s.clone())
    } else if options.include_self_report {
        extract_self_report(answer)
    } else {
        None
    };
    if let Some(self_sig) = self_signal {
        if !in_range(self_sig.score) {
            let detail = format!("self-report score {} out of range — fail-closed", self_sig.score);
            return Ok(make_verdict(options.threshold, severity, as_of, false, 0.0, vec![self_sig], detail));
        }
        signals.push(self_sig);
    }

    if let Some(ev) = evaluator {
        let input = AssessInput { task, answer, units };
        match ev.evaluate(&input) {
            Err(msg) => {
                let detail = format!("evaluator failed: {} — fail-closed", msg);
                return Ok(make_verdict(options.threshold, severity, as_of, false, 0.0, signals, detail));
            }
            Ok(judged) => {
                if !in_range(judged.score) {
                    let detail = format!("evaluator score {} out of range — fail-closed", judged.score);
                    signals.push(judged);
                    return Ok(make_verdict(options.threshold, severity, as_of, false, 0.0, signals, detail));
                }
                signals.push(judged);
            }
        }
    }

    if signals.is_empty() {
        let detail = "no confidence signal obtainable (no self-report in answer, no evaluator) — fail-closed".to_string();
        return Ok(make_verdict(options.threshold, severity, as_of, false, 0.0, signals, detail));
    }

    let score = match options.aggregate {
        Aggregate::Mean => signals.iter().map(|s| s.score).sum::<f64>() / signals.len() as f64,
        Aggregate::Min => {
            let mut m = signals[0].score;
            for s in &signals[1..] {
                if s.score < m {
                    m = s.score;
                }
            }
            m
        }
    };
    let passed = score >= options.threshold;

    let mut lowest = &signals[0];
    for s in &signals[1..] {
        if s.score < lowest.score {
            lowest = s;
        }
    }
    let agg = match options.aggregate {
        Aggregate::Mean => "mean",
        Aggregate::Min => "min",
    };
    let rounded = round6(score);
    let detail = if passed {
        format!(
            "confidence {} >= threshold {} ({} of {} signal{})",
            crate::planner::fmt_num(rounded),
            crate::planner::fmt_num(options.threshold),
            agg,
            signals.len(),
            if signals.len() == 1 { "" } else { "s" }
        )
    } else {
        format!(
            "confidence {} < threshold {}{} — {}: {}",
            crate::planner::fmt_num(rounded),
            crate::planner::fmt_num(options.threshold),
            severity.as_ref().map(|s| format!(" on {} task", s)).unwrap_or_default(),
            lowest.source,
            lowest.reasoning
        )
    };

    Ok(make_verdict(options.threshold, severity, as_of, passed, rounded, signals, detail))
}

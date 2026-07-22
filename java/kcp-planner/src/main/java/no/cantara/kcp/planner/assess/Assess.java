package no.cantara.kcp.planner.assess;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Post-synthesis confidence gate — gating what may be <em>acted on</em>.
 *
 * <p>The planner decides what may be <em>loaded</em>; grounding decides what may
 * be <em>asserted</em>; this gate decides whether a conclusion clears the
 * caller's confidence threshold before it is acted on. It runs downstream of
 * synthesis — confidence is a property of the output, which is exactly why it
 * structurally cannot be a gate in the pre-selection cascade: {@code plan()} is
 * pure and synchronous over manifest metadata, and nothing generated exists when
 * it runs.</p>
 *
 * <p>Same trust posture as grounding: confidence is a <em>proposal</em> (the
 * model's own self-report, an injected evaluator's judgment, or both); the gate
 * <em>adjudicates</em> deterministically — threshold comparison and aggregation
 * are pure code, and anything unmeasurable fails closed.</p>
 *
 * <p>The threshold is caller-supplied, not manifest data: "halt critical tasks
 * below 70%" is org policy, not knowledge provenance.</p>
 *
 * <p>A faithful port of {@code assess()} in {@code src/assess.ts}. The reference
 * evaluator is {@code Promise}-returning (it calls an LLM); this port has no
 * async LLM plumbing, so {@link ConfidenceEvaluator} is a plain synchronous
 * functional interface and {@link #assess} itself is synchronous — no reactive
 * infrastructure was introduced to support this.</p>
 */
public final class Assess {

    private Assess() {
    }

    private static final Pattern SELF_REPORT =
            Pattern.compile("confidence[:\\s]+([0-9]*\\.?[0-9]+)\\s*(%)?", Pattern.CASE_INSENSITIVE);

    /**
     * Pull the model's own certainty out of its answer: the last
     * "confidence: 0.82" / "confidence: 82%" style report wins.
     *
     * @param answer the synthesized answer text to scan
     * @return the last self-report found, or {@code null} if none appears
     */
    public static ConfidenceSignal extractSelfReport(String answer) {
        Matcher m = SELF_REPORT.matcher(answer);
        Double lastScore = null;
        String lastLine = null;
        while (m.find()) {
            double score;
            try {
                score = Double.parseDouble(m.group(1));
            } catch (NumberFormatException e) {
                continue;
            }
            if ("%".equals(m.group(2)) || score > 1) {
                score = score / 100;
            }
            score = Math.min(1, Math.max(0, score));
            int start = answer.lastIndexOf('\n', m.start()) + 1;
            int end = answer.indexOf('\n', m.start());
            lastLine = answer.substring(start, end == -1 ? answer.length() : end).trim();
            lastScore = score;
        }
        if (lastScore == null) {
            return null;
        }
        return new ConfidenceSignal(ConfidenceSignal.SELF, lastScore, "self-reported: \"" + lastLine + "\"");
    }

    /**
     * The gate. Gathers signals (self-report and/or evaluator), adjudicates
     * against the threshold, and returns a binary verdict with a written reason.
     * Fail-closed: no obtainable signal, an evaluator error, or an out-of-range
     * score all fail with a specific detail.
     *
     * @param task    the task the answer addresses
     * @param answer  the synthesized answer to gate
     * @param units   the units the answer was allowed to draw on (handed to the
     *                evaluator, if one is wired in)
     * @param options the threshold and signal sources
     * @return the confidence verdict
     * @throws IllegalArgumentException if {@code options.threshold()} is not in {@code 0..1}
     */
    public static ConfidenceVerdict assess(String task, String answer, List<GroundUnit> units, AssessOptions options) {
        if (!inRange(options.threshold())) {
            throw new IllegalArgumentException("invalid threshold " + fmtNum(options.threshold()) + " — expected 0..1");
        }
        String asOf = options.asOf() != null ? options.asOf() : todayUtc();

        List<ConfidenceSignal> signals = new ArrayList<>();

        ConfidenceSignal self = options.selfReport() != null
                ? options.selfReport()
                : (Boolean.FALSE.equals(options.includeSelfReport()) ? null : extractSelfReport(answer));
        if (self != null) {
            if (!inRange(self.score())) {
                return fail(options, asOf, List.of(self),
                        "self-report score " + fmtNum(self.score()) + " out of range — fail-closed");
            }
            signals.add(self);
        }

        if (options.evaluator() != null) {
            ConfidenceSignal judged;
            try {
                judged = options.evaluator().evaluate(task, answer, units);
            } catch (Exception e) {
                String msg = e.getMessage() != null ? e.getMessage() : String.valueOf(e);
                return fail(options, asOf, List.copyOf(signals), "evaluator failed: " + msg + " — fail-closed");
            }
            if (judged == null || !inRange(judged.score())) {
                List<ConfidenceSignal> withJudged = new ArrayList<>(signals);
                if (judged != null) {
                    withJudged.add(judged);
                }
                String badScore = judged != null ? fmtNum(judged.score()) : "null";
                return fail(options, asOf, withJudged, "evaluator score " + badScore + " out of range — fail-closed");
            }
            signals.add(judged);
        }

        if (signals.isEmpty()) {
            return fail(options, asOf, List.of(),
                    "no confidence signal obtainable (no self-report in answer, no evaluator) — fail-closed");
        }

        boolean mean = "mean".equals(options.aggregate());
        double score = mean
                ? signals.stream().mapToDouble(ConfidenceSignal::score).average().orElse(0)
                : signals.stream().mapToDouble(ConfidenceSignal::score).min().orElse(0);
        double rounded = round(score);

        // Pass/fail is decided on the raw (unrounded) score, matching the reference —
        // rounding is display-only and never itself flips a boundary verdict.
        boolean passed = score >= options.threshold();

        ConfidenceSignal lowest = signals.get(0);
        for (ConfidenceSignal s : signals) {
            if (s.score() < lowest.score()) {
                lowest = s;
            }
        }
        String agg = mean ? "mean" : "min";
        String detail = passed
                ? "confidence " + fmtNum(rounded) + " >= threshold " + fmtNum(options.threshold())
                        + " (" + agg + " of " + signals.size() + " signal" + (signals.size() == 1 ? "" : "s") + ")"
                : "confidence " + fmtNum(rounded) + " < threshold " + fmtNum(options.threshold())
                        + (options.severity() != null ? " on " + options.severity() + " task" : "")
                        + " — " + lowest.source() + ": " + lowest.reasoning();

        return new ConfidenceVerdict("confidence", passed, options.threshold(), rounded,
                List.copyOf(signals), detail, options.severity(), asOf);
    }

    private static ConfidenceVerdict fail(AssessOptions options, String asOf, List<ConfidenceSignal> signals, String detail) {
        return new ConfidenceVerdict("confidence", false, options.threshold(), 0,
                List.copyOf(signals), detail, options.severity(), asOf);
    }

    private static boolean inRange(double n) {
        return !Double.isNaN(n) && n >= 0 && n <= 1;
    }

    /** Round away float noise, matching JS {@code Number(n.toFixed(6))}. */
    private static double round(double n) {
        return BigDecimal.valueOf(n).setScale(6, RoundingMode.HALF_UP).doubleValue();
    }

    /**
     * Format a double the way JS template-literal interpolation does: shortest
     * round-trip, no trailing zeros. Normalizes negative zero to "0".
     */
    private static String fmtNum(double n) {
        BigDecimal bd = BigDecimal.valueOf(n);
        if (bd.compareTo(BigDecimal.ZERO) == 0) {
            return "0";
        }
        return bd.stripTrailingZeros().toPlainString();
    }

    /** UTC "today" as {@code YYYY-MM-DD}, without relying on locale. */
    private static String todayUtc() {
        return LocalDate.now(ZoneOffset.UTC).toString();
    }
}

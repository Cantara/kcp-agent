package no.cantara.kcp.planner.assess;

/**
 * The knobs a caller supplies to {@link Assess#assess}. Mirrors
 * {@code AssessOptions} in {@code src/assess.ts}. Unlike {@code PlanOptions}
 * (every field optional, sensible defaults), {@code threshold} is mandatory — it
 * is org policy the caller must state, not knowledge provenance the manifest
 * can default. Build with {@link #builder(double)}, which takes the threshold up
 * front:
 *
 * <pre>{@code
 * AssessOptions opts = AssessOptions.builder(0.7)
 *     .severity("critical")
 *     .evaluator(myEvaluator)
 *     .aggregate("mean")
 *     .build();
 * }</pre>
 */
public final class AssessOptions {

    private final double threshold;
    private final String severity;
    private final ConfidenceSignal selfReport;
    private final Boolean includeSelfReport;
    private final ConfidenceEvaluator evaluator;
    private final String aggregate;
    private final String asOf;

    private AssessOptions(Builder b) {
        this.threshold = b.threshold;
        this.severity = b.severity;
        this.selfReport = b.selfReport;
        this.includeSelfReport = b.includeSelfReport;
        this.evaluator = b.evaluator;
        this.aggregate = b.aggregate;
        this.asOf = b.asOf;
    }

    /** Pass/fail line, 0..1. Org policy, supplied by the caller. */
    public double threshold() {
        return threshold;
    }

    /** Recorded on the verdict (e.g. {@code "critical"}) — why this threshold applied, or {@code null}. */
    public String severity() {
        return severity;
    }

    /** Explicit self-report from the synthesis layer (wins over extraction), or {@code null}. */
    public ConfidenceSignal selfReport() {
        return selfReport;
    }

    /** Whether to extract a self-report from the answer text; {@code null} means "yes" (the default). */
    public Boolean includeSelfReport() {
        return includeSelfReport;
    }

    /** A separate judge of the answer, or {@code null} if none is wired in. */
    public ConfidenceEvaluator evaluator() {
        return evaluator;
    }

    /** How multiple signals combine — {@code "min"} (fail-closed, the default) or {@code "mean"}. */
    public String aggregate() {
        return aggregate;
    }

    /** Verdict timestamp override, for reproducibility, or {@code null} for "today". */
    public String asOf() {
        return asOf;
    }

    /** Start building options with the mandatory pass/fail threshold. */
    public static Builder builder(double threshold) {
        return new Builder(threshold);
    }

    /** A fluent builder for {@link AssessOptions}. */
    public static final class Builder {
        private final double threshold;
        private String severity;
        private ConfidenceSignal selfReport;
        private Boolean includeSelfReport;
        private ConfidenceEvaluator evaluator;
        private String aggregate;
        private String asOf;

        private Builder(double threshold) {
            this.threshold = threshold;
        }

        /** Record why this threshold applied (e.g. {@code "critical"}). */
        public Builder severity(String severity) {
            this.severity = severity;
            return this;
        }

        /** Supply an explicit self-report, bypassing extraction from the answer text. */
        public Builder selfReport(ConfidenceSignal selfReport) {
            this.selfReport = selfReport;
            return this;
        }

        /** Set whether to extract a self-report from the answer text (default true). */
        public Builder includeSelfReport(boolean includeSelfReport) {
            this.includeSelfReport = includeSelfReport;
            return this;
        }

        /** Wire in a separate judge of the answer. */
        public Builder evaluator(ConfidenceEvaluator evaluator) {
            this.evaluator = evaluator;
            return this;
        }

        /** Set how multiple signals combine ({@code "min"} or {@code "mean"}). */
        public Builder aggregate(String aggregate) {
            this.aggregate = aggregate;
            return this;
        }

        /** Override the verdict timestamp, for reproducibility. */
        public Builder asOf(String asOf) {
            this.asOf = asOf;
            return this;
        }

        /** Build the immutable options. */
        public AssessOptions build() {
            return new AssessOptions(this);
        }
    }
}

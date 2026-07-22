package no.cantara.kcp.planner.assess;

/**
 * One confidence measurement — kept verbatim so orgs can calibrate over time.
 * Mirrors {@code ConfidenceSignal} in {@code src/assess.ts}.
 *
 * @param source    {@code "self"} (extracted or supplied self-report) or
 *                  {@code "evaluator"} (an injected judge)
 * @param score     the signal's confidence, 0..1
 * @param reasoning why — generated at gate time, never reconstructed from logs
 */
public record ConfidenceSignal(String source, double score, String reasoning) {

    /** The {@link #source} value for a self-reported signal. */
    public static final String SELF = "self";

    /** The {@link #source} value for an injected evaluator's judgment. */
    public static final String EVALUATOR = "evaluator";
}

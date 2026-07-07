package no.cantara.kcp.planner.trace;

import java.util.List;

/**
 * The per-unit trace: every gate the unit was evaluated against, in order.
 * Mirrors {@code UnitTrace} in {@code src/trace.ts}. For a skipped unit the gate
 * list stops after the first rejection; {@code rejectedBy} names that gate.
 *
 * @param id         the unit id
 * @param path       the unit content path
 * @param intent     the unit intent
 * @param outcome    {@code "selected"} or {@code "skipped"} (per the canonical plan)
 * @param gates      the gate verdicts in evaluation order
 * @param rejectedBy the gate that rejected the unit, or {@code null} for selected units
 * @param score      the relevance score when the unit passed relevance, else {@code null}
 * @param tokens     token-cost attribution for selected units, else {@code null}
 * @param cost       money-cost attribution for pay-per-request selected units, else {@code null}
 */
public record UnitTrace(
        String id,
        String path,
        String intent,
        String outcome,
        List<GateVerdict> gates,
        GateName rejectedBy,
        Integer score,
        Tokens tokens,
        Cost cost) {

    /**
     * Token-cost attribution.
     *
     * @param value  the token count, or {@code null} when unmeasured
     * @param source {@code "declared"}, {@code "estimated"} (from bytes), or {@code "unmeasured"}
     */
    public record Tokens(Long value, String source) {
    }

    /**
     * Money-cost attribution for a pay-per-request unit.
     *
     * @param amount   the per-request price
     * @param currency the settlement currency, or {@code null}
     * @param method   the payment method
     */
    public record Cost(Double amount, String currency, String method) {
    }
}

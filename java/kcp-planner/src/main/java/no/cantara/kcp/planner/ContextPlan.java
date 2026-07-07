package no.cantara.kcp.planner;

/**
 * The context-window projection for a plan: how many tokens the selected units
 * are expected to consume against the ceiling. Token values are integers. Mirrors
 * {@code ContextPlan} in {@code src/planner.ts}.
 *
 * @param ceiling         the token ceiling, or {@code null} when unset
 * @param projectedTokens the sum of the selected units' token cost, or {@code null} when unset
 * @param remaining       the remaining tokens after the projection, or {@code null} when unset
 * @param approximate     whether any selected unit's size was estimated from bytes
 * @param unmeasured      the count of selected units with no declared size
 * @param note            a human-readable summary of the projection
 */
public record ContextPlan(
        Long ceiling,
        Long projectedTokens,
        Long remaining,
        boolean approximate,
        int unmeasured,
        String note) {
}

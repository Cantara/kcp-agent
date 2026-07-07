package no.cantara.kcp.planner.diff;

/**
 * A numeric shift in a budget or context projection between two plans (e.g.
 * {@code budget.remaining} or {@code context.projectedTokens}). Mirrors
 * {@code BudgetShift} in {@code src/diff.ts}. An endpoint is {@code null} when the
 * corresponding projection was absent on that side.
 *
 * @param field  the dotted field name (e.g. {@code "budget.projectedSpend"})
 * @param before the value in plan A, or {@code null}
 * @param after  the value in plan B, or {@code null}
 */
public record BudgetShift(String field, Double before, Double after) {
}

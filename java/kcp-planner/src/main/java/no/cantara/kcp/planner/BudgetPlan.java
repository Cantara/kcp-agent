package no.cantara.kcp.planner;

import java.math.BigDecimal;
import java.util.List;

import no.cantara.kcp.planner.model.RequestCount;

/**
 * The economic projection for a plan: the resolved rate tier and, when the caller
 * set a spend ceiling, the greedy spend arithmetic. Monetary values are
 * {@link BigDecimal} for exact currency arithmetic. Mirrors {@code BudgetPlan} in
 * {@code src/planner.ts}.
 *
 * @param rateTier          the resolved rate tier ({@code default}/{@code authenticated}/{@code premium})
 * @param requestsPerMinute the per-minute ceiling at that tier, or {@code null}
 * @param perRequestCosts   the per-request costs of the selected pay-per-request units
 * @param ceiling           the spend ceiling, or {@code null} when unset
 * @param currency          the settlement currency, or {@code null} when unset
 * @param alreadyCommitted  spend committed upstream in a federated walk, or {@code null} when zero
 * @param projectedSpend    the total per-request cost of the selected units, or {@code null} when unset
 * @param remaining         the remaining budget after projected spend, or {@code null} when unset
 * @param note              a human-readable summary of the projection
 */
public record BudgetPlan(
        String rateTier,
        RequestCount requestsPerMinute,
        List<PerRequestCost> perRequestCosts,
        BigDecimal ceiling,
        String currency,
        BigDecimal alreadyCommitted,
        BigDecimal projectedSpend,
        BigDecimal remaining,
        String note) {

    /** A single unit's per-request cost line. */
    public record PerRequestCost(String unit, String cost) {
    }
}

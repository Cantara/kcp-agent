package no.cantara.kcp.planner;

import java.math.BigDecimal;

/**
 * The payment decision for one unit: the chosen method and whether the agent can
 * afford it. Mirrors {@code PaymentPlan} in {@code src/planner.ts}.
 *
 * @param method          the chosen method type, {@code "free"}, or {@code "needs …"}
 * @param cost            a human-readable cost string (e.g. {@code "0.002 USDC/request"}), or {@code null}
 * @param pricePerRequest the numeric per-request cost for budget arithmetic, or {@code null}
 * @param currency        the settlement currency, or {@code null}
 * @param affordable      whether the agent can settle this method
 */
public record PaymentPlan(
        String method,
        String cost,
        BigDecimal pricePerRequest,
        String currency,
        boolean affordable) {
}

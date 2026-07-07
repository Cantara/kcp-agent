package no.cantara.kcp.planner;

import java.util.List;

/**
 * A unit the planner selected, with its relevance score and the reasons behind
 * every decision. Mirrors {@code PlannedUnit} in {@code src/planner.ts}.
 *
 * @param id                  the unit id
 * @param path                the unit content path
 * @param intent              the unit intent
 * @param score               the relevance score
 * @param reasons             the per-signal scoring and gating reasons, in order
 * @param payment             the payment decision
 * @param requiresAttestation whether this unit requires attestation
 * @param loadEligible        whether the unit can actually be loaded (vs listed but gated)
 */
public record PlannedUnit(
        String id,
        String path,
        String intent,
        int score,
        List<String> reasons,
        PaymentPlan payment,
        boolean requiresAttestation,
        boolean loadEligible) {
}

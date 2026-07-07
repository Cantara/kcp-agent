package no.cantara.kcp.planner.model;

import java.util.List;

/**
 * A payment block, declared at the manifest root or on an individual unit.
 * Mirrors {@code Payment} in {@code src/model.ts}.
 *
 * @param defaultTier     the tier applied when the agent declares none
 * @param methods         the payment methods offered, in declaration order
 * @param billingContact  a contact for billing questions
 */
public record Payment(
        String defaultTier,
        List<PaymentMethod> methods,
        String billingContact) {
}

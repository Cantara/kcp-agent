package no.cantara.kcp.planner.model;

import java.util.List;

/**
 * One declared way to pay for a unit or manifest (e.g. {@code free}, {@code x402},
 * {@code meter}, {@code subscription}). Mirrors {@code PaymentMethod} in
 * {@code src/model.ts}; every field is present so the model round-trips faithfully.
 *
 * @param type              method type: {@code free | x402 | meter | subscription}
 * @param currency          settlement currency, e.g. {@code USDC}
 * @param pricePerRequest   per-request price, kept as the declared string (the YAML
 *                          quotes it) and parsed to a number only during planning
 * @param networks          settlement networks the method supports
 * @param wallet            receiving wallet address
 * @param provider          payment provider
 * @param plansUrl          URL describing available plans
 * @param freeTier          whether a free tier exists
 * @param freeRequestsPerDay free-tier daily request allowance
 * @param upgradeUrl        URL to upgrade to a paid tier
 */
public record PaymentMethod(
        String type,
        String currency,
        String pricePerRequest,
        List<String> networks,
        String wallet,
        String provider,
        String plansUrl,
        Boolean freeTier,
        Long freeRequestsPerDay,
        String upgradeUrl) {
}

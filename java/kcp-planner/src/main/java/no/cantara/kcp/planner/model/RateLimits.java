package no.cantara.kcp.planner.model;

/**
 * The rate-limit tiers a manifest offers. The planner resolves which tier the
 * agent falls into (premium, authenticated, or default) when projecting budget.
 * Mirrors {@code RateLimits} in {@code src/model.ts}.
 *
 * @param defaultTier    the anonymous/default tier ({@code default} in YAML)
 * @param authenticated  the tier for credentialed agents
 * @param premium        the tier for subscription-paying agents
 * @param backoff        the recommended backoff strategy
 */
public record RateLimits(
        RateLimitTier defaultTier,
        RateLimitTier authenticated,
        RateLimitTier premium,
        String backoff) {
}

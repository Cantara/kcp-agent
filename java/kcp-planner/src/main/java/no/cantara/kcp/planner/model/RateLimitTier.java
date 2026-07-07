package no.cantara.kcp.planner.model;

/**
 * The request ceilings for one rate-limit tier. Each ceiling is a
 * {@link RequestCount} (a number or {@code "unlimited"}), or {@code null} when the
 * manifest declares none. Mirrors {@code RateLimitTier} in {@code src/model.ts}.
 *
 * @param requestsPerMinute per-minute ceiling
 * @param requestsPerHour   per-hour ceiling
 * @param requestsPerDay    per-day ceiling
 */
public record RateLimitTier(
        RequestCount requestsPerMinute,
        RequestCount requestsPerHour,
        RequestCount requestsPerDay) {
}

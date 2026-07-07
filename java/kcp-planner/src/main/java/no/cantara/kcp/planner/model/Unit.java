package no.cantara.kcp.planner.model;

import java.util.List;

/**
 * A single knowledge unit — the atom the planner selects or skips. Mirrors
 * {@code Unit} in {@code src/model.ts}. Collection fields ({@code audience},
 * {@code triggers}, {@code notFor}) are never {@code null}; the parser normalizes
 * a missing list to an empty one, matching the TypeScript reference.
 *
 * @param id          stable unit identifier
 * @param path        content path relative to the manifest
 * @param intent      one-line statement of what the unit is for (scored for relevance)
 * @param scope       optional scoping note
 * @param audience    roles this unit targets; empty means "any role"
 * @param triggers    task keywords that should surface this unit (scored for relevance)
 * @param access      access axis: {@code public | authenticated | restricted}
 * @param authScope   the auth scope required, when access is gated
 * @param deprecated  whether the unit is deprecated (skipped outright)
 * @param notFor      negative-space phrases: tasks the unit explicitly does not serve
 * @param payment     unit-level payment block (overrides the manifest default)
 * @param rateLimits  unit-level rate limits
 * @param temporal    validity window and supersession pointer
 * @param sizeTokens  declared token cost — the faithful input for context budgeting
 * @param bytes       declared byte size — the estimate source when {@code sizeTokens} is absent
 */
public record Unit(
        String id,
        String path,
        String intent,
        String scope,
        List<String> audience,
        List<String> triggers,
        String access,
        String authScope,
        Boolean deprecated,
        List<String> notFor,
        Payment payment,
        RateLimits rateLimits,
        Temporal temporal,
        Long sizeTokens,
        Long bytes) {
}

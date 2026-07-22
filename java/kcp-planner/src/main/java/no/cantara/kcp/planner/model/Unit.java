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
 * @param temporal     validity window and supersession pointer
 * @param kind         unit classification — e.g. {@code "skill"} for a procedure governed
 *                     as an invoke-eligible unit (#100)
 * @param actionScope  declared action scope for a governed procedure/skill — the tools,
 *                     paths, and capabilities it is permitted to touch when invoked (#100)
 * @param loadEligible explicit eligibility grant for a skill; skills fail closed by default,
 *                     only a unit with {@code load_eligible: true} is load/invoke-eligible (#100)
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
        String kind,
        ActionScope actionScope,
        Boolean loadEligible,
        Long sizeTokens,
        Long bytes) {

    /**
     * Declared action scope for a governed procedure/skill (#100). Mirrors the
     * {@code action_scope} object in {@code src/model.ts}.
     *
     * @param tools        tool names the skill may invoke
     * @param paths        path globs the skill may touch
     * @param capabilities capability tags the skill declares
     * @param spend        optional spend limits for the skill
     */
    public record ActionScope(
            List<String> tools,
            List<String> paths,
            List<String> capabilities,
            Spend spend) {

        /**
         * Spend limits declared under a skill's action scope.
         *
         * @param maxSpend       the maximum spend the skill may authorize
         * @param allowedVendors vendors the skill may spend with
         * @param currency       the settlement currency
         */
        public record Spend(
                Long maxSpend,
                List<String> allowedVendors,
                String currency) {
        }
    }
}

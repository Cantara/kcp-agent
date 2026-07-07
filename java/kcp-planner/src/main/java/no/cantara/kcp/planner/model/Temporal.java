package no.cantara.kcp.planner.model;

/**
 * A unit's validity window and supersession pointer. Dates are ISO {@code YYYY-MM-DD}
 * strings compared lexicographically (which is chronological for that format).
 * Mirrors {@code Temporal} in {@code src/model.ts}.
 *
 * @param validFrom     inclusive start of the validity window
 * @param validUntil    inclusive end of the validity window
 * @param supersededBy  id of the unit that replaces this one
 */
public record Temporal(
        String validFrom,
        String validUntil,
        String supersededBy) {
}

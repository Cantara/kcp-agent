package no.cantara.kcp.planner.diff;

/**
 * A unit present in one plan but not the other (e.g. a manifest edit added or
 * removed it). Mirrors {@code UnitPresence} in {@code src/diff.ts}.
 *
 * @param id   the unit id
 * @param side {@code "a_only"} or {@code "b_only"}
 */
public record UnitPresence(String id, String side) {
}

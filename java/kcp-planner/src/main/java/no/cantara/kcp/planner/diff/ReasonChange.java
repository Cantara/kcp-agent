package no.cantara.kcp.planner.diff;

/**
 * A unit skipped in both plans but for a different reason. Mirrors
 * {@code ReasonChange} in {@code src/diff.ts}.
 *
 * @param id     the unit id
 * @param before the skip reason in plan A
 * @param after  the skip reason in plan B
 */
public record ReasonChange(String id, String before, String after) {
}

package no.cantara.kcp.planner.diff;

/**
 * A unit selected in both plans whose relevance score changed. Mirrors
 * {@code ScoreChange} in {@code src/diff.ts}.
 *
 * @param id     the unit id
 * @param before the score in plan A
 * @param after  the score in plan B
 * @param delta  {@code after - before}
 */
public record ScoreChange(String id, int before, int after, int delta) {
}

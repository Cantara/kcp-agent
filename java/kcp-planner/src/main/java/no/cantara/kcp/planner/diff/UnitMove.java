package no.cantara.kcp.planner.diff;

/**
 * A unit that moved between selected and skipped (or vice versa) across two plans.
 * Mirrors {@code UnitMove} in {@code src/diff.ts}.
 *
 * @param id        the unit id
 * @param direction {@code "selected_to_skipped"} or {@code "skipped_to_selected"}
 * @param from      context from the "from" side (score when it was selected, reason when skipped)
 * @param to        context from the "to" side
 */
public record UnitMove(String id, String direction, MoveSide from, MoveSide to) {

    /**
     * One side of a move — a score (when the unit was selected on that side) or a
     * reason (when it was skipped). Exactly one is non-{@code null}.
     *
     * @param score  the relevance score, or {@code null}
     * @param reason the skip reason, or {@code null}
     */
    public record MoveSide(Integer score, String reason) {
    }
}

package no.cantara.kcp.planner.diff;

import java.util.List;

/**
 * The complete diff between two {@code AgentPlan} artifacts. Because the planner is
 * deterministic, every difference has a cause — the diff names the symptoms; the
 * trace explains them. Produced by {@code KcpPlanner.diffPlans}. Mirrors
 * {@code PlanDiff} in {@code src/diff.ts}.
 *
 * @param a              identifying facts about plan A
 * @param b              identifying facts about plan B
 * @param identical      true only when every diff list is empty
 * @param moves          units that flipped between selected and skipped
 * @param scoreChanges   units selected in both plans with a changed score
 * @param presence       units present in one plan but not the other
 * @param budgetShifts   numeric shifts in budget/context projections
 * @param reasonChanges  units skipped in both plans with a changed reason
 * @param warningChanges warnings added and removed between the plans
 */
public record PlanDiff(
        DiffEnd a,
        DiffEnd b,
        boolean identical,
        List<UnitMove> moves,
        List<ScoreChange> scoreChanges,
        List<UnitPresence> presence,
        List<BudgetShift> budgetShifts,
        List<ReasonChange> reasonChanges,
        WarningChanges warningChanges) {

    /**
     * Identifying facts about one plan end of the diff.
     *
     * @param project the manifest project
     * @param version the manifest version
     * @param task    the task planned
     * @param asOf    the point-in-time used
     */
    public record DiffEnd(String project, String version, String task, String asOf) {
    }

    /** The warnings added and removed between the two plans. */
    public record WarningChanges(List<String> added, List<String> removed) {
    }
}

package no.cantara.kcp.planner.trace;

import java.util.List;

import no.cantara.kcp.planner.AgentCapabilities;
import no.cantara.kcp.planner.AgentPlan;

/**
 * The complete decision trace — the canonical plan annotated with per-unit gate
 * records. Produced by {@code KcpPlanner.trace}. The trace is a read, not a fork:
 * the embedded {@link #plan} is always the authority. Mirrors {@code DecisionTrace}
 * in {@code src/trace.ts}.
 *
 * @param task         the task the trace was computed for
 * @param taskTerms    the task's search terms after tokenization
 * @param asOf         the point-in-time used for temporal evaluation
 * @param capabilities the resolved agent capabilities
 * @param plan         the canonical plan this trace annotates
 * @param units        one trace per manifest unit, in manifest order
 * @param gateSummary  per-gate pass/fail counts across all units
 */
public record DecisionTrace(
        String task,
        List<String> taskTerms,
        String asOf,
        AgentCapabilities capabilities,
        AgentPlan plan,
        List<UnitTrace> units,
        List<GateCount> gateSummary) {

    /**
     * How many units passed and failed one gate.
     *
     * @param gate   the gate
     * @param passed the number of units that passed it
     * @param failed the number of units that failed it
     */
    public record GateCount(GateName gate, int passed, int failed) {
    }
}

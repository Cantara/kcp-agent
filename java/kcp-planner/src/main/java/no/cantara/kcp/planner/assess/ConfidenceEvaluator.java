package no.cantara.kcp.planner.assess;

import java.util.List;

/**
 * An injected judge of an answer's confidence — an LLM call in production,
 * deterministic in tests. Mirrors {@code ConfidenceEvaluator} in
 * {@code src/assess.ts}, which is {@code Promise}-returning there; the Java port
 * has no async LLM plumbing in this module, so the evaluator is a plain
 * synchronous function. A caller wiring a real model in should block on the
 * network call inside {@link #evaluate} (or dispatch it on its own executor and
 * join) rather than pulling reactive infrastructure into this module.
 *
 * <p>{@link #evaluate} may throw — {@link Assess#assess} catches any exception
 * and fails the verdict closed, folding the exception's message into the
 * verdict's detail.</p>
 */
@FunctionalInterface
public interface ConfidenceEvaluator {

    /**
     * Judge how confident a careful reviewer should be that {@code answer} is
     * correct and complete for {@code task}, given the units it was allowed to
     * draw on.
     *
     * @param task   the task the answer addresses
     * @param answer the synthesized answer to judge
     * @param units  the units the answer was allowed to draw on
     * @return the evaluator's confidence signal
     * @throws Exception if the judgment could not be obtained (e.g. the backing
     *                    provider is unreachable, or its response could not be parsed)
     */
    ConfidenceSignal evaluate(String task, String answer, List<GroundUnit> units) throws Exception;
}

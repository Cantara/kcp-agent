package no.cantara.kcp.planner.spring;

import no.cantara.kcp.planner.AgentPlan;
import no.cantara.kcp.planner.KcpPlanner;
import no.cantara.kcp.planner.PlanOptions;
import no.cantara.kcp.planner.diff.PlanDiff;
import no.cantara.kcp.planner.model.Manifest;
import no.cantara.kcp.planner.trace.DecisionTrace;

/**
 * The injectable planning facade. {@link KcpPlanner} itself is a stateless static
 * utility; this service binds it to the auto-configured {@link Manifest} and the
 * {@code kcp.planner.default-*} options, so a Spring bean can plan a task in one call.
 *
 * <pre>{@code
 * @Service
 * class KnowledgeService {
 *     private final KcpPlannerService planner;
 *     KnowledgeService(KcpPlannerService planner) { this.planner = planner; }
 *     AgentPlan planFor(String task) { return planner.plan(task); }
 * }
 * }</pre>
 */
public class KcpPlannerService {

    private final ManifestSource source;
    private final KcpPlannerProperties props;

    /**
     * @param source the loaded-manifest holder
     * @param props  the planner configuration (supplies the default options)
     */
    public KcpPlannerService(ManifestSource source, KcpPlannerProperties props) {
        this.source = source;
        this.props = props;
    }

    /** The manifest this service plans against. */
    public Manifest manifest() {
        return source.manifest();
    }

    /** Plan a task against the configured manifest with the configured default options. */
    public AgentPlan plan(String task) {
        return KcpPlanner.plan(source.manifest(), task, defaults());
    }

    /** Plan a task with explicit options. */
    public AgentPlan plan(String task, PlanOptions options) {
        return KcpPlanner.plan(source.manifest(), task, options);
    }

    /** Produce a decision trace for a task with the configured default options. */
    public DecisionTrace trace(String task) {
        return KcpPlanner.trace(source.manifest(), task, defaults());
    }

    /** Produce a decision trace with explicit options. */
    public DecisionTrace trace(String task, PlanOptions options) {
        return KcpPlanner.trace(source.manifest(), task, options);
    }

    /** Compare two plans. */
    public PlanDiff diff(AgentPlan a, AgentPlan b) {
        return KcpPlanner.diffPlans(a, b);
    }

    /** The default options assembled from {@code kcp.planner.default-*}. */
    public PlanOptions defaults() {
        PlanOptions.Builder b = PlanOptions.builder()
                .role(props.getDefaultRole())
                .maxUnits(props.getMaxUnits())
                .strict(props.isStrict());
        if (props.getDefaultEnv() != null) {
            b.env(props.getDefaultEnv());
        }
        return b.build();
    }
}

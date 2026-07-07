package no.cantara.kcp.planner;

import java.util.List;

/**
 * The complete, inspectable load plan — the auditable artifact the planner
 * produces before any content is loaded or any request is paid for. Mirrors
 * {@code AgentPlan} in {@code src/planner.ts}. Produced by {@link KcpPlanner#plan}.
 *
 * @param task        the task the plan was computed for
 * @param manifest    identifying facts about the source manifest
 * @param trust       the manifest-level attestation posture
 * @param environment the runtime environment used for federation, or {@code null}
 * @param asOf        the point-in-time (ISO date) used for temporal evaluation
 * @param selected    the units selected, highest score first
 * @param skipped     the units skipped, each with its verbatim reason
 * @param federation  the per-sub-manifest federation decisions
 * @param budget      the economic projection
 * @param context     the context-window projection
 * @param warnings    any planning warnings
 */
public record AgentPlan(
        String task,
        ManifestInfo manifest,
        TrustInfo trust,
        String environment,
        String asOf,
        List<PlannedUnit> selected,
        List<SkippedUnit> skipped,
        List<FederationPlan> federation,
        BudgetPlan budget,
        ContextPlan context,
        List<String> warnings) {

    /**
     * Identifying facts about the source manifest.
     *
     * @param project    the project name
     * @param version    the manifest version
     * @param kcpVersion the KCP spec version, or {@code null}
     * @param source     where the manifest was loaded from, or {@code null}
     */
    public record ManifestInfo(String project, String version, String kcpVersion, String source) {
    }

    /**
     * The manifest-level attestation posture.
     *
     * @param requiresAttestation whether the manifest requires attestation
     * @param agentCanAttest       whether the agent can present it
     * @param note                 a human-readable summary
     */
    public record TrustInfo(boolean requiresAttestation, boolean agentCanAttest, String note) {
    }
}

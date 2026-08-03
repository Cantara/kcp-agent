package no.cantara.kcp.planner.model;

import java.util.List;

/**
 * A reference to a federated sub-manifest. The planner decides whether to follow
 * it based on the runtime environment ({@code context}) and any required identity.
 * Mirrors {@code ManifestRef} in {@code src/model.ts}.
 *
 * @param id            stable identifier for the ref
 * @param url           location of the sub-manifest
 * @param label         human-readable label
 * @param relationship  how the sub-manifest relates to this one
 * @param context       environments this ref applies to (e.g. {@code [dev, test]});
 *                      {@code null} means it applies unconditionally
 * @param agentIdentity identity required before following the ref, if any
 * @param localMirror   relative path (to this manifest) to a preferred local copy
 *                      of {@code url} (SPEC.md §3.6, #136)
 */
public record ManifestRef(
        String id,
        String url,
        String label,
        String relationship,
        List<String> context,
        AgentIdentity agentIdentity,
        String localMirror) {
}

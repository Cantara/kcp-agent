package no.cantara.kcp.planner;

/**
 * The decision for one federated sub-manifest reference: whether it is selected
 * for the current environment and what (if anything) is needed before it can be
 * fetched. Mirrors {@code FederationPlan} in {@code src/planner.ts}.
 *
 * @param id               the ref id
 * @param url              the ref URL
 * @param selected         whether the ref applies to the current environment
 * @param reason           the human-readable selection reason
 * @param credentialNeeded a credential required before fetching, or {@code null}
 * @param docsUrl          documentation for obtaining that credential, or {@code null}
 * @param localMirror      relative path (to the declaring manifest) to a preferred
 *                         local copy of {@code url}, or {@code null} (#136)
 */
public record FederationPlan(
        String id,
        String url,
        boolean selected,
        String reason,
        String credentialNeeded,
        String docsUrl,
        String localMirror) {
}

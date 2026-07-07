package no.cantara.kcp.planner.model;

/**
 * The identity a federated sub-manifest requires before it may be fetched.
 * Mirrors {@code AgentIdentity} in {@code src/model.ts}.
 *
 * @param required        whether a credential is required to follow the ref
 * @param credentialHint  the kind of credential expected (matched against the
 *                        agent's declared credentials)
 * @param issuerHint      the expected credential issuer
 * @param docsUrl         documentation for obtaining the credential
 */
public record AgentIdentity(
        Boolean required,
        String credentialHint,
        String issuerHint,
        String docsUrl) {
}

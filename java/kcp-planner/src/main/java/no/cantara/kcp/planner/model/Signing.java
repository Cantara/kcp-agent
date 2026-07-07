package no.cantara.kcp.planner.model;

/**
 * Manifest-signing material — the scheme, public key, and detached signature the
 * verification layer uses to attest the manifest bytes. Mirrors {@code Signing} in
 * {@code src/model.ts}. The planner core does not verify signatures; this is carried
 * for the client/verify layer (Java Phase 4).
 *
 * @param scheme     signature scheme, e.g. {@code ed25519}
 * @param scope      what the signature covers, e.g. {@code this-manifest}
 * @param publicKey  URL of, or inline, the public key material
 * @param signature  URL of, or inline base64, the detached signature
 * @param keyId      the publisher's key identifier, when declared
 */
public record Signing(
        String scheme,
        String scope,
        String publicKey,
        String signature,
        String keyId) {
}

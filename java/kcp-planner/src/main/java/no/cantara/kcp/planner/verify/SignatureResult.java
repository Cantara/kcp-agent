package no.cantara.kcp.planner.verify;

/**
 * The verdict of manifest-signature verification. Mirrors {@code SignatureResult}
 * in {@code src/verify.ts}: a four-valued {@link #status} plus a human-readable
 * {@link #detail} and the publisher's {@link #keyId} when known.
 *
 * <p>Verification is fail-closed: a signature that is present but wrong is always
 * {@link #INVALID}; a signature that cannot be fetched is {@link #UNVERIFIABLE}
 * (left to policy, never silently downgraded to {@link #UNSIGNED}).</p>
 *
 * @param status one of {@link #VERIFIED}, {@link #INVALID}, {@link #UNVERIFIABLE}, {@link #UNSIGNED}
 * @param detail a human-readable explanation of the verdict
 * @param keyId  the publisher's key id, or {@code null} when none is declared
 */
public record SignatureResult(String status, String detail, String keyId) {

    /** The signature was checked against the manifest bytes and matches. */
    public static final String VERIFIED = "verified";
    /** A signature is present but does not match the manifest bytes — fail closed. */
    public static final String INVALID = "invalid";
    /** A signing block is declared but the signature/key could not be verified. */
    public static final String UNVERIFIABLE = "unverifiable";
    /** The manifest declares no signature. */
    public static final String UNSIGNED = "unsigned";

    /** Whether the signature verified against the manifest bytes. */
    public boolean verified() {
        return VERIFIED.equals(status);
    }
}

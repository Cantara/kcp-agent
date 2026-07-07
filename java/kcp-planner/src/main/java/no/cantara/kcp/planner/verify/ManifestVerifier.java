package no.cantara.kcp.planner.verify;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import no.cantara.kcp.planner.model.Signing;

import org.snakeyaml.engine.v2.api.Load;
import org.snakeyaml.engine.v2.api.LoadSettings;

/**
 * Manifest signature verification — Ed25519 over the exact published bytes. A
 * faithful port of {@code src/verify.ts}.
 *
 * <p>The signature file may be a JSON envelope ({@code {algorithm, public_key,
 * signature, key_id}} — the Cantara convention) or raw base64/hex signature bytes;
 * keys may be PEM SPKI, base64 DER SPKI, or a raw 32-byte base64/hex key.
 * Verification is fail-closed: a signature that is present but wrong is always
 * {@link SignatureResult#INVALID}; a signature that cannot be fetched is
 * {@link SignatureResult#UNVERIFIABLE} and left to policy.</p>
 */
public final class ManifestVerifier {

    private ManifestVerifier() {
    }

    /** The 12-byte SPKI (X.509 SubjectPublicKeyInfo) prefix that wraps a raw 32-byte Ed25519 key. */
    private static final byte[] ED25519_SPKI_PREFIX =
            HexFormat.of().parseHex("302a300506032b6570032100");

    private static final Pattern SCHEME = Pattern.compile("^(ed25519|eddsa)$", Pattern.CASE_INSENSITIVE);
    private static final Pattern PEM = Pattern.compile("-----BEGIN [^-]+-----([\\s\\S]*?)-----END [^-]+-----");
    private static final Pattern HEX = Pattern.compile("^[0-9a-fA-F\\s]+$");
    private static final Pattern B64 = Pattern.compile("^[A-Za-z0-9+/=\\s]+$");
    private static final Pattern HTTP = Pattern.compile("^https?://.*", Pattern.CASE_INSENSITIVE);

    /**
     * Verify manifest text against its signing block.
     *
     * @param text    the exact manifest bytes as text
     * @param signing the manifest's signing block, or {@code null}
     * @param source  the path or URL the manifest was loaded from (anchors relative locations), or {@code null}
     * @param options verification options
     * @return the verdict
     */
    public static SignatureResult verify(String text, Signing signing, String source, VerifyOptions options) {
        if (signing == null) {
            return new SignatureResult(SignatureResult.UNSIGNED, "manifest declares no signature", null);
        }
        String keyId = signing.keyId();
        // A signing block without a locatable signature is a declaration we cannot
        // act on, not an unsigned manifest — report it loudly (fail-closed).
        if (signing.signature() == null) {
            return new SignatureResult(SignatureResult.UNVERIFIABLE,
                    "manifest declares a signing block but no signature location — treating as unverified", keyId);
        }
        if (signing.scheme() != null && !SCHEME.matcher(signing.scheme()).matches()) {
            return new SignatureResult(SignatureResult.UNVERIFIABLE,
                    "unsupported signing scheme '" + signing.scheme() + "'", keyId);
        }
        TextFetcher fetch = options.fetchText() != null ? options.fetchText() : ManifestVerifier::readLocal;

        // Locate the signature (and possibly an embedded key + key id).
        String signatureMaterial;
        String embeddedKey = null;
        try {
            String rawSig = looksInline(signing.signature())
                    ? signing.signature()
                    : fetch.fetch(resolveLocation(source, signing.signature()));
            if (rawSig.trim().startsWith("{")) {
                Map<?, ?> envelope = (Map<?, ?>) new Load(LoadSettings.builder().build()).loadFromString(rawSig);
                signatureMaterial = envelope.get("signature") != null ? envelope.get("signature").toString() : "";
                embeddedKey = envelope.get("public_key") != null ? envelope.get("public_key").toString() : null;
                if (envelope.get("key_id") != null) {
                    keyId = envelope.get("key_id").toString();
                }
                String alg = envelope.get("algorithm") != null ? envelope.get("algorithm").toString() : null;
                if (alg != null && !SCHEME.matcher(alg).matches()) {
                    return new SignatureResult(SignatureResult.UNVERIFIABLE,
                            "unsupported signature algorithm '" + alg + "'", keyId);
                }
            } else {
                signatureMaterial = rawSig; // raw base64/hex signature file
            }
        } catch (Exception e) {
            return new SignatureResult(SignatureResult.UNVERIFIABLE, "cannot load signature: " + message(e), keyId);
        }
        byte[] sigBytes = decodeBytes(signatureMaterial);
        if (sigBytes == null || sigBytes.length != 64) {
            return new SignatureResult(SignatureResult.INVALID, "signature is not 64 ed25519 signature bytes", keyId);
        }

        // Locate the public key: a pinned key wins; then signing.public_key; then
        // the key embedded in the signature envelope (self-attesting — last resort).
        String keyMaterial;
        String via;
        try {
            if (options.trustedKey() != null) {
                keyMaterial = looksInline(options.trustedKey())
                        ? options.trustedKey()
                        : fetch.fetch(resolveLocation(null, options.trustedKey()));
                via = "pinned key";
            } else if (signing.publicKey() != null) {
                keyMaterial = looksInline(signing.publicKey())
                        ? signing.publicKey()
                        : fetch.fetch(resolveLocation(source, signing.publicKey()));
                via = "declared key";
            } else if (embeddedKey != null) {
                keyMaterial = embeddedKey;
                via = "envelope key";
            } else {
                return new SignatureResult(SignatureResult.UNVERIFIABLE, "no public key available", keyId);
            }
        } catch (Exception e) {
            if (embeddedKey != null && options.trustedKey() == null) {
                keyMaterial = embeddedKey; // declared key unreachable; fall back to envelope key
                via = "envelope key";
            } else {
                return new SignatureResult(SignatureResult.UNVERIFIABLE, "cannot load public key: " + message(e), keyId);
            }
        }

        PublicKey key;
        try {
            key = importPublicKey(keyMaterial);
        } catch (Exception e) {
            return new SignatureResult(SignatureResult.UNVERIFIABLE, "cannot import public key: " + message(e), keyId);
        }

        // Verify the exact bytes; retry with a single trailing newline normalized,
        // which survives editor/git end-of-file differences without weakening the check.
        for (String candidate : new String[] {text, text.replaceAll("\\n*$", "\n")}) {
            if (cryptoVerify(key, sigBytes, candidate.getBytes(StandardCharsets.UTF_8))) {
                return new SignatureResult(SignatureResult.VERIFIED, "ed25519 signature verified (" + via + ")", keyId);
            }
        }
        return new SignatureResult(SignatureResult.INVALID, "ed25519 signature does not match manifest bytes", keyId);
    }

    /** Verify with default options (local-file fetching, no pinned key). */
    public static SignatureResult verify(String text, Signing signing, String source) {
        return verify(text, signing, source, VerifyOptions.defaults());
    }

    // --- helpers (ported from src/verify.ts) ---

    /** Resolve a possibly-relative signature/key location against the manifest's source. */
    public static String resolveLocation(String base, String loc) {
        if (HTTP.matcher(loc).matches()) {
            return loc;
        }
        if (base != null && HTTP.matcher(base).matches()) {
            return java.net.URI.create(base).resolve(loc).toString();
        }
        if (base != null && !Path.of(loc).isAbsolute()) {
            Path parent = Path.of(base).getParent();
            return (parent != null ? parent.resolve(loc) : Path.of(loc)).toString();
        }
        return loc;
    }

    private static String readLocal(String location) throws IOException {
        if (HTTP.matcher(location).matches()) {
            throw new IOException("URL fetching requires a configured fetcher (use ManifestClient)");
        }
        return Files.readString(Path.of(location));
    }

    /** Is this value inline key/signature material rather than a URL/path? */
    private static boolean looksInline(String value) {
        if (HTTP.matcher(value).matches()) {
            return false;
        }
        if (value.contains("-----BEGIN")) {
            return true;
        }
        byte[] bytes = decodeBytes(value);
        return bytes != null && (bytes.length == 32 || bytes.length == 44 || bytes.length == 64);
    }

    /** Decode key/signature material from PEM, hex, or base64. */
    private static byte[] decodeBytes(String material) {
        String s = material.trim();
        Matcher pem = PEM.matcher(s);
        if (pem.find()) {
            return tryBase64(pem.group(1).replaceAll("\\s+", ""));
        }
        String stripped = s.replaceAll("\\s+", "");
        if (HEX.matcher(s).matches() && stripped.length() % 2 == 0 && stripped.length() >= 64) {
            try {
                return HexFormat.of().parseHex(stripped);
            } catch (IllegalArgumentException e) {
                return null;
            }
        }
        if (B64.matcher(s).matches()) {
            return tryBase64(stripped);
        }
        return null;
    }

    private static byte[] tryBase64(String s) {
        try {
            return Base64.getDecoder().decode(s);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static PublicKey importPublicKey(String material) throws Exception {
        byte[] bytes = decodeBytes(material);
        if (bytes == null) {
            throw new IllegalArgumentException("unrecognized public key encoding");
        }
        byte[] spki;
        if (bytes.length == 32) {
            spki = new byte[ED25519_SPKI_PREFIX.length + 32];
            System.arraycopy(ED25519_SPKI_PREFIX, 0, spki, 0, ED25519_SPKI_PREFIX.length);
            System.arraycopy(bytes, 0, spki, ED25519_SPKI_PREFIX.length, 32);
        } else {
            spki = bytes; // 44-byte DER SPKI (or PEM-decoded SPKI)
        }
        return KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(spki));
    }

    private static boolean cryptoVerify(PublicKey key, byte[] sig, byte[] message) {
        try {
            Signature verifier = Signature.getInstance("Ed25519");
            verifier.initVerify(key);
            verifier.update(message);
            return verifier.verify(sig);
        } catch (Exception e) {
            return false;
        }
    }

    private static String message(Exception e) {
        String m = e.getMessage();
        return m != null ? m : e.getClass().getSimpleName();
    }
}

package no.cantara.kcp.planner.verify;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

import no.cantara.kcp.planner.ManifestParser;
import no.cantara.kcp.planner.model.Manifest;

import org.junit.jupiter.api.Test;

/**
 * Signature-verification conformance — pins the offline Ed25519 behavior against
 * the repo's signed example manifests (each carries a local {@code knowledge.yaml.sig}
 * envelope with an embedded SPKI key). The Java verifier must reproduce the same
 * {@code verified} / {@code unsigned} / {@code invalid} verdicts as the TypeScript
 * reference and the Rust port. A fail-open in a trust check is the worst kind of drift.
 */
class ManifestVerifierConformanceTest {

    private static Path examplesDir() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null) {
            Path e = dir.resolve("examples");
            if (Files.isDirectory(e.resolve("sealed"))) {
                return e;
            }
            dir = dir.getParent();
        }
        throw new IllegalStateException("could not locate the examples/ directory");
    }

    private static String[] load(String dir) throws IOException {
        Path source = examplesDir().resolve(dir).resolve("knowledge.yaml");
        return new String[] {Files.readString(source), source.toString()};
    }

    @Test
    void signedExamplesVerifyOffline() throws IOException {
        for (String dir : new String[] {"sealed", "incident/fjellcert", "milky-way/hub", "summer/tourism"}) {
            String[] ts = load(dir);
            Manifest manifest = ManifestParser.parse(ts[0], ts[1]);
            SignatureResult sig = ManifestVerifier.verify(ts[0], manifest.signing(), ts[1]);
            assertEquals(SignatureResult.VERIFIED, sig.status(), dir + " should verify, got " + sig);
            assertTrue(sig.verified());
            assertNotNull(sig.keyId(), dir + " should carry a key id");
        }
    }

    @Test
    void tamperedManifestIsInvalid() throws IOException {
        String[] ts = load("sealed");
        Manifest manifest = ManifestParser.parse(ts[0], ts[1]);
        // Flip bytes the signature covers — verification must fail closed.
        String tampered = ts[0].stripTrailing() + "\n# tampered\n";
        SignatureResult sig = ManifestVerifier.verify(tampered, manifest.signing(), ts[1]);
        assertEquals(SignatureResult.INVALID, sig.status(), "tampered manifest must be invalid, got " + sig);
    }

    @Test
    void unsignedManifestReportsUnsigned() throws IOException {
        String[] ts = load("fjordwire");
        Manifest manifest = ManifestParser.parse(ts[0], ts[1]);
        SignatureResult sig = ManifestVerifier.verify(ts[0], manifest.signing(), ts[1]);
        assertEquals(SignatureResult.UNSIGNED, sig.status());
        assertEquals("manifest declares no signature", sig.detail());
        assertNull(sig.keyId());
    }
}

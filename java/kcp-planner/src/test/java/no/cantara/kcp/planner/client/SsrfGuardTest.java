package no.cantara.kcp.planner.client;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * SSRF-guard conformance — mirrors the Rust {@code fetch_conformance} cases. The
 * IP classification and URL refusal are the security decision, tested directly
 * rather than only through the network path.
 */
class SsrfGuardTest {

    @Test
    void privateAndReservedAddressesAreRefused() {
        for (String ip : new String[] {"127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1",
                "169.254.169.254", "100.64.0.1", "0.0.0.0"}) {
            assertTrue(SsrfGuard.isPrivateAddress(ip), ip + " should be private");
        }
        assertTrue(SsrfGuard.isPrivateAddress("::1"));                 // loopback
        assertTrue(SsrfGuard.isPrivateAddress("fe80::1"));             // link-local
        assertTrue(SsrfGuard.isPrivateAddress("fc00::1"));             // unique-local
        assertTrue(SsrfGuard.isPrivateAddress("::ffff:169.254.169.254")); // IPv4-mapped metadata (dotted)
        assertTrue(SsrfGuard.isPrivateAddress("::ffff:a9fe:a9fe"));    // ...and the hex form
        assertTrue(SsrfGuard.isPrivateAddress("::ffff:0a00:0001"));    // ::ffff:10.0.0.1
    }

    @Test
    void publicAddressesArePermitted() {
        for (String ip : new String[] {"8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"}) {
            assertFalse(SsrfGuard.isPrivateAddress(ip), ip + " should be public");
        }
        assertFalse(SsrfGuard.isPrivateAddress("example.com")); // a hostname is not an address literal
    }

    @Test
    void assertPublicUrlRefusesLoopbackAndCleartext() {
        FetchGuard guard = FetchGuard.defaults();
        // A URL whose host is a loopback literal is refused before any connection.
        assertThrows(SsrfGuard.RefusedException.class,
                () -> SsrfGuard.assertPublicUrl("https://127.0.0.1/knowledge.yaml", guard));
        // IPv4-mapped metadata literal is refused.
        assertThrows(SsrfGuard.RefusedException.class,
                () -> SsrfGuard.assertPublicUrl("https://[::ffff:169.254.169.254]/x", guard));
        // A non-http scheme is refused.
        assertThrows(SsrfGuard.RefusedException.class,
                () -> SsrfGuard.assertPublicUrl("file:///etc/passwd", guard));
    }

    @Test
    void allowPrivatePermitsLoopback() throws Exception {
        FetchGuard guard = new FetchGuard(true, FetchGuard.DEFAULT_MAX_BYTES, FetchGuard.DEFAULT_TIMEOUT);
        // With private hosts allowed, a loopback literal (even over http) is accepted.
        SsrfGuard.assertPublicUrl("http://127.0.0.1:8080/knowledge.yaml", guard);
    }
}

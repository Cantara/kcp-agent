package no.cantara.kcp.planner.client;

import java.io.IOException;
import java.net.InetAddress;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The SSRF decision: refuse a URL whose scheme or (resolved) host an untrusted
 * manifest must not reach. A faithful port of the security model in
 * {@code src/fetch.ts}.
 *
 * <p>A manifest is untrusted input and chooses the URLs the agent then fetches —
 * federation refs, signature and key locations, remote unit content. This guard
 * refuses cleartext {@code http://} to remote hosts, refuses private / loopback /
 * link-local / multicast addresses, and (because it resolves the host and checks
 * every resolved address) closes DNS-rebinding: a name that resolves to a private
 * address is refused before any connection is made.</p>
 */
public final class SsrfGuard {

    private SsrfGuard() {
    }

    private static final Pattern V4 = Pattern.compile("\\d{1,3}(\\.\\d{1,3}){3}");
    private static final Pattern MAPPED_DOTTED = Pattern.compile("^::ffff:(\\d+\\.\\d+\\.\\d+\\.\\d+)$");
    private static final Pattern MAPPED_HEX = Pattern.compile("^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$");

    /** Thrown when the guard refuses a URL. */
    public static final class RefusedException extends IOException {
        RefusedException(String message) {
            super(message);
        }
    }

    /**
     * True for IPv4/IPv6 literals that must never be reached from an untrusted
     * manifest. Non-literals (hostnames) return {@code false} — resolve first.
     *
     * @param addr an IP literal
     * @return whether the address is private/reserved
     */
    public static boolean isPrivateAddress(String addr) {
        int kind = ipKind(addr);
        if (kind == 4) {
            return isPrivateV4(addr);
        }
        if (kind == 6) {
            return isPrivateV6(addr.toLowerCase(Locale.ROOT));
        }
        return false;
    }

    private static int ipKind(String s) {
        if (V4.matcher(s).matches()) {
            for (String o : s.split("\\.")) {
                if (Integer.parseInt(o) > 255) {
                    return 0;
                }
            }
            return 4;
        }
        if (s.indexOf(':') >= 0 && s.matches("[0-9a-fA-F:.]+")) {
            return 6;
        }
        return 0;
    }

    private static boolean isPrivateV4(String ip) {
        String[] p = ip.split("\\.");
        if (p.length != 4) {
            return true; // malformed → refuse
        }
        int[] n = new int[4];
        for (int i = 0; i < 4; i++) {
            try {
                n[i] = Integer.parseInt(p[i]);
            } catch (NumberFormatException e) {
                return true;
            }
            if (n[i] < 0 || n[i] > 255) {
                return true;
            }
        }
        int a = n[0];
        int b = n[1];
        return a == 0            // 0.0.0.0/8 "this host"
                || a == 10       // private
                || a == 127      // loopback
                || (a == 169 && b == 254) // link-local incl. cloud metadata 169.254.169.254
                || (a == 172 && b >= 16 && b <= 31) // private
                || (a == 192 && b == 168) // private
                || (a == 100 && b >= 64 && b <= 127) // CGNAT 100.64/10
                || a >= 224;     // multicast / reserved
    }

    private static boolean isPrivateV6(String ip) {
        Matcher dotted = MAPPED_DOTTED.matcher(ip);
        if (dotted.matches()) {
            return isPrivateV4(dotted.group(1));
        }
        Matcher hex = MAPPED_HEX.matcher(ip);
        if (hex.matches()) {
            int hi = Integer.parseInt(hex.group(1), 16);
            int lo = Integer.parseInt(hex.group(2), 16);
            return isPrivateV4(((hi >> 8) & 0xff) + "." + (hi & 0xff) + "." + ((lo >> 8) & 0xff) + "." + (lo & 0xff));
        }
        return ip.equals("::1")           // loopback
                || ip.equals("::")        // unspecified
                || ip.startsWith("fe80")  // link-local
                || ip.startsWith("fc")    // unique-local fc00::/7
                || ip.startsWith("fd")
                || ip.startsWith("ff");   // multicast
    }

    /**
     * Refuse a URL whose scheme/host an untrusted manifest must not reach; return
     * the checked URL. Applied to the initial URL and, identically, to every
     * redirect target.
     *
     * @param rawUrl the URL to check
     * @param guard  the fetch policy
     * @return the validated URI
     * @throws RefusedException if the scheme, host, or a resolved address is refused
     */
    public static URI assertPublicUrl(String rawUrl, FetchGuard guard) throws RefusedException {
        URI url;
        try {
            url = new URI(rawUrl);
        } catch (URISyntaxException e) {
            throw new RefusedException("not a valid URL: " + rawUrl);
        }
        String scheme = url.getScheme() == null ? "" : url.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("https") && !scheme.equals("http")) {
            throw new RefusedException("refused scheme '" + url.getScheme() + "' (only http/https are fetched)");
        }
        String host = url.getHost();
        if (host == null) {
            throw new RefusedException("URL has no host: " + rawUrl);
        }
        host = host.replaceAll("^\\[|\\]$", ""); // strip IPv6 brackets

        List<String> addresses = new ArrayList<>();
        if (ipKind(host) != 0) {
            addresses.add(host);
        } else {
            try {
                for (InetAddress a : InetAddress.getAllByName(host)) {
                    addresses.add(a.getHostAddress());
                }
            } catch (UnknownHostException e) {
                throw new RefusedException("cannot resolve host '" + host + "': " + e.getMessage());
            }
            if (addresses.isEmpty()) {
                throw new RefusedException("host '" + host + "' resolved to no addresses");
            }
        }

        if (!guard.allowPrivate()) {
            for (String a : addresses) {
                if (isPrivateAddress(a)) {
                    throw new RefusedException("refused private/loopback/link-local address " + a + " for '" + host
                            + "' (allow private hosts to permit local and internal manifests)");
                }
            }
            if (scheme.equals("http")) {
                throw new RefusedException("refused cleartext http:// for '" + host
                        + "' (use https, or allow private hosts for local)");
            }
        }
        return url;
    }
}

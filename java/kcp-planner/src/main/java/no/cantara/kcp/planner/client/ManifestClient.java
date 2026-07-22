package no.cantara.kcp.planner.client;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HexFormat;
import java.util.regex.Pattern;

import no.cantara.kcp.planner.ManifestParser;
import no.cantara.kcp.planner.model.Manifest;
import no.cantara.kcp.planner.verify.ManifestVerifier;
import no.cantara.kcp.planner.verify.SignatureResult;
import no.cantara.kcp.planner.verify.TextFetcher;
import no.cantara.kcp.planner.verify.VerifyOptions;

/**
 * Locates and loads a {@code knowledge.yaml} from a local path, a directory, or an
 * {@code https://} URL, and optionally verifies its signature. A port of the client
 * layer in {@code src/client.ts} + {@code src/fetch.ts}.
 *
 * <p>Every remote read funnels through {@link SsrfGuard}: HTTPS-only to public hosts
 * by default, redirects handled manually and re-checked at each hop, response size
 * and time bounded. No external HTTP dependency — {@link java.net.http.HttpClient}.</p>
 *
 * <pre>{@code
 * ManifestClient client = ManifestClient.builder().timeout(Duration.ofSeconds(10)).build();
 * LoadedManifest lm = client.load("https://example.com/knowledge.yaml", true);
 * AgentPlan plan = KcpPlanner.plan(lm.manifest(), "how do I deploy?");
 * }</pre>
 */
public final class ManifestClient {

    /** The User-Agent this client presents. */
    public static final String USER_AGENT = "kcp-planner-java/0.16.0";
    private static final int MAX_REDIRECTS = 5;
    private static final Pattern URL_SCHEME = Pattern.compile("^https?://.*", Pattern.CASE_INSENSITIVE);

    private static boolean isUrl(String s) {
        return URL_SCHEME.matcher(s).matches();
    }

    private final FetchGuard guard;
    private final HttpClient http;

    private ManifestClient(FetchGuard guard) {
        this.guard = guard;
        this.http = HttpClient.newBuilder()
                .followRedirects(HttpClient.Redirect.NEVER) // we re-check every hop ourselves
                .connectTimeout(guard.timeout())
                .build();
    }

    /** The guard policy this client enforces. */
    public FetchGuard guard() {
        return guard;
    }

    /** A {@link TextFetcher} that reads local paths and fetches URLs through the guard. */
    public TextFetcher textFetcher() {
        return location -> isUrl(location) ? guardedFetchText(location) : Files.readString(Path.of(location));
    }

    /**
     * Load and parse a manifest from a path, directory, or URL, optionally verifying
     * its signature.
     *
     * @param location a local path/dir or {@code http(s)} URL
     * @param verify   whether to verify the manifest signature
     * @return the loaded manifest with its bytes, source, SHA-256, and (if requested) verdict
     * @throws IOException if the manifest cannot be located or read
     */
    public LoadedManifest load(String location, boolean verify) throws IOException {
        Loaded t = loadText(location);
        Manifest manifest = ManifestParser.parse(t.text, t.source);
        String sha = sha256(t.text);
        SignatureResult sig = verify
                ? ManifestVerifier.verify(t.text, manifest.signing(), t.source, VerifyOptions.withFetcher(textFetcher()))
                : null;
        return new LoadedManifest(manifest, t.text, t.source, sha, sig);
    }

    /** Load and parse a manifest without verifying its signature. */
    public LoadedManifest load(String location) throws IOException {
        return load(location, false);
    }

    /**
     * Fetch and parse a manifest from a URL (the {@code java.net.URI} entry point).
     *
     * @param uri the manifest URL
     * @return the parsed manifest
     * @throws IOException if the fetch fails or the host/scheme is refused
     */
    public Manifest fetch(URI uri) throws IOException {
        return load(uri.toString(), false).manifest();
    }

    private record Loaded(String text, String source) {
    }

    private Loaded loadText(String location) throws IOException {
        if (isUrl(location)) {
            return new Loaded(guardedFetchText(location), location);
        }
        Path path = Path.of(location);
        if (Files.isDirectory(path)) {
            Path[] candidates = {path.resolve("knowledge.yaml"), path.resolve(".well-known").resolve("knowledge.yaml")};
            Path found = null;
            for (Path c : candidates) {
                if (Files.exists(c)) {
                    found = c;
                    break;
                }
            }
            if (found == null) {
                throw new IOException("no knowledge.yaml found in " + location);
            }
            path = found;
        }
        if (!Files.exists(path)) {
            throw new IOException("manifest not found: " + location);
        }
        return new Loaded(Files.readString(path), path.toString());
    }

    /**
     * Fetch text from a URL through the guard: scheme + host + redirect + size + time.
     *
     * @param rawUrl the URL to fetch
     * @return the response body as text
     * @throws IOException if the fetch fails or the guard refuses a hop
     */
    public String guardedFetchText(String rawUrl) throws IOException {
        String current = rawUrl;
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            URI url = SsrfGuard.assertPublicUrl(current, guard);
            HttpRequest req = HttpRequest.newBuilder(url)
                    .timeout(guard.timeout())
                    .header("User-Agent", USER_AGENT)
                    .GET()
                    .build();
            HttpResponse<InputStream> res;
            try {
                res = http.send(req, HttpResponse.BodyHandlers.ofInputStream());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IOException("interrupted fetching " + url);
            }
            int sc = res.statusCode();
            if (sc >= 300 && sc < 400) {
                String loc = res.headers().firstValue("location").orElse(null);
                res.body().close();
                if (loc == null) {
                    throw new IOException("redirect with no Location from " + url);
                }
                current = url.resolve(loc).toString();
                continue;
            }
            if (sc < 200 || sc >= 300) {
                res.body().close();
                throw new IOException(sc + " fetching " + url);
            }
            long declared = res.headers().firstValueAsLong("content-length").orElse(-1);
            if (declared > guard.maxBytes()) {
                res.body().close();
                throw new IOException("response too large: " + declared + " bytes exceeds cap " + guard.maxBytes());
            }
            return readCapped(res.body(), guard.maxBytes(), url);
        }
        throw new IOException("too many redirects (>" + MAX_REDIRECTS + ") starting at " + rawUrl);
    }

    private static String readCapped(InputStream in, long maxBytes, URI href) throws IOException {
        try (in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            long total = 0;
            int n;
            while ((n = in.read(buf)) != -1) {
                total += n;
                if (total > maxBytes) {
                    throw new IOException("response too large: exceeded cap " + maxBytes + " bytes while reading " + href);
                }
                out.write(buf, 0, n);
            }
            return out.toString(StandardCharsets.UTF_8);
        }
    }

    /** Hex SHA-256 of the given text's UTF-8 bytes. */
    public static String sha256(String text) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e); // never on a conformant JRE
        }
    }

    /** Start building a client. */
    public static Builder builder() {
        return new Builder();
    }

    /** Create a client with the default guard (HTTPS-only, 8 MiB, 15 s). */
    public static ManifestClient create() {
        return new ManifestClient(FetchGuard.defaults());
    }

    /** A fluent builder for {@link ManifestClient}. */
    public static final class Builder {
        private boolean allowPrivate;
        private long maxBytes = FetchGuard.DEFAULT_MAX_BYTES;
        private Duration timeout = FetchGuard.DEFAULT_TIMEOUT;

        /** Permit loopback/private/link-local hosts (and cleartext http:// to them). */
        public Builder allowPrivate(boolean allowPrivate) {
            this.allowPrivate = allowPrivate;
            return this;
        }

        /** Set the maximum response size in bytes. */
        public Builder maxBytes(long maxBytes) {
            this.maxBytes = maxBytes;
            return this;
        }

        /** Set the whole-exchange timeout. */
        public Builder timeout(Duration timeout) {
            this.timeout = timeout;
            return this;
        }

        /** Build the client. */
        public ManifestClient build() {
            return new ManifestClient(new FetchGuard(allowPrivate, maxBytes, timeout));
        }
    }
}

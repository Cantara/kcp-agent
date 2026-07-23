package no.cantara.kcp.planner;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import no.cantara.kcp.planner.model.AgentIdentity;
import no.cantara.kcp.planner.model.Manifest;
import no.cantara.kcp.planner.model.ManifestRef;
import no.cantara.kcp.planner.model.Payment;
import no.cantara.kcp.planner.model.PaymentMethod;
import no.cantara.kcp.planner.model.RateLimitTier;
import no.cantara.kcp.planner.model.RateLimits;
import no.cantara.kcp.planner.model.RequestCount;
import no.cantara.kcp.planner.model.Signing;
import no.cantara.kcp.planner.model.Temporal;
import no.cantara.kcp.planner.model.Trust;
import no.cantara.kcp.planner.model.TrustAgentRequirements;
import no.cantara.kcp.planner.model.Unit;

import org.snakeyaml.engine.v2.api.Load;
import org.snakeyaml.engine.v2.api.LoadSettings;

/**
 * Parses a {@code knowledge.yaml} string into the compact {@link Manifest} model.
 *
 * <p>A faithful port of {@code parseManifest} in {@code src/client.ts}: the same
 * lenient scalar coercions ({@code asStr}, {@code asStrArr}, {@code asNum},
 * {@code normCount}), the same defaults (missing {@code audience} → {@code []},
 * missing {@code project} → {@code "(unnamed)"}), and the same
 * {@code trust.content_integrity} back-compat mapping so a newer agent verifies
 * KCP &le; 0.20 manifests instead of silently downgrading trust to "unsigned".</p>
 *
 * <p>Parsing goes through a YAML 1.2 engine (matching {@code js-yaml}'s schema) to a
 * generic object tree, then coerces field by field — exactly as the TypeScript
 * reference does — so a numeric {@code price_per_request: 0.25} and a quoted
 * {@code "0.25"} resolve identically.</p>
 */
public final class ManifestParser {

    private ManifestParser() {
    }

    /**
     * Parse a YAML manifest string into the compact {@link Manifest} model.
     *
     * @param text   the raw {@code knowledge.yaml} text
     * @param source where the manifest was loaded from (path or URL), or {@code null}
     * @return the parsed manifest
     * @throws IllegalArgumentException if the text is not a YAML mapping
     */
    public static Manifest parse(String text, String source) {
        Load load = new Load(LoadSettings.builder().build());
        Object raw = load.loadFromString(text);
        if (!(raw instanceof Map<?, ?> root)) {
            throw new IllegalArgumentException("manifest is not a YAML mapping");
        }

        Map<?, ?> trustRaw = asObj(get(root, "trust"));
        Map<?, ?> signingRaw = asObj(get(root, "signing"));
        Signing signing = null;
        if (signingRaw != null) {
            signing = new Signing(
                    asStr(get(signingRaw, "scheme")),
                    asStr(get(signingRaw, "scope")),
                    asStr(get(signingRaw, "public_key")),
                    asStr(get(signingRaw, "signature")),
                    asStr(get(signingRaw, "key_id")));
        }
        // KCP <= 0.20 declared signing under trust.content_integrity with
        // {signing: {algorithm, key_id, public_key}, signature_file}. Map it so a
        // newer agent verifies old manifests instead of silently downgrading trust
        // to "unsigned" — version skew must never fail open.
        Map<?, ?> ciRaw = trustRaw != null ? asObj(get(trustRaw, "content_integrity")) : null;
        Map<?, ?> ciSigningRaw = ciRaw != null ? asObj(get(ciRaw, "signing")) : null;
        if (signing == null && ciRaw != null && ciSigningRaw != null) {
            String scheme = asStr(get(ciSigningRaw, "algorithm"));
            if (scheme == null) {
                scheme = asStr(get(ciSigningRaw, "scheme"));
            }
            String sig = asStr(get(ciRaw, "signature_file"));
            if (sig == null) {
                sig = asStr(get(ciSigningRaw, "signature"));
            }
            signing = new Signing(
                    scheme,
                    null,
                    asStr(get(ciSigningRaw, "public_key")),
                    sig,
                    asStr(get(ciSigningRaw, "key_id")));
        }

        Map<?, ?> ar = trustRaw != null ? asObj(get(trustRaw, "agent_requirements")) : null;
        Trust trust = null;
        if (ar != null) {
            trust = new Trust(new TrustAgentRequirements(
                    optBool(ar, "require_attestation"),
                    asStrArr(get(ar, "trusted_providers")),
                    asStr(get(ar, "attestation_url"))));
        }

        return new Manifest(
                coalesceStr(get(root, "project"), "(unnamed)"),
                coalesceStr(get(root, "version"), "0.0.0"),
                asStr(get(root, "kcp_version")),
                mapObjects(get(root, "units"), ManifestParser::parseUnit),
                mapObjects(get(root, "manifests"), ManifestParser::parseManifestRef),
                parsePayment(get(root, "payment")),
                parseRateLimits(get(root, "rate_limits")),
                trust,
                signing,
                source);
    }

    private static Unit parseUnit(Map<?, ?> v) {
        Temporal temporal = null;
        Map<?, ?> t = asObj(get(v, "temporal"));
        if (t != null) {
            temporal = new Temporal(
                    asStr(get(t, "valid_from")),
                    asStr(get(t, "valid_until")),
                    asStr(get(t, "superseded_by")));
        }
        return new Unit(
                reqStr(get(v, "id")),
                reqStr(get(v, "path")),
                reqStr(get(v, "intent")),
                asStr(get(v, "scope")),
                asStrArr(get(v, "audience")),
                asStrArr(get(v, "triggers")),
                asStr(get(v, "access")),
                asStr(get(v, "auth_scope")),
                optBool(v, "deprecated"),
                asStrArr(get(v, "not_for")),
                parsePayment(get(v, "payment")),
                parseRateLimits(get(v, "rate_limits")),
                temporal,
                asStr(get(v, "kind")),
                parseActionScope(get(v, "action_scope")),
                optBool(v, "load_eligible"),
                asNum(get(v, "size_tokens")),
                asNum(get(v, "bytes")));
    }

    private static Unit.ActionScope parseActionScope(Object v) {
        Map<?, ?> d = asObj(v);
        if (d == null) {
            return null;
        }
        return new Unit.ActionScope(
                asStrArr(get(d, "tools")),
                asStrArr(get(d, "paths")),
                asStrArr(get(d, "capabilities")),
                parseSpend(get(d, "spend")));
    }

    private static Unit.ActionScope.Spend parseSpend(Object v) {
        Map<?, ?> d = asObj(v);
        if (d == null) {
            return null;
        }
        return new Unit.ActionScope.Spend(
                asDecimal(get(d, "max_spend")),
                asStrArr(get(d, "allowed_vendors")),
                asStr(get(d, "currency")));
    }

    private static ManifestRef parseManifestRef(Map<?, ?> v) {
        Map<?, ?> ai = asObj(get(v, "agent_identity"));
        AgentIdentity identity = null;
        if (ai != null) {
            identity = new AgentIdentity(
                    optBool(ai, "required"),
                    asStr(get(ai, "credential_hint")),
                    asStr(get(ai, "issuer_hint")),
                    asStr(get(ai, "docs_url")));
        }
        List<String> context = get(v, "context") instanceof List ? asStrArr(get(v, "context")) : null;
        return new ManifestRef(
                reqStr(get(v, "id")),
                reqStr(get(v, "url")),
                asStr(get(v, "label")),
                asStr(get(v, "relationship")),
                context,
                identity);
    }

    private static Payment parsePayment(Object v) {
        Map<?, ?> d = asObj(v);
        if (d == null) {
            return null;
        }
        List<PaymentMethod> methods = null;
        if (get(d, "methods") instanceof List<?> list) {
            methods = new ArrayList<>();
            for (Object m : list) {
                methods.add(parsePaymentMethod(m));
            }
        }
        return new Payment(
                asStr(get(d, "default_tier")),
                methods,
                asStr(get(d, "billing_contact")));
    }

    private static PaymentMethod parsePaymentMethod(Object v) {
        Map<?, ?> d = asObj(v);
        Map<?, ?> m = d != null ? d : Map.of();
        List<String> networks = get(m, "networks") instanceof List ? asStrArr(get(m, "networks")) : null;
        return new PaymentMethod(
                coalesceStr(get(m, "type"), ""),
                asStr(get(m, "currency")),
                asStr(get(m, "price_per_request")),
                networks,
                asStr(get(m, "wallet")),
                asStr(get(m, "provider")),
                asStr(get(m, "plans_url")),
                optBool(m, "free_tier"),
                optNum(m, "free_requests_per_day"),
                asStr(get(m, "upgrade_url")));
    }

    private static RateLimits parseRateLimits(Object v) {
        Map<?, ?> d = asObj(v);
        if (d == null) {
            return null;
        }
        return new RateLimits(
                parseTier(get(d, "default")),
                parseTier(get(d, "authenticated")),
                parseTier(get(d, "premium")),
                asStr(get(d, "backoff")));
    }

    private static RateLimitTier parseTier(Object v) {
        Map<?, ?> d = asObj(v);
        if (d == null) {
            return null;
        }
        return new RateLimitTier(
                normCount(get(d, "requests_per_minute")),
                normCount(get(d, "requests_per_hour")),
                normCount(get(d, "requests_per_day")));
    }

    // --- coercion helpers, mirroring src/client.ts ---

    private static Object get(Map<?, ?> m, String key) {
        return m.get(key);
    }

    private static Map<?, ?> asObj(Object v) {
        return v instanceof Map<?, ?> map ? map : null;
    }

    /** {@code asStr}: null/undefined → null, else String(v). */
    private static String asStr(Object v) {
        return v == null ? null : stringify(v);
    }

    /** {@code String(v ?? "")} — a required string, defaulting to "". */
    private static String reqStr(Object v) {
        return v == null ? "" : stringify(v);
    }

    /** {@code String(v ?? fallback)} — nullish-coalesced then stringified. */
    private static String coalesceStr(Object v, String fallback) {
        return v == null ? fallback : stringify(v);
    }

    /** {@code asStrArr}: Array → map(String), else []. */
    private static List<String> asStrArr(Object v) {
        List<String> out = new ArrayList<>();
        if (v instanceof List<?> list) {
            for (Object o : list) {
                out.add(stringify(o));
            }
        }
        return out;
    }

    /** {@code asNum}: null → null, Number/String → long, NaN → null. */
    private static Long asNum(Object v) {
        if (v == null) {
            return null;
        }
        if (v instanceof Number n) {
            return n.longValue();
        }
        if (v instanceof Boolean b) {
            return b ? 1L : 0L; // JS Number(true) === 1
        }
        try {
            return (long) Double.parseDouble(v.toString().trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** An optional numeric field: null when the key is absent, else {@code asNum}. */
    private static Long optNum(Map<?, ?> m, String key) {
        return m.containsKey(key) ? asNum(m.get(key)) : null;
    }

    /**
     * Like {@code asNum}, but preserves the fraction (Double, not Long). Used for
     * currency amounts such as action_scope.spend.max_spend, where truncating
     * 4.99 to 4 would silently loosen a declared spend ceiling — unlike asNum's
     * integer fields (size_tokens, bytes, free_requests_per_day), which are
     * genuinely counts and have no meaningful fraction.
     */
    private static Double asDecimal(Object v) {
        if (v == null) {
            return null;
        }
        if (v instanceof Number n) {
            return n.doubleValue();
        }
        if (v instanceof Boolean b) {
            return b ? 1.0 : 0.0;
        }
        try {
            return Double.parseDouble(v.toString().trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /**
     * {@code v === undefined ? undefined : Boolean(v)} — the key-present-guarded
     * boolean. Absent → null; present → JS truthiness of the value.
     */
    private static Boolean optBool(Map<?, ?> m, String key) {
        return m.containsKey(key) ? truthy(m.get(key)) : null;
    }

    /** {@code normCount}: number or the literal "unlimited", else null. */
    private static RequestCount normCount(Object v) {
        if (v == null) {
            return null;
        }
        if (v instanceof String s) {
            return s.equals("unlimited") ? RequestCount.UNLIMITED : parseCount(s);
        }
        if (v instanceof Number n) {
            return new RequestCount.Limited(n.longValue());
        }
        return null;
    }

    private static RequestCount parseCount(String s) {
        try {
            return new RequestCount.Limited((long) Double.parseDouble(s.trim()));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** JS {@code String(v)} for the scalar types a YAML parser yields. */
    private static String stringify(Object v) {
        if (v == null) {
            return "null"; // JS String(null) === "null"; callers guard null before this
        }
        if (v instanceof Double d) {
            // JS String(3000) === "3000", not "3000.0": a whole double prints as an integer.
            if (d == Math.floor(d) && !d.isInfinite()) {
                return Long.toString(d.longValue());
            }
            return d.toString();
        }
        return v.toString();
    }

    /** JS {@code Boolean(v)} truthiness. */
    private static boolean truthy(Object v) {
        if (v == null) {
            return false;
        }
        if (v instanceof Boolean b) {
            return b;
        }
        if (v instanceof String s) {
            return !s.isEmpty();
        }
        if (v instanceof Number n) {
            double d = n.doubleValue();
            return d != 0.0 && !Double.isNaN(d);
        }
        return true; // objects and arrays are truthy
    }

    private static <T> List<T> mapObjects(Object v, java.util.function.Function<Map<?, ?>, T> f) {
        List<T> out = new ArrayList<>();
        if (v instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map<?, ?> map) {
                    out.add(f.apply(map));
                }
            }
        }
        return out;
    }
}

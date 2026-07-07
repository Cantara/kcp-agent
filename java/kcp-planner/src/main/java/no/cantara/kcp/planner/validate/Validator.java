package no.cantara.kcp.planner.validate;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;

import no.cantara.kcp.planner.KcpPlanner;
import no.cantara.kcp.planner.model.Manifest;
import no.cantara.kcp.planner.model.ManifestRef;
import no.cantara.kcp.planner.model.PaymentMethod;
import no.cantara.kcp.planner.model.Temporal;
import no.cantara.kcp.planner.model.Unit;

/**
 * The manifest linter — {@code kcp_validate} for {@code knowledge.yaml} publishers.
 * A faithful port of {@code src/validate.ts}. Validates the same compact model the
 * planner consumes, so "validates clean" means "this agent can navigate it".
 */
public final class Validator {

    private Validator() {
    }

    private static final Set<String> ACCESS_VALUES = Set.of("public", "authenticated", "restricted");
    private static final Pattern ISO_DATE = Pattern.compile("^\\d{4}-\\d{2}-\\d{2}([T ].*)?$");
    private static final Pattern URL_SCHEME = Pattern.compile("^[a-z][a-z0-9+.-]*:", Pattern.CASE_INSENSITIVE);
    private static final Pattern HTTPS = Pattern.compile("^https://.*");
    private static final Pattern ED25519 = Pattern.compile("^(ed25519|eddsa)$", Pattern.CASE_INSENSITIVE);

    /**
     * Validate a parsed manifest.
     *
     * @param manifest the manifest to lint
     * @param baseDir  the directory to resolve unit paths against for existence checks,
     *                 or {@code null} to skip them (e.g. for a remote manifest)
     * @return the findings, in order
     */
    public static List<Finding> validateManifest(Manifest manifest, Path baseDir) {
        List<Finding> f = new ArrayList<>();

        if (manifest.project().equals("(unnamed)")) {
            f.add(Finding.warning("manifest", "missing 'project'"));
        }
        if (manifest.version().equals("0.0.0")) {
            f.add(Finding.warning("manifest", "missing 'version'"));
        }
        if (manifest.kcpVersion() == null) {
            f.add(Finding.warning("manifest", "missing 'kcp_version' — agents cannot tell which spec revision this targets"));
        }
        if (manifest.units().isEmpty()) {
            f.add(Finding.warning("manifest", "declares no units — nothing for an agent to navigate"));
        }

        Set<String> ids = new HashSet<>();
        for (Unit unit : manifest.units()) {
            String where = "unit '" + (unit.id().isEmpty() ? "(no id)" : unit.id()) + "'";
            if (unit.id().isEmpty()) {
                f.add(Finding.error(where, "missing 'id'"));
            } else if (ids.contains(unit.id())) {
                f.add(Finding.error(where, "duplicate unit id"));
            }
            ids.add(unit.id());

            String pathProblem = unsafePath(unit.path());
            if (pathProblem != null) {
                f.add(Finding.error(where, pathProblem));
            } else if (baseDir != null && !Files.exists(baseDir.resolve(unit.path()))) {
                f.add(Finding.error(where, "path '" + unit.path() + "' does not exist"));
            }

            if (unit.intent().isEmpty()) {
                f.add(Finding.error(where, "missing 'intent' — intent is the primary navigation signal"));
            }
            if (unit.triggers().isEmpty()) {
                f.add(Finding.warning(where, "no 'triggers' — unit is only findable through its intent text"));
            }
            if (unit.audience().isEmpty()) {
                f.add(Finding.warning(where, "no 'audience' — declare who this unit serves (e.g. [agent, human])"));
            }
            if (unit.access() != null && !ACCESS_VALUES.contains(unit.access())) {
                f.add(Finding.warning(where, "unknown access '" + unit.access() + "' (expected public/authenticated/restricted)"));
            }
            validateTemporal(unit, where, f);
            validateNotFor(unit, where, f);
            if (unit.payment() != null && unit.payment().methods() != null) {
                for (PaymentMethod m : unit.payment().methods()) {
                    if (m.type() == null || m.type().isEmpty()) {
                        f.add(Finding.error(where, "payment method missing 'type'"));
                    }
                    if ("x402".equals(m.type()) && (m.pricePerRequest() == null || m.currency() == null)) {
                        f.add(Finding.warning(where, "x402 payment method should declare 'price_per_request' and 'currency'"));
                    }
                }
            }
        }
        // superseded_by references are checked after all ids are collected
        for (Unit unit : manifest.units()) {
            String succ = unit.temporal() != null ? unit.temporal().supersededBy() : null;
            if (succ != null && !ids.contains(succ)) {
                f.add(Finding.error("unit '" + unit.id() + "'",
                        "temporal.superseded_by references unknown unit '" + succ + "'"));
            }
        }

        Set<String> refIds = new HashSet<>();
        for (ManifestRef ref : manifest.manifests()) {
            String where = "manifest ref '" + (ref.id().isEmpty() ? "(no id)" : ref.id()) + "'";
            if (ref.id().isEmpty()) {
                f.add(Finding.error(where, "missing 'id'"));
            } else if (refIds.contains(ref.id())) {
                f.add(Finding.error(where, "duplicate manifest ref id"));
            }
            refIds.add(ref.id());
            if (ref.url().isEmpty()) {
                f.add(Finding.error(where, "missing 'url'"));
            } else if (!HTTPS.matcher(ref.url()).matches()) {
                f.add(Finding.warning(where, "url is not https — agents should fetch federation over TLS"));
            }
            if (ref.agentIdentity() != null && Boolean.TRUE.equals(ref.agentIdentity().required())
                    && ref.agentIdentity().credentialHint() == null) {
                f.add(Finding.warning(where, "agent_identity.required without 'credential_hint' — agents cannot plan credential acquisition"));
            }
        }

        if (manifest.trust() != null && manifest.trust().agentRequirements() != null) {
            var ar = manifest.trust().agentRequirements();
            boolean requires = Boolean.TRUE.equals(ar.requireAttestation());
            boolean noProviders = ar.trustedProviders() == null || ar.trustedProviders().isEmpty();
            if (requires && noProviders) {
                f.add(Finding.error("manifest",
                        "require_attestation with no trusted_providers — no agent can ever qualify (permanently fail-closed)"));
            }
        }

        if (manifest.signing() != null && manifest.signing().scheme() != null
                && !ED25519.matcher(manifest.signing().scheme()).matches()) {
            f.add(Finding.warning("manifest",
                    "signing scheme '" + manifest.signing().scheme() + "' is not one this agent can verify (ed25519)"));
        }

        return f;
    }

    /** Validate a manifest that has already been loaded (parsed + located). */
    public static ValidationReport report(Manifest manifest, String source, Path baseDir) {
        List<Finding> findings = validateManifest(manifest, baseDir);
        boolean ok = findings.stream().noneMatch(x -> x.level().equals("error"));
        return new ValidationReport(source, manifest.project(), findings, ok);
    }

    private static void validateTemporal(Unit unit, String where, List<Finding> f) {
        Temporal t = unit.temporal();
        if (t == null) {
            return;
        }
        if (t.validFrom() != null && !ISO_DATE.matcher(t.validFrom()).matches()) {
            f.add(Finding.error(where, "temporal.valid_from '" + t.validFrom() + "' is not an ISO date"));
        }
        if (t.validUntil() != null && !ISO_DATE.matcher(t.validUntil()).matches()) {
            f.add(Finding.error(where, "temporal.valid_until '" + t.validUntil() + "' is not an ISO date"));
        }
        if (t.validFrom() != null && t.validUntil() != null && t.validUntil().compareTo(t.validFrom()) < 0) {
            f.add(Finding.error(where, "temporal window ends (" + t.validUntil() + ") before it starts (" + t.validFrom() + ")"));
        }
        String today = LocalDate.now(ZoneOffset.UTC).toString();
        if (t.validUntil() != null && ISO_DATE.matcher(t.validUntil()).matches()
                && t.validUntil().compareTo(today) < 0 && t.supersededBy() == null) {
            f.add(Finding.warning(where, "expired " + t.validUntil() + " with no 'superseded_by' — agents get a dead end instead of a successor"));
        }
    }

    private static void validateNotFor(Unit unit, String where, List<Finding> f) {
        List<String> notFor = unit.notFor();
        if (notFor.isEmpty()) {
            return;
        }
        Set<String> vocabulary = new LinkedHashSet<>(KcpPlanner.terms(unit.intent()));
        for (String tr : unit.triggers()) {
            vocabulary.addAll(KcpPlanner.terms(tr));
        }
        for (String nf : notFor) {
            String entry = nf.toLowerCase(Locale.ROOT);
            Set<String> hits = new TreeSet<>();
            for (String v : vocabulary) {
                if (entry.contains(v)) {
                    hits.add(v);
                }
            }
            if (!hits.isEmpty()) {
                f.add(Finding.warning(where, "not_for '" + nf + "' contains the unit's own vocabulary ("
                        + String.join(", ", hits) + ") — term matching will gate this unit against its most natural "
                        + "questions; name the excluded topic in its own words (e.g. \"CCPA\", \"accounting\"), never "
                        + "as a negation of this unit's topic (\"non-X\", \"outside X\")"));
            }
        }
    }

    /** Reject a unit path that is empty, a URL, absolute, or traversing; else {@code null}. */
    private static String unsafePath(String path) {
        if (path.isEmpty()) {
            return "path is empty";
        }
        if (URL_SCHEME.matcher(path).find() || path.startsWith("//")) {
            return "path must be relative, not a URL";
        }
        if (Path.of(path).isAbsolute()) {
            return "path must be relative, not absolute";
        }
        if (Arrays.asList(path.split("/")).contains("..")) {
            return "path must not traverse with '..'";
        }
        return null;
    }
}

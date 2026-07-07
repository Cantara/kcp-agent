package no.cantara.kcp.planner.conformance;

import java.io.IOException;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import no.cantara.kcp.planner.AgentPlan;
import no.cantara.kcp.planner.BudgetPlan;
import no.cantara.kcp.planner.ContextPlan;
import no.cantara.kcp.planner.FederationPlan;
import no.cantara.kcp.planner.KcpPlanner;
import no.cantara.kcp.planner.ManifestParser;
import no.cantara.kcp.planner.PlanOptions;
import no.cantara.kcp.planner.PlannedUnit;
import no.cantara.kcp.planner.SkippedUnit;
import no.cantara.kcp.planner.model.Manifest;

import org.snakeyaml.engine.v2.api.Load;
import org.snakeyaml.engine.v2.api.LoadSettings;

/**
 * The conformance harness — a Java port of {@code src/vectors.ts}. A vector is
 * {@code (manifest, task, options) → expected outcome}; a conformant implementation
 * reproduces every vector's {@code expect} exactly. {@link VectorOutcome} is the
 * portable projection of a plan, compared structurally.
 *
 * <p>Numeric fields are normalized so the comparison is value-based: money to
 * {@code double} (both sides via {@code doubleValue}/{@code Number.doubleValue}),
 * tokens and scores to {@code long}. The vectors' English skip/federation reasons
 * are the "every decision is a sentence" contract and are compared verbatim.</p>
 */
public final class ConformanceVectors {

    private ConformanceVectors() {
    }

    /** A selected unit, projected to its portable fields. */
    public record SelectedOutcome(String id, boolean loadEligible, long score) {
    }

    /** A skipped unit and its verbatim reason. */
    public record SkippedOutcome(String id, String reason) {
    }

    /** A federation decision, projected to its portable fields. */
    public record FederationOutcome(String id, boolean selected, String reason, String credentialNeeded) {
    }

    /** The manifest-level attestation posture. */
    public record TrustOutcome(boolean requiresAttestation, boolean agentCanAttest) {
    }

    /** The economic projection (money as {@code Double}, {@code null} when unset). */
    public record BudgetOutcome(String rateTier, Double ceiling, Double projectedSpend, Double remaining,
            String currency) {
    }

    /** The context-window projection (tokens as {@code Long}, {@code null} when unset). */
    public record ContextOutcome(Long ceiling, Long projectedTokens, Long remaining, boolean approximate,
            long unmeasured) {
    }

    /** The portable, implementation-agnostic result a conformant planner must reproduce. */
    public record VectorOutcome(List<SelectedOutcome> selected, List<SkippedOutcome> skipped,
            List<FederationOutcome> federation, TrustOutcome trust, BudgetOutcome budget,
            ContextOutcome context, List<String> warnings) {
    }

    /** A single conformance fixture: inputs + the expected outcome. */
    public record ConformanceVector(String name, String manifest, String task, PlanOptions options,
            VectorOutcome expect) {
    }

    /** Project a full plan down to its portable, comparable outcome. */
    public static VectorOutcome outcomeOf(AgentPlan p) {
        List<SelectedOutcome> selected = new ArrayList<>();
        for (PlannedUnit u : p.selected()) {
            selected.add(new SelectedOutcome(u.id(), u.loadEligible(), u.score()));
        }
        List<SkippedOutcome> skipped = new ArrayList<>();
        for (SkippedUnit s : p.skipped()) {
            skipped.add(new SkippedOutcome(s.id(), s.reason()));
        }
        List<FederationOutcome> federation = new ArrayList<>();
        for (FederationPlan f : p.federation()) {
            federation.add(new FederationOutcome(f.id(), f.selected(), f.reason(), f.credentialNeeded()));
        }
        BudgetPlan b = p.budget();
        BudgetOutcome budget = new BudgetOutcome(
                b.rateTier(),
                toDouble(b.ceiling()),
                toDouble(b.projectedSpend()),
                toDouble(b.remaining()),
                b.currency());
        ContextPlan c = p.context();
        ContextOutcome context = new ContextOutcome(
                c.ceiling(), c.projectedTokens(), c.remaining(), c.approximate(), c.unmeasured());
        return new VectorOutcome(selected, skipped, federation,
                new TrustOutcome(p.trust().requiresAttestation(), p.trust().agentCanAttest()),
                budget, context, p.warnings());
    }

    /** Parse a vector's manifest, run the planner, and return the outcome. */
    public static VectorOutcome runVector(ConformanceVector v) {
        Manifest manifest = ManifestParser.parse(v.manifest(), v.name());
        return outcomeOf(KcpPlanner.plan(manifest, v.task(), v.options()));
    }

    private static Double toDouble(BigDecimal b) {
        return b == null ? null : b.doubleValue();
    }

    // --- loading + JSON extraction (via the YAML 1.2 engine — JSON is a subset) ---

    /** Locate the repo-root {@code vectors/} directory by walking up from the working dir. */
    public static Path vectorsDir() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null) {
            Path v = dir.resolve("vectors");
            if (Files.isDirectory(v)) {
                try (Stream<Path> s = Files.list(v)) {
                    if (s.anyMatch(p -> p.getFileName().toString().endsWith(".json"))) {
                        return v;
                    }
                } catch (IOException ignored) {
                    // keep walking up
                }
            }
            dir = dir.getParent();
        }
        throw new IllegalStateException("could not locate the vectors/ directory");
    }

    /** Load every {@code vectors/*.json}, sorted by filename. */
    public static List<Map.Entry<String, ConformanceVector>> load() {
        Path dir = vectorsDir();
        List<Path> files;
        try (Stream<Path> s = Files.list(dir)) {
            files = s.filter(p -> p.getFileName().toString().endsWith(".json"))
                    .sorted()
                    .collect(Collectors.toList());
        } catch (IOException e) {
            throw new IllegalStateException("listing " + dir, e);
        }
        List<Map.Entry<String, ConformanceVector>> out = new ArrayList<>();
        for (Path f : files) {
            String text;
            try {
                text = Files.readString(f);
            } catch (IOException e) {
                throw new IllegalStateException("reading " + f, e);
            }
            out.add(Map.entry(f.getFileName().toString(), parseVector(text)));
        }
        return out;
    }

    private static ConformanceVector parseVector(String json) {
        Object raw = new Load(LoadSettings.builder().build()).loadFromString(json);
        Map<?, ?> m = (Map<?, ?>) raw;
        return new ConformanceVector(
                str(m.get("name")),
                str(m.get("manifest")),
                str(m.get("task")),
                parseOptions(asMap(m.get("options"))),
                parseExpect(asMap(m.get("expect"))));
    }

    /** Parse a JSON (or YAML) string into a generic object tree. */
    public static Object parseJson(String text) {
        return new Load(LoadSettings.builder().build()).loadFromString(text);
    }

    /** Build {@link PlanOptions} from a parsed options map (shared with the trace/diff harness). */
    public static PlanOptions optionsFromMap(Map<?, ?> o) {
        return parseOptions(o);
    }

    private static PlanOptions parseOptions(Map<?, ?> o) {
        PlanOptions.Builder b = PlanOptions.builder();
        if (o == null) {
            return b.build();
        }
        Map<?, ?> caps = asMap(o.get("capabilities"));
        if (caps != null) {
            if (caps.get("role") != null) {
                b.role(str(caps.get("role")));
            }
            if (caps.get("paymentMethods") != null) {
                b.paymentMethods(strList(caps.get("paymentMethods")));
            }
            if (caps.get("credentials") != null) {
                b.credentials(strList(caps.get("credentials")));
            }
            if (caps.get("attestationProvider") != null) {
                b.attestationProvider(str(caps.get("attestationProvider")));
            }
        }
        if (o.get("env") != null) {
            b.env(str(o.get("env")));
        }
        if (o.get("asOf") != null) {
            b.asOf(str(o.get("asOf")));
        }
        if (o.get("maxUnits") != null) {
            b.maxUnits(num(o.get("maxUnits")).intValue());
        }
        if (o.get("strict") != null) {
            b.strict(Boolean.TRUE.equals(o.get("strict")));
        }
        if (o.get("contextBudget") != null) {
            b.contextBudget(num(o.get("contextBudget")).intValue());
        }
        Map<?, ?> budget = asMap(o.get("budget"));
        if (budget != null) {
            double amount = num(budget.get("amount")).doubleValue();
            String currency = budget.get("currency") != null ? str(budget.get("currency")) : null;
            Double spent = budget.get("spent") != null ? num(budget.get("spent")).doubleValue() : null;
            b.budget(new PlanOptions.Budget(amount, currency, spent));
        }
        return b.build();
    }

    private static VectorOutcome parseExpect(Map<?, ?> e) {
        List<SelectedOutcome> selected = new ArrayList<>();
        for (Object o : asList(e.get("selected"))) {
            Map<?, ?> s = asMap(o);
            selected.add(new SelectedOutcome(str(s.get("id")), bool(s.get("loadEligible")), num(s.get("score")).longValue()));
        }
        List<SkippedOutcome> skipped = new ArrayList<>();
        for (Object o : asList(e.get("skipped"))) {
            Map<?, ?> s = asMap(o);
            skipped.add(new SkippedOutcome(str(s.get("id")), str(s.get("reason"))));
        }
        List<FederationOutcome> federation = new ArrayList<>();
        for (Object o : asList(e.get("federation"))) {
            Map<?, ?> f = asMap(o);
            String cred = f.get("credentialNeeded") != null ? str(f.get("credentialNeeded")) : null;
            federation.add(new FederationOutcome(str(f.get("id")), bool(f.get("selected")), str(f.get("reason")), cred));
        }
        Map<?, ?> t = asMap(e.get("trust"));
        TrustOutcome trust = new TrustOutcome(bool(t.get("requiresAttestation")), bool(t.get("agentCanAttest")));
        Map<?, ?> bd = asMap(e.get("budget"));
        BudgetOutcome budget = new BudgetOutcome(
                str(bd.get("rateTier")),
                optDouble(bd.get("ceiling")),
                optDouble(bd.get("projectedSpend")),
                optDouble(bd.get("remaining")),
                bd.get("currency") != null ? str(bd.get("currency")) : null);
        Map<?, ?> cx = asMap(e.get("context"));
        ContextOutcome context = new ContextOutcome(
                optLong(cx.get("ceiling")),
                optLong(cx.get("projectedTokens")),
                optLong(cx.get("remaining")),
                bool(cx.get("approximate")),
                num(cx.get("unmeasured")).longValue());
        return new VectorOutcome(selected, skipped, federation, trust, budget, context, strList(e.get("warnings")));
    }

    // --- scalar coercions ---

    private static String str(Object v) {
        return v == null ? null : v.toString();
    }

    private static Number num(Object v) {
        return (Number) v;
    }

    private static boolean bool(Object v) {
        return Boolean.TRUE.equals(v);
    }

    private static Double optDouble(Object v) {
        return v == null ? null : ((Number) v).doubleValue();
    }

    private static Long optLong(Object v) {
        return v == null ? null : ((Number) v).longValue();
    }

    private static Map<?, ?> asMap(Object v) {
        return v instanceof Map<?, ?> m ? m : null;
    }

    private static List<?> asList(Object v) {
        return v instanceof List<?> l ? l : List.of();
    }

    private static List<String> strList(Object v) {
        List<String> out = new ArrayList<>();
        for (Object o : asList(v)) {
            out.add(o == null ? null : o.toString());
        }
        return out;
    }
}

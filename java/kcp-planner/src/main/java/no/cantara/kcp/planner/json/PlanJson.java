package no.cantara.kcp.planner.json;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import no.cantara.kcp.planner.AgentCapabilities;
import no.cantara.kcp.planner.AgentPlan;
import no.cantara.kcp.planner.BudgetPlan;
import no.cantara.kcp.planner.ContextPlan;
import no.cantara.kcp.planner.FederationPlan;
import no.cantara.kcp.planner.PlanOptions;
import no.cantara.kcp.planner.PlannedUnit;
import no.cantara.kcp.planner.SkippedUnit;
import no.cantara.kcp.planner.model.RequestCount;

/**
 * Serializes an {@link AgentPlan} to the exact JSON the TypeScript reference emits
 * (field order, JS number formatting, optional-field omission). This is the value a
 * saved plan artifact and the {@code kcp_plan} MCP tool carry. A port of the
 * plan-serialization logic in {@code src/planner.ts}'s object shape.
 *
 * <p>The {@code options} echo (capabilities, maxUnits, strict, budget, contextBudget)
 * is reconstructed from the {@link PlanOptions} the plan was computed with — the pure
 * {@link AgentPlan} does not retain it. The loader-added {@code manifest.sha256} and
 * {@code signature} are attached by the client layer, not here.</p>
 */
public final class PlanJson {

    private PlanJson() {
    }

    /** Serialize a plan (with the options it was computed from) to pretty JSON. */
    public static String toJson(AgentPlan p, PlanOptions options) {
        return Json.write(toValue(p, options));
    }

    /** Build the ordered value tree for an {@link AgentPlan}. */
    public static Map<String, Object> toValue(AgentPlan p, PlanOptions options) {
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("task", p.task());

        Map<String, Object> manifest = new LinkedHashMap<>();
        manifest.put("project", p.manifest().project());
        manifest.put("version", p.manifest().version());
        putIfNotNull(manifest, "kcpVersion", p.manifest().kcpVersion());
        putIfNotNull(manifest, "source", p.manifest().source());
        root.put("manifest", manifest);

        Map<String, Object> trust = new LinkedHashMap<>();
        trust.put("requiresAttestation", p.trust().requiresAttestation());
        trust.put("agentCanAttest", p.trust().agentCanAttest());
        trust.put("note", p.trust().note());
        root.put("trust", trust);

        putIfNotNull(root, "environment", p.environment());
        root.put("asOf", p.asOf());
        root.put("options", optionsValue(options));

        List<Object> selected = new ArrayList<>();
        for (PlannedUnit u : p.selected()) {
            selected.add(unitValue(u));
        }
        root.put("selected", selected);

        List<Object> skipped = new ArrayList<>();
        for (SkippedUnit s : p.skipped()) {
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("id", s.id());
            o.put("reason", s.reason());
            skipped.add(o);
        }
        root.put("skipped", skipped);

        List<Object> federation = new ArrayList<>();
        for (FederationPlan f : p.federation()) {
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("id", f.id());
            o.put("url", f.url());
            o.put("selected", f.selected());
            o.put("reason", f.reason());
            putIfNotNull(o, "credentialNeeded", f.credentialNeeded());
            putIfNotNull(o, "docsUrl", f.docsUrl());
            federation.add(o);
        }
        root.put("federation", federation);

        root.put("budget", budgetValue(p.budget()));
        root.put("context", contextValue(p.context()));
        root.put("warnings", new ArrayList<Object>(p.warnings()));
        return root;
    }

    private static Map<String, Object> optionsValue(PlanOptions options) {
        AgentCapabilities caps = options.capabilities();
        Map<String, Object> capsV = new LinkedHashMap<>();
        capsV.put("role", caps.role());
        capsV.put("paymentMethods", new ArrayList<Object>(caps.paymentMethods()));
        capsV.put("credentials", new ArrayList<Object>(caps.credentials()));
        putIfNotNull(capsV, "attestationProvider", caps.attestationProvider());

        Map<String, Object> o = new LinkedHashMap<>();
        o.put("capabilities", capsV);
        o.put("maxUnits", (long) options.maxUnits());
        o.put("strict", options.strict());
        if (options.budget() != null) {
            PlanOptions.Budget b = options.budget();
            Map<String, Object> budget = new LinkedHashMap<>();
            budget.put("amount", b.amount());
            putIfNotNull(budget, "currency", b.currency());
            putIfNotNull(budget, "spent", b.spent());
            o.put("budget", budget);
        }
        if (options.contextBudget() != null) {
            o.put("contextBudget", (long) options.contextBudget());
        }
        return o;
    }

    private static Map<String, Object> unitValue(PlannedUnit u) {
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("id", u.id());
        o.put("path", u.path());
        o.put("intent", u.intent());
        o.put("score", (long) u.score());
        o.put("reasons", new ArrayList<Object>(u.reasons()));
        Map<String, Object> pay = new LinkedHashMap<>();
        pay.put("method", u.payment().method());
        putIfNotNull(pay, "cost", u.payment().cost());
        putIfNotNull(pay, "pricePerRequest", u.payment().pricePerRequest());
        putIfNotNull(pay, "currency", u.payment().currency());
        pay.put("affordable", u.payment().affordable());
        o.put("payment", pay);
        o.put("requiresAttestation", u.requiresAttestation());
        o.put("loadEligible", u.loadEligible());
        return o;
    }

    private static Map<String, Object> budgetValue(BudgetPlan b) {
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("rateTier", b.rateTier());
        if (b.requestsPerMinute() != null) {
            o.put("requestsPerMinute", requestCount(b.requestsPerMinute()));
        }
        List<Object> costs = new ArrayList<>();
        for (BudgetPlan.PerRequestCost c : b.perRequestCosts()) {
            Map<String, Object> cv = new LinkedHashMap<>();
            cv.put("unit", c.unit());
            cv.put("cost", c.cost());
            costs.add(cv);
        }
        o.put("perRequestCosts", costs);
        putIfNotNull(o, "ceiling", b.ceiling());
        putIfNotNull(o, "currency", b.currency());
        putIfNotNull(o, "alreadyCommitted", b.alreadyCommitted());
        putIfNotNull(o, "projectedSpend", b.projectedSpend());
        putIfNotNull(o, "remaining", b.remaining());
        o.put("note", b.note());
        return o;
    }

    private static Map<String, Object> contextValue(ContextPlan c) {
        Map<String, Object> o = new LinkedHashMap<>();
        putIfNotNull(o, "ceiling", c.ceiling());
        putIfNotNull(o, "projectedTokens", c.projectedTokens());
        putIfNotNull(o, "remaining", c.remaining());
        o.put("approximate", c.approximate());
        o.put("unmeasured", (long) c.unmeasured());
        o.put("note", c.note());
        return o;
    }

    private static Object requestCount(RequestCount rc) {
        return rc instanceof RequestCount.Limited l ? (Object) l.value() : "unlimited";
    }

    private static void putIfNotNull(Map<String, Object> m, String key, Object value) {
        if (value != null) {
            m.put(key, value);
        }
    }
}

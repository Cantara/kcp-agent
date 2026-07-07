package no.cantara.kcp.planner.json;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import no.cantara.kcp.planner.AgentCapabilities;
import no.cantara.kcp.planner.PlanOptions;
import no.cantara.kcp.planner.trace.DecisionTrace;
import no.cantara.kcp.planner.trace.GateVerdict;
import no.cantara.kcp.planner.trace.UnitTrace;

/**
 * Serializes a {@link DecisionTrace} to the exact JSON the TypeScript reference
 * emits — the value the {@code kcp_trace} MCP tool returns: the task, its terms, the
 * resolved capabilities, the embedded canonical plan, one annotated trace per unit,
 * and the per-gate summary. A port of the trace object shape in {@code src/trace.ts}.
 */
public final class TraceJson {

    private TraceJson() {
    }

    /** Serialize a decision trace (with the options it was computed from) to pretty JSON. */
    public static String toJson(DecisionTrace t, PlanOptions options) {
        return Json.write(toValue(t, options));
    }

    /** Build the ordered value tree for a {@link DecisionTrace}. */
    public static Map<String, Object> toValue(DecisionTrace t, PlanOptions options) {
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("task", t.task());
        root.put("taskTerms", new ArrayList<Object>(t.taskTerms()));
        root.put("asOf", t.asOf());
        root.put("capabilities", capsValue(t.capabilities()));
        root.put("plan", PlanJson.toValue(t.plan(), options));

        List<Object> units = new ArrayList<>();
        for (UnitTrace u : t.units()) {
            units.add(unitValue(u));
        }
        root.put("units", units);

        List<Object> summary = new ArrayList<>();
        for (DecisionTrace.GateCount g : t.gateSummary()) {
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("gate", g.gate().wire());
            o.put("passed", (long) g.passed());
            o.put("failed", (long) g.failed());
            summary.add(o);
        }
        root.put("gateSummary", summary);
        return root;
    }

    private static Map<String, Object> capsValue(AgentCapabilities caps) {
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("role", caps.role());
        o.put("paymentMethods", new ArrayList<Object>(caps.paymentMethods()));
        o.put("credentials", new ArrayList<Object>(caps.credentials()));
        if (caps.attestationProvider() != null) {
            o.put("attestationProvider", caps.attestationProvider());
        }
        return o;
    }

    private static Map<String, Object> unitValue(UnitTrace u) {
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("id", u.id());
        o.put("path", u.path());
        o.put("intent", u.intent());
        o.put("outcome", u.outcome());

        List<Object> gates = new ArrayList<>();
        for (GateVerdict g : u.gates()) {
            Map<String, Object> gv = new LinkedHashMap<>();
            gv.put("gate", g.gate().wire());
            gv.put("passed", g.passed());
            gv.put("detail", g.detail());
            gates.add(gv);
        }
        o.put("gates", gates);

        if (u.rejectedBy() != null) {
            o.put("rejectedBy", u.rejectedBy().wire());
        }
        if (u.score() != null) {
            o.put("score", u.score());
        }
        if (u.tokens() != null) {
            Map<String, Object> tk = new LinkedHashMap<>();
            if (u.tokens().value() != null) {
                tk.put("value", u.tokens().value());
            }
            tk.put("source", u.tokens().source());
            o.put("tokens", tk);
        }
        if (u.cost() != null) {
            Map<String, Object> co = new LinkedHashMap<>();
            co.put("amount", u.cost().amount());
            if (u.cost().currency() != null) {
                co.put("currency", u.cost().currency());
            }
            co.put("method", u.cost().method());
            o.put("cost", co);
        }
        return o;
    }
}

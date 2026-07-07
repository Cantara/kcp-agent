package no.cantara.kcp.planner.conformance;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import no.cantara.kcp.planner.AgentCapabilities;
import no.cantara.kcp.planner.KcpPlanner;
import no.cantara.kcp.planner.ManifestParser;
import no.cantara.kcp.planner.PlanOptions;
import no.cantara.kcp.planner.diff.BudgetShift;
import no.cantara.kcp.planner.diff.PlanDiff;
import no.cantara.kcp.planner.diff.ReasonChange;
import no.cantara.kcp.planner.diff.ScoreChange;
import no.cantara.kcp.planner.diff.UnitMove;
import no.cantara.kcp.planner.diff.UnitPresence;
import no.cantara.kcp.planner.model.Manifest;
import no.cantara.kcp.planner.trace.DecisionTrace;
import no.cantara.kcp.planner.trace.GateName;
import no.cantara.kcp.planner.trace.GateVerdict;
import no.cantara.kcp.planner.trace.UnitTrace;

import org.junit.jupiter.api.Test;

/**
 * Decision-trace and plan-diff conformance. The golden fixtures under
 * {@code fixtures/trace} and {@code fixtures/diff} were generated from the
 * TypeScript reference (the same "freeze the reference behavior as data" approach
 * as the plan vectors). Each is run through {@code KcpPlanner.trace} /
 * {@code KcpPlanner.diffPlans} and deep-equaled against its expected projection —
 * per-gate verdicts, detail strings and all — so the Java trace/diff reproduces
 * the reference exactly.
 */
class TraceDiffConformanceTest {

    /** The comparable projection of a trace (the canonical plan is omitted; it's vector-tested). */
    record TraceOutcome(List<String> taskTerms, String asOf, AgentCapabilities capabilities,
            List<UnitTrace> units, List<DecisionTrace.GateCount> gateSummary) {
    }

    @Test
    void allTraceFixturesPass() throws Exception {
        List<String> failures = new ArrayList<>();
        List<Path> files = fixtureFiles("trace");
        assertTrue(files.size() >= 10, "expected >= 10 trace fixtures, found " + files.size());
        for (Path f : files) {
            Map<?, ?> fx = (Map<?, ?>) ConformanceVectors.parseJson(Files.readString(f));
            TraceOutcome actual = actualTrace(fx);
            TraceOutcome expected = expectedTrace(asMap(fx.get("expect")));
            if (!actual.equals(expected)) {
                failures.add("\n=== " + str(fx.get("name")) + " ===\n  expected: " + expected + "\n  actual:   " + actual);
            }
        }
        assertTrue(failures.isEmpty(), failures.size() + " trace fixture(s) failed:" + String.join("", failures));
    }

    @Test
    void allDiffFixturesPass() throws Exception {
        List<String> failures = new ArrayList<>();
        List<Path> files = fixtureFiles("diff");
        assertTrue(files.size() >= 4, "expected >= 4 diff fixtures, found " + files.size());
        for (Path f : files) {
            Map<?, ?> fx = (Map<?, ?>) ConformanceVectors.parseJson(Files.readString(f));
            PlanDiff actual = actualDiff(fx);
            PlanDiff expected = expectedDiff(asMap(fx.get("expect")));
            if (!actual.equals(expected)) {
                failures.add("\n=== " + str(fx.get("name")) + " ===\n  expected: " + expected + "\n  actual:   " + actual);
            }
        }
        assertTrue(failures.isEmpty(), failures.size() + " diff fixture(s) failed:" + String.join("", failures));
    }

    // --- actual (run the planner) ---

    private static TraceOutcome actualTrace(Map<?, ?> fx) {
        Manifest m = ManifestParser.parse(str(fx.get("manifest")), str(fx.get("name")));
        PlanOptions opts = ConformanceVectors.optionsFromMap(asMap(fx.get("options")));
        DecisionTrace t = KcpPlanner.trace(m, str(fx.get("task")), opts);
        return new TraceOutcome(t.taskTerms(), t.asOf(), t.capabilities(), t.units(), t.gateSummary());
    }

    private static PlanDiff actualDiff(Map<?, ?> fx) {
        Manifest m = ManifestParser.parse(str(fx.get("manifest")), str(fx.get("name")));
        String task = str(fx.get("task"));
        PlanOptions a = ConformanceVectors.optionsFromMap(asMap(fx.get("a")));
        PlanOptions b = ConformanceVectors.optionsFromMap(asMap(fx.get("b")));
        return KcpPlanner.diffPlans(KcpPlanner.plan(m, task, a), KcpPlanner.plan(m, task, b));
    }

    // --- expected (extract from the fixture JSON) ---

    private static TraceOutcome expectedTrace(Map<?, ?> e) {
        AgentCapabilities caps = capabilitiesFrom(asMap(e.get("capabilities")));
        List<UnitTrace> units = new ArrayList<>();
        for (Object o : asList(e.get("units"))) {
            units.add(unitTraceFrom(asMap(o)));
        }
        List<DecisionTrace.GateCount> gateSummary = new ArrayList<>();
        for (Object o : asList(e.get("gateSummary"))) {
            Map<?, ?> g = asMap(o);
            gateSummary.add(new DecisionTrace.GateCount(
                    GateName.fromWire(str(g.get("gate"))), num(g.get("passed")).intValue(), num(g.get("failed")).intValue()));
        }
        return new TraceOutcome(strList(e.get("taskTerms")), str(e.get("asOf")), caps, units, gateSummary);
    }

    private static AgentCapabilities capabilitiesFrom(Map<?, ?> c) {
        String attest = c.get("attestationProvider") != null ? str(c.get("attestationProvider")) : null;
        return new AgentCapabilities(str(c.get("role")), strList(c.get("paymentMethods")),
                strList(c.get("credentials")), attest);
    }

    private static UnitTrace unitTraceFrom(Map<?, ?> u) {
        List<GateVerdict> gates = new ArrayList<>();
        for (Object o : asList(u.get("gates"))) {
            Map<?, ?> g = asMap(o);
            gates.add(new GateVerdict(GateName.fromWire(str(g.get("gate"))), bool(g.get("passed")), str(g.get("detail"))));
        }
        GateName rejectedBy = u.get("rejectedBy") != null ? GateName.fromWire(str(u.get("rejectedBy"))) : null;
        Integer score = u.get("score") != null ? num(u.get("score")).intValue() : null;
        UnitTrace.Tokens tokens = null;
        if (u.get("tokens") != null) {
            Map<?, ?> t = asMap(u.get("tokens"));
            Long value = t.get("value") != null ? num(t.get("value")).longValue() : null;
            tokens = new UnitTrace.Tokens(value, str(t.get("source")));
        }
        UnitTrace.Cost cost = null;
        if (u.get("cost") != null) {
            Map<?, ?> co = asMap(u.get("cost"));
            String currency = co.get("currency") != null ? str(co.get("currency")) : null;
            cost = new UnitTrace.Cost(num(co.get("amount")).doubleValue(), currency, str(co.get("method")));
        }
        return new UnitTrace(str(u.get("id")), str(u.get("path")), str(u.get("intent")), str(u.get("outcome")),
                gates, rejectedBy, score, tokens, cost);
    }

    private static PlanDiff expectedDiff(Map<?, ?> e) {
        List<UnitMove> moves = new ArrayList<>();
        for (Object o : asList(e.get("moves"))) {
            Map<?, ?> mv = asMap(o);
            moves.add(new UnitMove(str(mv.get("id")), str(mv.get("direction")),
                    moveSideFrom(asMap(mv.get("from"))), moveSideFrom(asMap(mv.get("to")))));
        }
        List<ScoreChange> scoreChanges = new ArrayList<>();
        for (Object o : asList(e.get("scoreChanges"))) {
            Map<?, ?> s = asMap(o);
            scoreChanges.add(new ScoreChange(str(s.get("id")), num(s.get("before")).intValue(),
                    num(s.get("after")).intValue(), num(s.get("delta")).intValue()));
        }
        List<UnitPresence> presence = new ArrayList<>();
        for (Object o : asList(e.get("presence"))) {
            Map<?, ?> pr = asMap(o);
            presence.add(new UnitPresence(str(pr.get("id")), str(pr.get("side"))));
        }
        List<BudgetShift> budgetShifts = new ArrayList<>();
        for (Object o : asList(e.get("budgetShifts"))) {
            Map<?, ?> bs = asMap(o);
            budgetShifts.add(new BudgetShift(str(bs.get("field")), optDouble(bs.get("before")), optDouble(bs.get("after"))));
        }
        List<ReasonChange> reasonChanges = new ArrayList<>();
        for (Object o : asList(e.get("reasonChanges"))) {
            Map<?, ?> rc = asMap(o);
            reasonChanges.add(new ReasonChange(str(rc.get("id")), str(rc.get("before")), str(rc.get("after"))));
        }
        Map<?, ?> wc = asMap(e.get("warningChanges"));
        PlanDiff.WarningChanges warningChanges = new PlanDiff.WarningChanges(strList(wc.get("added")), strList(wc.get("removed")));
        return new PlanDiff(diffEndFrom(asMap(e.get("a"))), diffEndFrom(asMap(e.get("b"))),
                bool(e.get("identical")), moves, scoreChanges, presence, budgetShifts, reasonChanges, warningChanges);
    }

    private static UnitMove.MoveSide moveSideFrom(Map<?, ?> s) {
        Integer score = s.get("score") != null ? num(s.get("score")).intValue() : null;
        String reason = s.get("reason") != null ? str(s.get("reason")) : null;
        return new UnitMove.MoveSide(score, reason);
    }

    private static PlanDiff.DiffEnd diffEndFrom(Map<?, ?> d) {
        return new PlanDiff.DiffEnd(str(d.get("project")), str(d.get("version")), str(d.get("task")), str(d.get("asOf")));
    }

    // --- fixtures + coercions ---

    private static List<Path> fixtureFiles(String kind) throws Exception {
        URL url = TraceDiffConformanceTest.class.getClassLoader().getResource("fixtures/" + kind);
        if (url == null) {
            throw new IllegalStateException("missing test resource: fixtures/" + kind);
        }
        Path dir = Paths.get(url.toURI());
        try (Stream<Path> s = Files.list(dir)) {
            return s.filter(p -> p.getFileName().toString().endsWith(".json")).sorted().collect(Collectors.toList());
        }
    }

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

    private static Map<?, ?> asMap(Object v) {
        return v instanceof Map<?, ?> m ? m : Map.of();
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

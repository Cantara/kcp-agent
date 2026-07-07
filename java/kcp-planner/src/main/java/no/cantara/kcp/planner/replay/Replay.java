package no.cantara.kcp.planner.replay;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import no.cantara.kcp.planner.AgentPlan;
import no.cantara.kcp.planner.KcpPlanner;
import no.cantara.kcp.planner.PlanOptions;
import no.cantara.kcp.planner.client.LoadedManifest;
import no.cantara.kcp.planner.client.ManifestClient;
import no.cantara.kcp.planner.json.Json;
import no.cantara.kcp.planner.json.PlanJson;

/**
 * Replay — determinism as a verifiable property. A saved {@code plan} artifact carries
 * the manifest's SHA-256 and an echo of the planner inputs. Replay re-fetches each
 * manifest, compares the bytes, re-runs the pure planner from the echoed inputs, and
 * reports identical or drifted per manifest. A port of {@code src/replay.ts}. The saved
 * plan is evidence; replay is the cross-examination.
 */
public final class Replay {

    private Replay() {
    }

    /** One manifest's replay verdict. Mirrors {@code ReplayCheck}. */
    public record ReplayCheck(String source, String project, String status, String detail, List<String> fields) {
    }

    /** The whole replay report. Mirrors {@code ReplayReport}. */
    public record ReplayReport(String artifact, List<ReplayCheck> checks, boolean ok) {
    }

    /** Accept any artifact shape: a single plan, a follow tree, or a {@code {plan: …}} wrapper. */
    public static List<Map<?, ?>> collectSavedPlans(Object json) {
        List<Map<?, ?>> out = new ArrayList<>();
        collect(json, out);
        if (out.isEmpty()) {
            throw new IllegalArgumentException(
                    "unrecognized artifact — expected the JSON output of a plan (a plan or a follow tree)");
        }
        return out;
    }

    private static boolean collect(Object json, List<Map<?, ?>> out) {
        if (!(json instanceof Map<?, ?> j)) {
            return false;
        }
        if (j.get("task") instanceof String && j.get("selected") instanceof List) {
            out.add(j);
            return true;
        }
        if (j.get("children") instanceof List) {
            walk(j, out);
            return true;
        }
        if (j.get("plan") != null) {
            return collect(j.get("plan"), out);
        }
        return false;
    }

    private static void walk(Map<?, ?> node, List<Map<?, ?>> out) {
        if (node.get("plan") instanceof Map<?, ?> p) {
            out.add(p);
        }
        if (node.get("children") instanceof List<?> children) {
            for (Object c : children) {
                if (c instanceof Map<?, ?> childNode) {
                    walk(childNode, out);
                }
            }
        }
    }

    /** Replay every plan in a saved artifact against the live manifests. */
    public static ReplayReport replayArtifact(Object artifactJson, String artifactName, ManifestClient client) {
        List<Map<?, ?>> saved = collectSavedPlans(artifactJson);
        List<ReplayCheck> checks = new ArrayList<>();

        for (Map<?, ?> s : saved) {
            Map<?, ?> manifest = asMap(s.get("manifest"));
            String source = manifest != null ? str(manifest.get("source")) : null;
            String project = manifest != null && manifest.get("project") != null ? str(manifest.get("project")) : "(unknown)";
            if (source == null) {
                checks.add(new ReplayCheck("(none)", project, "error", "saved plan has no manifest.source to re-fetch", null));
                continue;
            }
            Map<?, ?> options = asMap(s.get("options"));
            if (options == null) {
                checks.add(new ReplayCheck(source, project, "error",
                        "saved plan carries no echoed planner options — the artifact predates replay support; re-plan to refresh it", null));
                continue;
            }

            LoadedManifest lm;
            try {
                lm = client.load(source, false);
            } catch (IOException e) {
                checks.add(new ReplayCheck(source, project, "error",
                        "fetch failed: " + (e.getMessage() != null ? e.getMessage() : e.toString()), null));
                continue;
            }

            // Bytes first: if the manifest changed, the plan is stale by definition.
            String savedSha = manifest != null ? str(manifest.get("sha256")) : null;
            if (savedSha != null && !lm.sha256().equals(savedSha)) {
                checks.add(new ReplayCheck(source, project, "drifted",
                        "manifest bytes changed: sha256 " + lm.sha256().substring(0, 12) + "… ≠ saved "
                                + savedSha.substring(0, 12) + "…", null));
                continue;
            }

            PlanOptions opts = reconstructOptions(s, options);
            AgentPlan fresh = KcpPlanner.plan(lm.manifest(), str(s.get("task")), opts);

            Map<String, Object> a = comparable(deepCopyMap(s));
            Map<String, Object> b = comparable(PlanJson.toValue(fresh, opts));
            if (Json.writeCompact(a).equals(Json.writeCompact(b))) {
                checks.add(new ReplayCheck(source, project, "identical",
                        fresh.selected().size() + " selected, " + fresh.skipped().size()
                                + " skipped — plan reproduced byte-identically"
                                + (savedSha != null ? ", manifest sha256 matches" : " (saved artifact carried no manifest sha256)"),
                        null));
                continue;
            }
            Set<String> keys = new LinkedHashSet<>(a.keySet());
            keys.addAll(b.keySet());
            List<String> fields = new ArrayList<>();
            for (String k : keys) {
                if (!Json.writeCompact(a.get(k)).equals(Json.writeCompact(b.get(k)))) {
                    fields.add(k);
                }
            }
            java.util.Collections.sort(fields);
            checks.add(new ReplayCheck(source, project, "drifted", "plan differs in: " + String.join(", ", fields), fields));
        }

        boolean ok = !checks.isEmpty() && checks.stream().allMatch(c -> c.status().equals("identical"));
        return new ReplayReport(artifactName, checks, ok);
    }

    /** Strip what the pure planner cannot reproduce: fields attached by the loading layer. */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> comparable(Map<String, Object> plan) {
        plan.remove("signature");
        Object m = plan.get("manifest");
        if (m instanceof Map<?, ?>) {
            ((Map<String, Object>) m).remove("sha256");
        }
        return plan;
    }

    /** Rebuild the plan options from the echoed inputs. Mirrors the reference, which
     *  omits {@code contextBudget} on re-plan — reproduced here bug-for-bug. */
    private static PlanOptions reconstructOptions(Map<?, ?> savedPlan, Map<?, ?> options) {
        PlanOptions.Builder b = PlanOptions.builder();
        Map<?, ?> caps = asMap(options.get("capabilities"));
        if (caps != null) {
            if (caps.get("role") != null) {
                b.role(str(caps.get("role")));
            }
            if (caps.get("paymentMethods") instanceof List<?> pm) {
                b.paymentMethods(strList(pm));
            }
            if (caps.get("credentials") instanceof List<?> cr) {
                b.credentials(strList(cr));
            }
            if (caps.get("attestationProvider") != null) {
                b.attestationProvider(str(caps.get("attestationProvider")));
            }
        }
        if (savedPlan.get("environment") != null) {
            b.env(str(savedPlan.get("environment")));
        }
        if (savedPlan.get("asOf") != null) {
            b.asOf(str(savedPlan.get("asOf")));
        }
        if (options.get("maxUnits") != null) {
            b.maxUnits(((Number) options.get("maxUnits")).intValue());
        }
        if (Boolean.TRUE.equals(options.get("strict"))) {
            b.strict(true);
        }
        Map<?, ?> budget = asMap(options.get("budget"));
        if (budget != null && budget.get("amount") != null) {
            String currency = budget.get("currency") != null ? str(budget.get("currency")) : null;
            Double spent = budget.get("spent") != null ? ((Number) budget.get("spent")).doubleValue() : null;
            b.budget(new PlanOptions.Budget(((Number) budget.get("amount")).doubleValue(), currency, spent));
        }
        return b.build();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> deepCopyMap(Map<?, ?> src) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<?, ?> e : src.entrySet()) {
            out.put(String.valueOf(e.getKey()), deepCopy(e.getValue()));
        }
        return out;
    }

    private static Object deepCopy(Object v) {
        if (v instanceof Map<?, ?> m) {
            return deepCopyMap(m);
        }
        if (v instanceof List<?> l) {
            List<Object> out = new ArrayList<>();
            for (Object o : l) {
                out.add(deepCopy(o));
            }
            return out;
        }
        return v;
    }

    private static List<String> strList(List<?> l) {
        List<String> out = new ArrayList<>();
        for (Object o : l) {
            out.add(String.valueOf(o));
        }
        return out;
    }

    private static Map<?, ?> asMap(Object v) {
        return v instanceof Map<?, ?> m ? m : null;
    }

    private static String str(Object v) {
        return v == null ? null : v.toString();
    }
}

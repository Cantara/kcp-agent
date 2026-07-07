package no.cantara.kcp.planner.mcp;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import no.cantara.kcp.planner.AgentPlan;
import no.cantara.kcp.planner.KcpPlanner;
import no.cantara.kcp.planner.PlanOptions;
import no.cantara.kcp.planner.client.LoadedManifest;
import no.cantara.kcp.planner.client.ManifestClient;
import no.cantara.kcp.planner.json.Json;
import no.cantara.kcp.planner.json.PlanJson;
import no.cantara.kcp.planner.json.TraceJson;
import no.cantara.kcp.planner.trace.DecisionTrace;

import org.snakeyaml.engine.v2.api.Load;
import org.snakeyaml.engine.v2.api.LoadSettings;

/**
 * The KCP planner exposed to MCP clients over stdio JSON-RPC 2.0. A port of the
 * server surface in {@code src/mcp.ts}: newline-delimited JSON-RPC framing,
 * implemented directly (no SDK dependency), so the server is a small self-contained
 * jar. {@link #handleMessage} is a pure request → response function and unit-testable.
 *
 * <p>Tools: {@code kcp_plan} (the inspectable load plan) and {@code kcp_trace} (the
 * plan plus per-unit gate verdicts). Their JSON output is byte-for-byte identical to
 * the TypeScript reference. Content-loading ({@code kcp_load}), linting
 * ({@code kcp_validate}), and replay ({@code kcp_replay}) are added as their
 * supporting ports land.</p>
 */
public final class McpServer {

    private McpServer() {
    }

    /** The MCP protocol version this server speaks. */
    public static final String PROTOCOL_VERSION = "2025-06-18";
    private static final String SERVER_NAME = "kcp-planner-java";
    private static final String SERVER_VERSION = "0.1.0";

    /** Handle one JSON-RPC message; returns the response object, or {@code null} for notifications. */
    public static Map<String, Object> handleMessage(Map<?, ?> msg) {
        Object id = msg.get("id");
        String method = str(msg.get("method"));
        if (method == null) {
            return null;
        }
        switch (method) {
            case "initialize" -> {
                Map<?, ?> params = asMap(msg.get("params"));
                Object requested = params != null ? params.get("protocolVersion") : null;
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("protocolVersion", requested instanceof String s ? s : PROTOCOL_VERSION);
                r.put("capabilities", Map.of("tools", new LinkedHashMap<>()));
                Map<String, Object> info = new LinkedHashMap<>();
                info.put("name", SERVER_NAME);
                info.put("version", SERVER_VERSION);
                r.put("serverInfo", info);
                return result(id, r);
            }
            case "ping" -> {
                return result(id, new LinkedHashMap<>());
            }
            case "tools/list" -> {
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("tools", tools());
                return result(id, r);
            }
            case "tools/call" -> {
                Map<?, ?> params = asMap(msg.get("params"));
                String name = params != null ? str(params.get("name")) : null;
                Map<?, ?> args = params != null ? asMap(params.get("arguments")) : null;
                if (args == null) {
                    args = Map.of();
                }
                Map<String, Object> content = new LinkedHashMap<>();
                List<Object> items = new ArrayList<>();
                try {
                    String text = callTool(name, args);
                    items.add(textContent(text));
                    content.put("content", items);
                    content.put("isError", false);
                } catch (Exception e) {
                    items.add(textContent(e.getMessage() != null ? e.getMessage() : e.toString()));
                    content.put("content", items);
                    content.put("isError", true);
                }
                return result(id, content);
            }
            default -> {
                if (id == null || method.startsWith("notifications/")) {
                    return null; // notifications are acknowledged silently
                }
                return rpcError(id, -32601, "method not found: " + method);
            }
        }
    }

    private static String callTool(String name, Map<?, ?> args) throws IOException {
        if (name == null) {
            throw new IllegalArgumentException("no tool name");
        }
        switch (name) {
            case "kcp_plan" -> {
                ManifestClient client = clientFrom(args);
                LoadedManifest lm = client.load(str(args.get("manifest")), false);
                PlanOptions options = toOptions(args);
                AgentPlan plan = KcpPlanner.plan(lm.manifest(), str(args.get("task")), options);
                return PlanJson.toJson(plan, options, lm.sha256());
            }
            case "kcp_trace" -> {
                ManifestClient client = clientFrom(args);
                LoadedManifest lm = client.load(str(args.get("manifest")), false);
                PlanOptions options = toOptions(args);
                DecisionTrace trace = KcpPlanner.trace(lm.manifest(), str(args.get("task")), options);
                return TraceJson.toJson(trace, options);
            }
            default -> throw new IllegalArgumentException("unknown tool: " + name);
        }
    }

    /** Serve MCP over the given streams until input closes. */
    public static void serve(InputStream in, OutputStream out) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        PrintStream writer = new PrintStream(out, true, StandardCharsets.UTF_8);
        Load load = new Load(LoadSettings.builder().build());
        String line;
        while ((line = reader.readLine()) != null) {
            String trimmed = line.trim();
            if (trimmed.isEmpty()) {
                continue;
            }
            Map<?, ?> msg;
            try {
                Object parsed = load.loadFromString(trimmed);
                if (!(parsed instanceof Map<?, ?> m)) {
                    throw new IllegalArgumentException("not an object");
                }
                msg = m;
            } catch (Exception e) {
                writer.print(Json.writeCompact(rpcError(null, -32700, "parse error")) + "\n");
                continue;
            }
            Map<String, Object> response = handleMessage(msg);
            if (response != null) {
                writer.print(Json.writeCompact(response) + "\n");
            }
        }
    }

    /** Run the stdio server. */
    public static void main(String[] args) throws IOException {
        serve(System.in, System.out);
    }

    // --- tool definitions ---

    private static List<Object> tools() {
        List<Object> tools = new ArrayList<>();
        tools.add(tool("kcp_plan",
                "Produce a deterministic, inspectable load plan for a task against a KCP knowledge.yaml: "
                        + "which units to load in what order, which to skip and why, federation and budget "
                        + "decisions. No content is loaded and no model is called.",
                planSchema()));
        tools.add(tool("kcp_trace",
                "Produce a decision trace for a task: every unit in the manifest annotated with the gate "
                        + "cascade it was evaluated through. Same inputs as kcp_plan; returns the canonical plan "
                        + "plus structured per-unit gate verdicts.",
                planSchema()));
        return tools;
    }

    private static Map<String, Object> tool(String name, String description, Map<String, Object> schema) {
        Map<String, Object> t = new LinkedHashMap<>();
        t.put("name", name);
        t.put("description", description);
        t.put("inputSchema", schema);
        return t;
    }

    private static Map<String, Object> planSchema() {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("task", prop("string", "The task to plan knowledge loading for"));
        props.put("manifest", prop("string", "Path, directory, or HTTPS URL of a knowledge.yaml"));
        props.put("env", prop("string", "Runtime environment for federation context selection (dev/test/staging/prod)"));
        props.put("as_of", prop("string", "ISO date for temporal evaluation (default: today, UTC)"));
        props.put("max_units", prop("number", "Cap on selected units (default 5)"));
        props.put("strict", prop("boolean", "Fail-closed: drop non-eligible units instead of listing them"));
        props.put("budget", prop("number", "Spend ceiling for pay-per-request units"));
        props.put("currency", prop("string", "Budget currency (default USDC)"));
        props.put("context_budget", prop("number", "Token ceiling for what the plan loads into the caller's context window"));
        props.put("role", prop("string", "Agent role for audience targeting (default: agent)"));
        props.put("methods", arrayProp("Payment methods the agent can settle, e.g. [\"free\",\"x402\"]"));
        props.put("credentials", arrayProp("Credential kinds the agent holds, e.g. [\"mtls\",\"api_key\"]"));
        props.put("attest", prop("string", "Attestation provider the agent can present"));
        props.put("allow_private_hosts", prop("boolean", "Permit fetches to loopback/private/link-local hosts and http:// (default false)"));
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");
        schema.put("properties", props);
        schema.put("required", List.of("task", "manifest"));
        return schema;
    }

    private static Map<String, Object> prop(String type, String description) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("type", type);
        p.put("description", description);
        return p;
    }

    private static Map<String, Object> arrayProp(String description) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("type", "array");
        p.put("items", Map.of("type", "string"));
        p.put("description", description);
        return p;
    }

    // --- argument coercion ---

    private static ManifestClient clientFrom(Map<?, ?> args) {
        boolean allowPrivate = Boolean.TRUE.equals(args.get("allow_private_hosts"));
        return ManifestClient.builder().allowPrivate(allowPrivate).build();
    }

    private static PlanOptions toOptions(Map<?, ?> args) {
        PlanOptions.Builder b = PlanOptions.builder();
        if (args.get("role") != null) {
            b.role(str(args.get("role")));
        }
        List<String> methods = toList(args.get("methods"));
        if (methods != null) {
            b.paymentMethods(methods);
        }
        List<String> creds = toList(args.get("credentials"));
        if (creds != null) {
            b.credentials(creds);
        }
        if (args.get("attest") != null) {
            b.attestationProvider(str(args.get("attest")));
        }
        if (args.get("env") != null) {
            b.env(str(args.get("env")));
        }
        if (args.get("as_of") != null) {
            b.asOf(str(args.get("as_of")));
        }
        if (args.get("max_units") != null) {
            b.maxUnits(num(args.get("max_units")).intValue());
        }
        if (Boolean.TRUE.equals(args.get("strict"))) {
            b.strict(true);
        }
        if (args.get("context_budget") != null) {
            b.contextBudget(num(args.get("context_budget")).intValue());
        }
        if (args.get("budget") != null) {
            String currency = args.get("currency") != null ? str(args.get("currency")) : null;
            b.budget(new PlanOptions.Budget(num(args.get("budget")).doubleValue(), currency, null));
        }
        return b.build();
    }

    /** Accept a JSON array or a comma-separated string — MCP callers send both. */
    private static List<String> toList(Object v) {
        if (v instanceof List<?> l) {
            List<String> out = new ArrayList<>();
            for (Object o : l) {
                out.add(String.valueOf(o));
            }
            return out;
        }
        if (v instanceof String s) {
            List<String> out = new ArrayList<>();
            for (String part : s.split(",")) {
                String t = part.trim();
                if (!t.isEmpty()) {
                    out.add(t);
                }
            }
            return out;
        }
        return null;
    }

    // --- JSON-RPC envelope helpers ---

    private static Map<String, Object> result(Object id, Object result) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("jsonrpc", "2.0");
        m.put("id", id);
        m.put("result", result);
        return m;
    }

    private static Map<String, Object> rpcError(Object id, int code, String message) {
        Map<String, Object> err = new LinkedHashMap<>();
        err.put("code", (long) code);
        err.put("message", message);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("jsonrpc", "2.0");
        m.put("id", id);
        m.put("error", err);
        return m;
    }

    private static Map<String, Object> textContent(String text) {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("type", "text");
        c.put("text", text);
        return c;
    }

    private static String str(Object v) {
        return v == null ? null : v.toString();
    }

    private static Number num(Object v) {
        return v instanceof Number n ? n : Double.valueOf(v.toString());
    }

    private static Map<?, ?> asMap(Object v) {
        return v instanceof Map<?, ?> m ? m : null;
    }
}

package no.cantara.kcp.planner.mcp;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Exercises the pure {@link McpServer#handleMessage} request → response surface:
 * the initialize handshake, tool listing, a {@code kcp_plan} / {@code kcp_trace} tool
 * call end to end, notification handling, and unknown-method errors.
 */
class McpServerTest {

    private static final String MANIFEST = """
            kcp_version: "0.25"
            project: docs
            version: 1.0.0
            units:
              - id: deploy-guide
                path: ops/deploy.md
                intent: "How to deploy to production"
                audience: [agent]
                triggers: [deploy, production]
            """;

    @Test
    void initializeReturnsServerInfoAndProtocol() {
        Map<String, Object> resp = McpServer.handleMessage(Map.of(
                "jsonrpc", "2.0", "id", 1, "method", "initialize",
                "params", Map.of("protocolVersion", "2025-06-18")));
        assertNotNull(resp);
        assertEquals("2.0", resp.get("jsonrpc"));
        assertEquals(1, resp.get("id"));
        Map<?, ?> result = (Map<?, ?>) resp.get("result");
        assertEquals("2025-06-18", result.get("protocolVersion"));
        Map<?, ?> info = (Map<?, ?>) result.get("serverInfo");
        assertEquals("kcp-planner-java", info.get("name"));
    }

    @Test
    void toolsListExposesAllFiveTools() {
        Map<String, Object> resp = McpServer.handleMessage(Map.of("id", 2, "method", "tools/list"));
        Map<?, ?> result = (Map<?, ?>) resp.get("result");
        List<?> tools = (List<?>) result.get("tools");
        assertEquals(5, tools.size());
        for (String name : List.of("kcp_plan", "kcp_load", "kcp_validate", "kcp_trace", "kcp_replay")) {
            assertTrue(tools.stream().anyMatch(t -> name.equals(((Map<?, ?>) t).get("name"))), "missing tool " + name);
        }
    }

    @Test
    void kcpPlanToolReturnsPlanJson(@TempDir Path dir) throws IOException {
        Path manifest = dir.resolve("knowledge.yaml");
        Files.writeString(manifest, MANIFEST);

        Map<String, Object> resp = McpServer.handleMessage(Map.of(
                "id", 3, "method", "tools/call",
                "params", Map.of("name", "kcp_plan",
                        "arguments", Map.of("manifest", manifest.toString(), "task", "how do I deploy to production"))));
        Map<?, ?> result = (Map<?, ?>) resp.get("result");
        assertFalse((Boolean) result.get("isError"), "kcp_plan should not error");
        List<?> content = (List<?>) result.get("content");
        String text = (String) ((Map<?, ?>) content.get(0)).get("text");
        assertTrue(text.contains("\"deploy-guide\""), "plan JSON should mention the selected unit");
        assertTrue(text.contains("\"sha256\""), "plan JSON should carry the manifest sha256");
        assertTrue(text.contains("\"selected\""));
    }

    @Test
    void kcpTraceToolReturnsGateSummary(@TempDir Path dir) throws IOException {
        Path manifest = dir.resolve("knowledge.yaml");
        Files.writeString(manifest, MANIFEST);

        Map<String, Object> resp = McpServer.handleMessage(Map.of(
                "id", 4, "method", "tools/call",
                "params", Map.of("name", "kcp_trace",
                        "arguments", Map.of("manifest", manifest.toString(), "task", "deploy to production"))));
        Map<?, ?> result = (Map<?, ?>) resp.get("result");
        assertFalse((Boolean) result.get("isError"));
        String text = (String) ((Map<?, ?>) ((List<?>) result.get("content")).get(0)).get("text");
        assertTrue(text.contains("\"gateSummary\""));
        assertTrue(text.contains("\"context_budget\""));
    }

    @Test
    void kcpValidateToolReportsFindings(@TempDir Path dir) throws IOException {
        Path manifest = dir.resolve("knowledge.yaml");
        // No kcp_version and no triggers → warnings; the report should still be ok (no errors).
        Files.writeString(manifest, """
                project: docs
                version: 1.0.0
                units:
                  - id: a
                    path: knowledge.yaml
                    intent: "x"
                    audience: [agent]
                """);
        String text = callToolText("kcp_validate", Map.of("manifest", manifest.toString()));
        assertTrue(text.contains("\"findings\""));
        assertTrue(text.contains("missing 'kcp_version'"));
        assertTrue(text.contains("\"ok\": true"));
    }

    @Test
    void kcpLoadToolReturnsUnitContent(@TempDir Path dir) throws IOException {
        Files.createDirectories(dir.resolve("docs"));
        Files.writeString(dir.resolve("docs/deploy.md"), "Run make deploy.\n");
        Path manifest = dir.resolve("knowledge.yaml");
        Files.writeString(manifest, """
                kcp_version: "0.25"
                project: docs
                version: 1.0.0
                units:
                  - id: deploy-guide
                    path: docs/deploy.md
                    intent: "How to deploy to production"
                    audience: [agent]
                    triggers: [deploy, production]
                """);
        String text = callToolText("kcp_load",
                Map.of("manifest", manifest.toString(), "task", "how do I deploy to production"));
        assertTrue(text.contains("Run make deploy."), "load should return the unit content");
        assertTrue(text.contains("\"bytesSaved\""));
        assertTrue(text.contains("\"unavailable\""));
    }

    @Test
    void kcpReplayToolCrossExaminesAnArtifact(@TempDir Path dir) throws IOException {
        Path manifest = dir.resolve("knowledge.yaml");
        Files.writeString(manifest, MANIFEST);
        // Produce a plan artifact via kcp_plan, then replay it — it must reproduce identically.
        String planText = callToolText("kcp_plan",
                Map.of("manifest", manifest.toString(), "task", "how do I deploy to production", "as_of", "2026-07-06"));
        String replayText = callToolText("kcp_replay", Map.of("artifact", planText));
        assertTrue(replayText.contains("\"identical\""), "an unchanged manifest replays identical: " + replayText);
        assertTrue(replayText.contains("\"ok\": true"));
    }

    private static String callToolText(String name, Map<String, Object> arguments) {
        Map<String, Object> resp = McpServer.handleMessage(Map.of(
                "id", 9, "method", "tools/call", "params", Map.of("name", name, "arguments", arguments)));
        Map<?, ?> result = (Map<?, ?>) resp.get("result");
        assertFalse((Boolean) result.get("isError"), name + " should not error: " + result);
        return (String) ((Map<?, ?>) ((List<?>) result.get("content")).get(0)).get("text");
    }

    @Test
    void unknownToolReturnsToolError() {
        Map<String, Object> resp = McpServer.handleMessage(Map.of(
                "id", 5, "method", "tools/call",
                "params", Map.of("name", "kcp_bogus", "arguments", Map.of())));
        Map<?, ?> result = (Map<?, ?>) resp.get("result");
        assertTrue((Boolean) result.get("isError"), "an unknown tool is a tool error, not a crash");
    }

    @Test
    void notificationsAreSilentlyAcknowledged() {
        assertNull(McpServer.handleMessage(Map.of("method", "notifications/initialized")));
    }

    @Test
    void unknownMethodReturnsJsonRpcError() {
        Map<String, Object> resp = McpServer.handleMessage(Map.of("id", 6, "method", "frobnicate"));
        Map<?, ?> error = (Map<?, ?>) resp.get("error");
        assertNotNull(error);
        assertEquals(-32601L, error.get("code"));
    }
}

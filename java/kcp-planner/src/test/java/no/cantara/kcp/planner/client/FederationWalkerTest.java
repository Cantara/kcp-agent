package no.cantara.kcp.planner.client;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;

import no.cantara.kcp.planner.PlanOptions;
import no.cantara.kcp.planner.client.FederationWalker.FollowOptions;
import no.cantara.kcp.planner.client.FederationWalker.PlanNode;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Exercises {@link FederationWalker}: a two-level tree where a paid unit in the root
 * commits spend that must be carried into the child's budget (the ceiling is
 * tree-wide). Federation refs point at local files so the walk runs without a network.
 */
class FederationWalkerTest {

    @Test
    void budgetSpendPropagatesToSubManifests(@TempDir Path dir) throws IOException {
        Path child = dir.resolve("child.yaml");
        Files.writeString(child, """
                kcp_version: "0.25"
                project: child
                version: 1.0.0
                units:
                  - id: child-doc
                    path: c.md
                    intent: "deploy production runbook"
                    audience: [agent]
                    triggers: [deploy, production]
                    payment: { methods: [{type: x402, currency: USDC, price_per_request: "0.10"}] }
                """);
        Path root = dir.resolve("knowledge.yaml");
        Files.writeString(root, """
                kcp_version: "0.25"
                project: root
                version: 1.0.0
                units:
                  - id: root-doc
                    path: r.md
                    intent: "deploy production guide"
                    audience: [agent]
                    triggers: [deploy, production]
                    payment: { methods: [{type: x402, currency: USDC, price_per_request: "0.10"}] }
                manifests:
                  - id: child
                    url: %s
                """.formatted(child.toString()));

        FederationWalker walker = new FederationWalker(ManifestClient.create());
        PlanOptions options = PlanOptions.builder()
                .role("agent")
                .paymentMethods(java.util.List.of("free", "x402"))
                .asOf("2026-07-06")
                .budget(0.25, "USDC")
                .build();

        PlanNode rootNode = walker.walk(root.toString(), "deploy to production", options, FollowOptions.defaults());

        // Root planned and selected its paid unit.
        assertNotNull(rootNode.plan());
        assertNull(rootNode.error());
        assertEquals(1, rootNode.plan().selected().size());
        assertEquals("root-doc", rootNode.plan().selected().get(0).id());

        // The child was followed (selected, no credential gate).
        assertEquals(1, rootNode.children().size());
        PlanNode childNode = rootNode.children().get(0);
        assertNull(childNode.notFollowed(), "child should be followed");
        assertNull(childNode.error());
        assertNotNull(childNode.plan());
        assertEquals("child-doc", childNode.plan().selected().get(0).id());

        // The root's 0.10 spend is committed upstream in the child's budget, and the
        // child's own 0.10 fits under the tree-wide 0.25 ceiling (0.05 remaining).
        assertEquals(0, childNode.plan().budget().alreadyCommitted().compareTo(new BigDecimal("0.10")));
        assertEquals(0, childNode.plan().budget().remaining().compareTo(new BigDecimal("0.05")));
    }

    @Test
    void credentialGatedRefsAreNotFollowed(@TempDir Path dir) throws IOException {
        Path root = dir.resolve("knowledge.yaml");
        Files.writeString(root, """
                kcp_version: "0.25"
                project: root
                version: 1.0.0
                units:
                  - id: root-doc
                    path: r.md
                    intent: "deploy production guide"
                    audience: [agent]
                    triggers: [deploy, production]
                manifests:
                  - id: vendor
                    url: https://vendor.example.com/knowledge.yaml
                    agent_identity: { required: true, credential_hint: vendor_token }
                """);

        FederationWalker walker = new FederationWalker(ManifestClient.create());
        PlanOptions options = PlanOptions.builder().role("agent").asOf("2026-07-06").build();
        PlanNode rootNode = walker.walk(root.toString(), "deploy to production", options, FollowOptions.defaults());

        assertEquals(1, rootNode.children().size());
        PlanNode vendor = rootNode.children().get(0);
        assertNotNull(vendor.notFollowed(), "credential-gated ref must not be fetched");
        assertTrue(vendor.notFollowed().contains("vendor_token"));
        assertNull(vendor.plan(), "an un-followed ref is never fetched");
    }
}

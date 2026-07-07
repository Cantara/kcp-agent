package no.cantara.kcp.planner.replay;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import no.cantara.kcp.planner.AgentPlan;
import no.cantara.kcp.planner.KcpPlanner;
import no.cantara.kcp.planner.PlanOptions;
import no.cantara.kcp.planner.client.LoadedManifest;
import no.cantara.kcp.planner.client.ManifestClient;
import no.cantara.kcp.planner.json.PlanJson;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.snakeyaml.engine.v2.api.Load;
import org.snakeyaml.engine.v2.api.LoadSettings;

/**
 * Exercises {@link Replay}: a plan re-planned against its unchanged manifest reproduces
 * byte-identically; a manifest whose bytes changed is reported as drifted (sha
 * mismatch), fail-closed. Determinism as a verifiable property.
 */
class ReplayTest {

    private static final String MANIFEST = """
            kcp_version: "0.25"
            project: docs
            version: 1.0.0
            units:
              - id: deploy-guide
                path: docs/deploy.md
                intent: "How to deploy to production"
                audience: [agent]
                triggers: [deploy, production]
            """;

    private static Object artifactFor(Path manifest, ManifestClient client) throws IOException {
        LoadedManifest lm = client.load(manifest.toString(), false);
        PlanOptions options = PlanOptions.builder().role("agent").asOf("2026-07-06").build();
        AgentPlan plan = KcpPlanner.plan(lm.manifest(), "how do I deploy to production", options);
        String json = PlanJson.toJson(plan, options, lm.sha256());
        return new Load(LoadSettings.builder().build()).loadFromString(json);
    }

    @Test
    void unchangedManifestReplaysIdentical(@TempDir Path dir) throws IOException {
        Path manifest = dir.resolve("knowledge.yaml");
        Files.writeString(manifest, MANIFEST);
        ManifestClient client = ManifestClient.create();
        Object artifact = artifactFor(manifest, client);

        Replay.ReplayReport report = Replay.replayArtifact(artifact, "test", client);
        assertEquals(1, report.checks().size());
        assertEquals("identical", report.checks().get(0).status(), report.checks().get(0).detail());
        assertTrue(report.ok());
    }

    @Test
    void changedManifestBytesAreDrifted(@TempDir Path dir) throws IOException {
        Path manifest = dir.resolve("knowledge.yaml");
        Files.writeString(manifest, MANIFEST);
        ManifestClient client = ManifestClient.create();
        Object artifact = artifactFor(manifest, client);

        // Tamper the manifest after the plan was saved — the pinned sha no longer matches.
        Files.writeString(manifest, MANIFEST + "\n# edited\n");

        Replay.ReplayReport report = Replay.replayArtifact(artifact, "test", client);
        assertEquals("drifted", report.checks().get(0).status());
        assertTrue(report.checks().get(0).detail().contains("manifest bytes changed"));
        assertFalse(report.ok());
    }
}

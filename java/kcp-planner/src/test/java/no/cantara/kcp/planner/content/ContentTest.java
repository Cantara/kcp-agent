package no.cantara.kcp.planner.content;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import no.cantara.kcp.planner.AgentPlan;
import no.cantara.kcp.planner.KcpPlanner;
import no.cantara.kcp.planner.client.LoadedManifest;
import no.cantara.kcp.planner.client.ManifestClient;
import no.cantara.kcp.planner.content.UnitLoader.LoadResult;
import no.cantara.kcp.planner.content.UnitLoader.LoadedUnit;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Exercises {@link UnitLoader} (serving load-eligible unit content from disk) and
 * {@link Dedup} (withholding bytes the caller already holds at the same sha).
 */
class ContentTest {

    private static final String CONTENT = "Deploy by running `make deploy`.\n";

    private static AgentPlan planFixture(Path dir, ManifestClient client) throws IOException {
        Files.createDirectories(dir.resolve("docs"));
        Files.writeString(dir.resolve("docs/deploy.md"), CONTENT);
        Files.writeString(dir.resolve("knowledge.yaml"), """
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
        LoadedManifest lm = client.load(dir.toString(), false);
        return KcpPlanner.plan(lm.manifest(), "how do I deploy to production");
    }

    @Test
    void loadsSelectedUnitContentFromDisk(@TempDir Path dir) throws IOException {
        ManifestClient client = ManifestClient.create();
        AgentPlan plan = planFixture(dir, client);

        LoadResult r = UnitLoader.loadPlannedUnits(plan, client);
        assertEquals(1, r.loaded().size());
        assertTrue(r.unavailable().isEmpty());
        LoadedUnit u = r.loaded().get(0);
        assertEquals("deploy-guide", u.id());
        assertEquals(CONTENT, u.content());
        assertEquals(CONTENT.length(), u.chars());
        assertEquals(ManifestClient.sha256(CONTENT), u.sha256());
    }

    @Test
    void dedupWithholdsBytesForUnchangedUnits(@TempDir Path dir) throws IOException {
        ManifestClient client = ManifestClient.create();
        AgentPlan plan = planFixture(dir, client);
        LoadResult r = UnitLoader.loadPlannedUnits(plan, client);

        String sha = ManifestClient.sha256(CONTENT);
        Dedup.DedupResult held = Dedup.dedupeLoaded(r.loaded(), List.of(Map.of("id", "deploy-guide", "sha256", sha)));
        assertEquals(1, held.deduped().size());
        assertEquals(CONTENT.length(), held.bytesSaved());
        assertInstanceOf(Dedup.UnchangedUnit.class, held.units().get(0), "matching unit should be a withheld stub");

        // A different sha (the caller's copy drifted) re-serves the full bytes.
        Dedup.DedupResult fresh = Dedup.dedupeLoaded(r.loaded(), List.of(Map.of("id", "deploy-guide", "sha256", "stale")));
        assertEquals(0, fresh.deduped().size());
        assertInstanceOf(LoadedUnit.class, fresh.units().get(0));
    }
}

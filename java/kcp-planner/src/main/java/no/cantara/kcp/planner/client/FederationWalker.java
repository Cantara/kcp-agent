package no.cantara.kcp.planner.client;

import java.io.IOException;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import no.cantara.kcp.planner.AgentCapabilities;
import no.cantara.kcp.planner.AgentPlan;
import no.cantara.kcp.planner.FederationPlan;
import no.cantara.kcp.planner.KcpPlanner;
import no.cantara.kcp.planner.PlanOptions;
import no.cantara.kcp.planner.verify.ManifestVerifier;
import no.cantara.kcp.planner.verify.SignatureResult;

/**
 * Walks a federated manifest tree: plan the root, then follow every selected,
 * un-credential-gated sub-manifest — each fetched through the {@link SsrfGuard} —
 * and plan it too, propagating the spend already committed upstream so the money
 * budget is enforced tree-wide. A focused port of the federation logic in
 * {@code src/follow.ts}.
 *
 * <p>The walk is bounded: a depth cap, a node cap, and cycle detection (by resolved
 * location) keep an adversarial or cyclic federation from exhausting the client.</p>
 */
public final class FederationWalker {

    private final ManifestClient client;

    /**
     * Create a walker over a client.
     *
     * @param client the manifest client whose guard every fetch passes through
     */
    public FederationWalker(ManifestClient client) {
        this.client = client;
    }

    /**
     * Options bounding the walk.
     *
     * @param maxDepth the maximum federation depth to follow
     * @param maxNodes the maximum number of sub-manifests to fetch
     * @param verify   whether to verify each manifest's signature
     */
    public record FollowOptions(int maxDepth, int maxNodes, boolean verify) {
        /** The default bounds: depth 3, 32 nodes, no verification. */
        public static FollowOptions defaults() {
            return new FollowOptions(3, 32, false);
        }
    }

    /**
     * One node of the walk: a manifest and its plan, plus the sub-manifests reached
     * from it.
     *
     * @param refId       the federation ref id (null for the root)
     * @param location    where the manifest was loaded from
     * @param plan        the plan for this manifest, or {@code null} if it could not be loaded
     * @param sha256      the SHA-256 of the manifest bytes, or {@code null}
     * @param signature   the signature verdict, or {@code null} when not verified/loaded
     * @param error       an error message when the manifest could not be loaded, else {@code null}
     * @param notFollowed why a declared ref was not followed (credential/cycle/cap), else {@code null}
     * @param children    the sub-manifest nodes reached from this one
     */
    public record PlanNode(String refId, String location, AgentPlan plan, String sha256,
            SignatureResult signature, String error, String notFollowed, List<PlanNode> children) {
    }

    /**
     * Walk the tree rooted at {@code location}.
     *
     * @param location the root manifest path/dir or URL
     * @param task     the task to plan against every manifest in the tree
     * @param options  the planning options (budget/context propagate down the tree)
     * @param follow   the walk bounds
     * @return the root plan node with its descendants
     */
    public PlanNode walk(String location, String task, PlanOptions options, FollowOptions follow) {
        Set<String> seen = new HashSet<>();
        seen.add(location);
        int[] remaining = {follow.maxNodes()};
        return visit(null, location, task, options, follow, 0, seen, remaining);
    }

    private PlanNode visit(String refId, String location, String task, PlanOptions options,
            FollowOptions follow, int depth, Set<String> seen, int[] remaining) {
        LoadedManifest lm;
        try {
            lm = client.load(location, follow.verify());
        } catch (IOException e) {
            return new PlanNode(refId, location, null, null, null, e.getMessage(), null, List.of());
        }
        AgentPlan plan = KcpPlanner.plan(lm.manifest(), task, options);

        List<PlanNode> children = new ArrayList<>();
        if (depth < follow.maxDepth()) {
            BigDecimal committed = committedSpend(options, plan);
            for (FederationPlan f : plan.federation()) {
                if (!f.selected()) {
                    continue; // not selected for this environment — nothing to follow
                }
                if (f.credentialNeeded() != null) {
                    children.add(notFollowed(f, "needs credential " + f.credentialNeeded()));
                    continue;
                }
                String childLoc = ManifestVerifier.resolveLocation(lm.source(), f.url());
                if (!seen.add(childLoc)) {
                    children.add(notFollowed(f, "cycle: already visited " + childLoc));
                    continue;
                }
                if (remaining[0] <= 0) {
                    children.add(notFollowed(f, "node cap reached"));
                    continue;
                }
                remaining[0]--;
                children.add(visit(f.id(), childLoc, task, childOptions(options, committed), follow,
                        depth + 1, seen, remaining));
            }
        }
        return new PlanNode(refId, location, plan, lm.sha256(), lm.signature(), null, null, children);
    }

    private static PlanNode notFollowed(FederationPlan f, String why) {
        return new PlanNode(f.id(), f.url(), null, null, null, null, why, List.of());
    }

    /** The spend committed by this manifest and everything above it — the tree-wide ledger. */
    private static BigDecimal committedSpend(PlanOptions options, AgentPlan plan) {
        if (options.budget() == null) {
            return null;
        }
        BigDecimal spent = options.budget().spent() != null
                ? BigDecimal.valueOf(options.budget().spent()) : BigDecimal.ZERO;
        BigDecimal projected = plan.budget().projectedSpend() != null
                ? plan.budget().projectedSpend() : BigDecimal.ZERO;
        return spent.add(projected);
    }

    /** Child options: the same capabilities/env/budgets, but with the tree-wide spend carried down. */
    private static PlanOptions childOptions(PlanOptions options, BigDecimal committed) {
        AgentCapabilities caps = options.capabilities();
        PlanOptions.Builder b = PlanOptions.builder()
                .role(caps.role())
                .paymentMethods(caps.paymentMethods())
                .credentials(caps.credentials())
                .attestationProvider(caps.attestationProvider())
                .env(options.env())
                .asOf(options.asOf())
                .maxUnits(options.maxUnits())
                .strict(options.strict());
        if (options.contextBudget() != null) {
            b.contextBudget(options.contextBudget());
        }
        if (options.budget() != null) {
            PlanOptions.Budget parent = options.budget();
            double spent = committed != null ? committed.doubleValue() : 0.0;
            b.budget(new PlanOptions.Budget(parent.amount(), parent.currency(), spent));
        }
        return b.build();
    }
}

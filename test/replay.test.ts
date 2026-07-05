// Replay: a saved plan artifact is re-verifiable evidence. The artifact pins
// the manifest bytes (sha256) and echoes the planner inputs; replay re-fetches,
// re-plans, and reports identical or drifted — per manifest, with reasons.

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planTree, plans } from "../src/follow.js";
import { replayArtifact, collectSavedPlans } from "../src/replay.js";
import type { AgentPlan } from "../src/planner.js";

const HUB = "test/fixtures/fed/hub";
const TASK = "how do I deploy?";
const OPTS = { asOf: "2026-07-05" };

// round-trip through JSON, exactly like `plan --json` → file → replay
const roundTrip = (x: unknown) => JSON.parse(JSON.stringify(x));

describe("replay — the plan artifact survives cross-examination", () => {
  it("replays a single-plan artifact as identical", async () => {
    const tree = await planTree(HUB, TASK, { planOptions: OPTS });
    const artifact = roundTrip(plans(tree)[0]);
    const report = await replayArtifact(artifact);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0].status).toBe("identical");
    expect(report.checks[0].detail).toContain("manifest sha256 matches");
    expect(report.ok).toBe(true);
  });

  it("replays every node of a --follow tree artifact", async () => {
    const tree = await planTree(HUB, TASK, { maxDepth: 1, planOptions: OPTS });
    const report = await replayArtifact(roundTrip(tree));
    expect(report.checks.map((c) => c.project)).toEqual(["fed-hub", "fed-child"]);
    expect(report.ok).toBe(true);
  });

  it("unwraps an `ask --json` shaped artifact", async () => {
    const tree = await planTree(HUB, TASK, { planOptions: OPTS });
    const saved = collectSavedPlans(roundTrip({ plan: plans(tree)[0], synthesis: { answer: "…" } }));
    expect(saved).toHaveLength(1);
    expect(saved[0].task).toBe(TASK);
  });

  it("detects manifest drift by sha256 before re-planning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kcp-replay-"));
    cpSync("test/fixtures/fed", join(dir, "fed"), { recursive: true });
    const hub = join(dir, "fed", "hub");
    const tree = await planTree(hub, TASK, { planOptions: OPTS });
    const artifact = roundTrip(plans(tree)[0]);

    appendFileSync(join(hub, "knowledge.yaml"), "\n# tampered after planning\n");
    const report = await replayArtifact(artifact);
    expect(report.ok).toBe(false);
    expect(report.checks[0].status).toBe("drifted");
    expect(report.checks[0].detail).toContain("manifest bytes changed");
  });

  it("detects a tampered artifact even when the manifest bytes still match", async () => {
    const tree = await planTree(HUB, TASK, { planOptions: OPTS });
    const artifact = roundTrip(plans(tree)[0]) as AgentPlan;
    artifact.selected[0].score += 100; // someone edited the evidence
    const report = await replayArtifact(artifact);
    expect(report.checks[0].status).toBe("drifted");
    expect(report.checks[0].fields).toContain("selected");
  });

  it("reports pre-replay artifacts (no options echo) as errors, not as identical", async () => {
    const tree = await planTree(HUB, TASK, { planOptions: OPTS });
    const artifact = roundTrip(plans(tree)[0]) as Record<string, unknown>;
    delete artifact.options;
    const report = await replayArtifact(artifact);
    expect(report.checks[0].status).toBe("error");
    expect(report.ok).toBe(false);
  });

  it("replay is capability-faithful: a credentialed plan replays with its credentials", async () => {
    const tree = await planTree(HUB, TASK, {
      maxDepth: 1,
      planOptions: { ...OPTS, env: "prod", capabilities: { credentials: ["github_pat"] } },
    });
    const report = await replayArtifact(roundTrip(tree));
    expect(report.ok).toBe(true);
  });

  it("rejects an unrecognizable artifact loudly", async () => {
    await expect(replayArtifact({ nonsense: true })).rejects.toThrow(/unrecognized artifact/);
  });

  it("round-trips through an actual file, like the CLI does", async () => {
    const tree = await planTree(HUB, TASK, { planOptions: OPTS });
    const file = join(mkdtempSync(join(tmpdir(), "kcp-replay-")), "plan.json");
    writeFileSync(file, JSON.stringify(plans(tree)[0], null, 2));
    const report = await replayArtifact(JSON.parse(readFileSync(file, "utf8")), file);
    expect(report.artifact).toBe(file);
    expect(report.ok).toBe(true);
  });
});

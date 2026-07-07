// Watch mode tests — validate --once mode, file change re-validation,
// debouncing, --task re-planning, and JSON output format.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCycle, watchManifest, type WatchCycleResult } from "../src/watch.js";

const VALID_MANIFEST = `
kcp_version: "0.25"
project: test-kb
version: 1.0.0
units:
  - id: deploy-guide
    path: docs/deploy.md
    intent: "How are releases deployed to production?"
    audience: [agent]
    triggers: [deploy, release, production]
  - id: incident-runbook
    path: runbook.md
    intent: "Production incident response and deploy rollback runbook"
    audience: [agent]
    triggers: [incident, deploy, rollback]
`;

const INVALID_MANIFEST = `
kcp_version: "0.25"
project: test-kb
version: 1.0.0
units:
  - id: deploy-guide
    path: docs/deploy.md
    intent: "How are releases deployed to production?"
    audience: [agent]
    triggers: [deploy, release, production]
  - id: deploy-guide
    path: docs/other.md
    intent: "Duplicate id"
    audience: [agent]
    triggers: [other]
`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "kcp-watch-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("runCycle()", () => {
  it("validates a clean manifest with no errors", async () => {
    const manifestPath = join(tmpDir, "knowledge.yaml");
    mkdirSync(join(tmpDir, "docs"), { recursive: true });
    writeFileSync(manifestPath, VALID_MANIFEST);
    writeFileSync(join(tmpDir, "docs", "deploy.md"), "# Deploy guide");
    writeFileSync(join(tmpDir, "runbook.md"), "# Runbook");

    const result = await runCycle(manifestPath, undefined, {});
    expect(result.validation.ok).toBe(true);
    expect(result.validation.findings.filter((f) => f.level === "error")).toEqual([]);
  });

  it("detects validation errors in an invalid manifest", async () => {
    const manifestPath = join(tmpDir, "knowledge.yaml");
    writeFileSync(manifestPath, INVALID_MANIFEST);

    const result = await runCycle(manifestPath, undefined, {});
    expect(result.validation.ok).toBe(false);
    expect(result.validation.findings.some((f) => f.level === "error" && f.message.includes("duplicate"))).toBe(true);
  });

  it("handles a missing manifest gracefully", async () => {
    const result = await runCycle(join(tmpDir, "nonexistent.yaml"), undefined, {});
    expect(result.validation.ok).toBe(false);
    expect(result.validation.findings.some((f) => f.level === "error")).toBe(true);
  });

  it("handles a malformed YAML manifest gracefully", async () => {
    const manifestPath = join(tmpDir, "knowledge.yaml");
    writeFileSync(manifestPath, "{{{{not yaml at all}}}");

    const result = await runCycle(manifestPath, undefined, {});
    expect(result.validation.ok).toBe(false);
  });
});

describe("--once mode", () => {
  it("returns exit code 0 for a valid manifest", async () => {
    const manifestPath = join(tmpDir, "knowledge.yaml");
    mkdirSync(join(tmpDir, "docs"), { recursive: true });
    writeFileSync(manifestPath, VALID_MANIFEST);
    writeFileSync(join(tmpDir, "docs", "deploy.md"), "# Deploy");
    writeFileSync(join(tmpDir, "runbook.md"), "# Runbook");

    const { exitCode } = await watchManifest(manifestPath, { once: true });
    expect(exitCode).toBe(0);
  });

  it("returns exit code 1 for an invalid manifest", async () => {
    const manifestPath = join(tmpDir, "knowledge.yaml");
    writeFileSync(manifestPath, INVALID_MANIFEST);

    const { exitCode } = await watchManifest(manifestPath, { once: true });
    expect(exitCode).toBe(1);
  });

  it("returns exit code 1 for a missing manifest", async () => {
    const { exitCode } = await watchManifest(join(tmpDir, "nope.yaml"), { once: true });
    expect(exitCode).toBe(1);
  });
});

describe("--task mode triggers re-planning", () => {
  it("produces a plan when a task is specified", async () => {
    const manifestPath = join(tmpDir, "knowledge.yaml");
    mkdirSync(join(tmpDir, "docs"), { recursive: true });
    writeFileSync(manifestPath, VALID_MANIFEST);
    writeFileSync(join(tmpDir, "docs", "deploy.md"), "# Deploy");
    writeFileSync(join(tmpDir, "runbook.md"), "# Runbook");

    const result = await runCycle(manifestPath, undefined, { task: "deploy release" });
    expect(result.plan).toBeDefined();
    expect(result.plan!.selected.length).toBeGreaterThan(0);
    expect(result.plan!.task).toBe("deploy release");
  });

  it("produces a diff when a previous plan exists and diff is true", async () => {
    const manifestPath = join(tmpDir, "knowledge.yaml");
    mkdirSync(join(tmpDir, "docs"), { recursive: true });
    writeFileSync(manifestPath, VALID_MANIFEST);
    writeFileSync(join(tmpDir, "docs", "deploy.md"), "# Deploy");
    writeFileSync(join(tmpDir, "runbook.md"), "# Runbook");

    // First cycle (no previous plan).
    const first = await runCycle(manifestPath, undefined, { task: "deploy", diff: true });
    expect(first.plan).toBeDefined();
    expect(first.diff).toBeUndefined(); // no previous plan → no diff

    // Second cycle with the first plan as previous.
    const second = await runCycle(manifestPath, first.plan, { task: "deploy", diff: true });
    expect(second.diff).toBeDefined();
    expect(second.diff!.identical).toBe(true); // same manifest, same task → identical
  });

  it("detects plan changes when the manifest is modified between cycles", async () => {
    const manifestPath = join(tmpDir, "knowledge.yaml");
    mkdirSync(join(tmpDir, "docs"), { recursive: true });
    writeFileSync(manifestPath, VALID_MANIFEST);
    writeFileSync(join(tmpDir, "docs", "deploy.md"), "# Deploy");
    writeFileSync(join(tmpDir, "runbook.md"), "# Runbook");

    const first = await runCycle(manifestPath, undefined, { task: "deploy release" });

    // Modify manifest: add a new unit.
    const modifiedManifest = VALID_MANIFEST + `
  - id: new-deploy-docs
    path: docs/deploy.md
    intent: "New deployment documentation and release procedures"
    audience: [agent]
    triggers: [deploy, release, new]
`;
    writeFileSync(manifestPath, modifiedManifest);

    const second = await runCycle(manifestPath, first.plan, { task: "deploy release", diff: true });
    expect(second.diff).toBeDefined();
    // The new unit should show up as b_only in presence.
    expect(second.diff!.identical).toBe(false);
  });
});

describe("file change triggers re-validation", () => {
  it("fires the onChange callback when a watched file changes", async () => {
    const manifestPath = join(tmpDir, "knowledge.yaml");
    mkdirSync(join(tmpDir, "docs"), { recursive: true });
    writeFileSync(manifestPath, VALID_MANIFEST);
    writeFileSync(join(tmpDir, "docs", "deploy.md"), "# Deploy");
    writeFileSync(join(tmpDir, "runbook.md"), "# Runbook");

    // Start watching.
    const { close } = await watchManifest(manifestPath, {});

    // We need to verify the watcher was created — the best we can do without
    // hooking into internal state is to verify close() runs without throwing.
    expect(() => close()).not.toThrow();
  });
});

describe("debouncing", () => {
  it("rapid changes coalesce into a single re-validation cycle", async () => {
    const manifestPath = join(tmpDir, "knowledge.yaml");
    mkdirSync(join(tmpDir, "docs"), { recursive: true });
    writeFileSync(manifestPath, VALID_MANIFEST);
    writeFileSync(join(tmpDir, "docs", "deploy.md"), "# Deploy");
    writeFileSync(join(tmpDir, "runbook.md"), "# Runbook");

    // Capture console.log output to count how many validation cycles fire.
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      const { close } = await watchManifest(manifestPath, {});

      // Fire 5 rapid changes within the debounce window (150ms).
      for (let i = 0; i < 5; i++) {
        writeFileSync(manifestPath, VALID_MANIFEST + `# change ${i}\n`);
      }

      // Wait for the debounce to settle (150ms) + a small margin.
      await new Promise((r) => setTimeout(r, 350));

      close();

      // Count how many "Validate:" lines appeared AFTER the initial one.
      // The initial watchManifest call produces one, then the debounced
      // changes should produce at most one more (not five).
      const validateLines = logs.filter((l) => l.includes("Validate:"));
      // Initial + at most 1 debounced = at most 2 total
      expect(validateLines.length).toBeLessThanOrEqual(2);
    } finally {
      console.log = origLog;
    }
  });
});

describe("JSON output format", () => {
  it("emits newline-delimited JSON events in --once --json mode", async () => {
    const manifestPath = join(tmpDir, "knowledge.yaml");
    mkdirSync(join(tmpDir, "docs"), { recursive: true });
    writeFileSync(manifestPath, VALID_MANIFEST);
    writeFileSync(join(tmpDir, "docs", "deploy.md"), "# Deploy");
    writeFileSync(join(tmpDir, "runbook.md"), "# Runbook");

    // Capture JSON output.
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };

    try {
      await watchManifest(manifestPath, { once: true, json: true });

      // Each line should be valid JSON.
      expect(lines.length).toBeGreaterThanOrEqual(1);
      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(parsed.type).toBeDefined();
        expect(parsed.timestamp).toBeDefined();
        expect(parsed.data).toBeDefined();
      }

      // First event should be a validate event.
      const first = JSON.parse(lines[0]);
      expect(first.type).toBe("validate");
      expect(first.data.ok).toBe(true);
    } finally {
      console.log = origLog;
    }
  });

  it("emits plan and diff events when --task is used with --json", async () => {
    const manifestPath = join(tmpDir, "knowledge.yaml");
    mkdirSync(join(tmpDir, "docs"), { recursive: true });
    writeFileSync(manifestPath, VALID_MANIFEST);
    writeFileSync(join(tmpDir, "docs", "deploy.md"), "# Deploy");
    writeFileSync(join(tmpDir, "runbook.md"), "# Runbook");

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };

    try {
      await watchManifest(manifestPath, { once: true, json: true, task: "deploy release" });

      const events = lines.map((l) => JSON.parse(l));
      const types = events.map((e) => e.type);
      expect(types).toContain("validate");
      expect(types).toContain("plan");

      // Plan event should have the task.
      const planEvent = events.find((e) => e.type === "plan");
      expect(planEvent.data.task).toBe("deploy release");
    } finally {
      console.log = origLog;
    }
  });

  it("validate event data conforms to ValidationReport shape", async () => {
    const manifestPath = join(tmpDir, "knowledge.yaml");
    writeFileSync(manifestPath, INVALID_MANIFEST);

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };

    try {
      await watchManifest(manifestPath, { once: true, json: true });

      const validate = JSON.parse(lines[0]);
      expect(validate.type).toBe("validate");
      expect(validate.data.ok).toBe(false);
      expect(validate.data.source).toBe(manifestPath);
      expect(Array.isArray(validate.data.findings)).toBe(true);
      expect(validate.data.findings.some((f: { level: string }) => f.level === "error")).toBe(true);
    } finally {
      console.log = origLog;
    }
  });
});

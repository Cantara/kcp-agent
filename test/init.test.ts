// Auto-manifest generation — kcp-agent init (issue #76).
// Tests the deterministic scanning of a project directory into a valid
// knowledge.yaml manifest.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initManifest } from "../src/init.js";
import { parseManifest } from "../src/client.js";
import { validateManifest } from "../src/validate.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "kcp-init-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a minimal project structure. */
function scaffold(files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(tmpDir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
}

describe("initManifest", () => {
  it("generates a valid manifest for a minimal project", async () => {
    scaffold({
      "README.md": "# My Project\nSome description.",
      "src/index.ts": "// Entry point\nexport const main = () => {};",
      "docs/guide.md": "# Getting Started\nA guide.",
    });

    const yaml = await initManifest(tmpDir);
    expect(yaml).toContain("kcp_version:");
    expect(yaml).toContain("project:");

    // It was written to disk
    expect(existsSync(join(tmpDir, "knowledge.yaml"))).toBe(true);

    // Parse and validate — must have zero errors
    const manifest = parseManifest(yaml);
    const findings = validateManifest(manifest, tmpDir);
    const errors = findings.filter((f) => f.level === "error");
    expect(errors).toEqual([]);
  });

  it("README.md always becomes the front-door unit", async () => {
    scaffold({
      "README.md": "# Hello World\nProject readme.",
      "src/auth.ts": "// Auth module\nexport function login() {}",
    });

    const yaml = await initManifest(tmpDir);
    const manifest = parseManifest(yaml);

    // front-door must be first and point to README.md
    expect(manifest.units[0].id).toBe("front-door");
    expect(manifest.units[0].path).toBe("README.md");
    expect(manifest.units[0].scope).toBe("global");
    expect(manifest.units[0].audience).toContain("agent");
    expect(manifest.units[0].audience).toContain("human");
  });

  it("generated manifest passes validate with zero errors", async () => {
    scaffold({
      "README.md": "# Test\nReadme.",
      "src/planner.ts": "// The planner scores and selects units.\nexport function plan() {}",
      "src/client.ts": "// Client loads manifests.\nexport function load() {}",
      "docs/architecture.md": "# Architecture\nOverview.",
      "examples/basic/README.md": "# Basic Example\nHow to use.",
      "test/planner.test.ts": "// Tests for the planner.",
    });

    const yaml = await initManifest(tmpDir);
    const manifest = parseManifest(yaml);
    const findings = validateManifest(manifest, tmpDir);
    const errors = findings.filter((f) => f.level === "error");
    expect(errors).toEqual([]);
    // At least README + 2 source + 1 doc + 1 example + 1 test = 6 units
    expect(manifest.units.length).toBeGreaterThanOrEqual(6);
  });

  it("--force overwrites an existing knowledge.yaml", async () => {
    scaffold({
      "README.md": "# My Project",
      "knowledge.yaml": "kcp_version: '0.25'\nproject: old\nversion: 1.0.0\nunits: []",
    });

    // Without force it should throw
    await expect(initManifest(tmpDir)).rejects.toThrow(/already exists/);

    // With force it should succeed
    const yaml = await initManifest(tmpDir, { force: true });
    expect(yaml).toContain("project:");

    // The written file should be the new one, not the old one
    const written = readFileSync(join(tmpDir, "knowledge.yaml"), "utf8");
    expect(written).not.toContain("project: old");
  });

  it("errors on existing knowledge.yaml without --force", async () => {
    scaffold({
      "README.md": "# Test",
      "knowledge.yaml": "kcp_version: '0.25'\nproject: existing\nversion: 1.0.0\nunits: []",
    });

    await expect(initManifest(tmpDir)).rejects.toThrow(/already exists/);
  });

  it("detects project metadata from package.json", async () => {
    scaffold({
      "README.md": "# My Package",
      "package.json": JSON.stringify({
        name: "my-cool-package",
        version: "2.3.4",
        description: "A cool package",
      }),
    });

    const yaml = await initManifest(tmpDir);
    expect(yaml).toContain("project: my-cool-package");
    expect(yaml).toContain("version: 2.3.4");
  });

  it("detects project metadata from Cargo.toml", async () => {
    scaffold({
      "README.md": "# Rust Project",
      "Cargo.toml": '[package]\nname = "my-rust-crate"\nversion = "0.5.1"',
    });

    const yaml = await initManifest(tmpDir);
    expect(yaml).toContain("project: my-rust-crate");
    expect(yaml).toContain("version: 0.5.1");
  });

  it("detects project metadata from pom.xml", async () => {
    scaffold({
      "README.md": "# Java Project",
      "pom.xml": "<project><artifactId>my-java-app</artifactId><version>1.0.0</version></project>",
    });

    const yaml = await initManifest(tmpDir);
    expect(yaml).toContain("project: my-java-app");
  });

  it("detects project metadata from go.mod", async () => {
    scaffold({
      "README.md": "# Go Project",
      "go.mod": "module github.com/user/my-go-tool\n\ngo 1.21",
    });

    const yaml = await initManifest(tmpDir);
    expect(yaml).toContain("project: my-go-tool");
  });

  it("falls back to directory name when no project file found", async () => {
    scaffold({
      "README.md": "# Unnamed",
    });

    const yaml = await initManifest(tmpDir);
    const manifest = parseManifest(yaml);
    // Should use the tmpDir basename as the project name
    expect(manifest.project).toBeTruthy();
  });

  it("caps at 30 units and adds a skip comment", async () => {
    const files: Record<string, string> = {
      "README.md": "# Big Project",
    };
    // Create 35 source files to exceed the cap
    for (let i = 0; i < 35; i++) {
      files[`src/module${String(i).padStart(2, "0")}.ts`] = `// Module ${i}\nexport const m${i} = ${i};`;
    }
    scaffold(files);

    const yaml = await initManifest(tmpDir);
    const manifest = parseManifest(yaml);

    expect(manifest.units.length).toBeLessThanOrEqual(30);
    // The YAML should note how many were skipped
    expect(yaml).toContain("skipped");
  });

  it("--dry-run does not write to disk", async () => {
    scaffold({
      "README.md": "# Test",
    });

    const yaml = await initManifest(tmpDir, { dryRun: true });
    expect(yaml).toContain("kcp_version:");
    expect(existsSync(join(tmpDir, "knowledge.yaml"))).toBe(false);
  });

  it("uses --publisher when provided", async () => {
    scaffold({
      "README.md": "# Test",
    });

    const yaml = await initManifest(tmpDir, { publisher: "Acme Corp" });
    expect(yaml).toContain("Acme Corp");
    expect(yaml).not.toContain("TODO: set your publisher name");
  });

  it("adds TODO for publisher when not provided", async () => {
    scaffold({
      "README.md": "# Test",
    });

    const yaml = await initManifest(tmpDir);
    expect(yaml).toContain("TODO: set your publisher name");
  });

  it("scans source directories for files and subdirectories", async () => {
    scaffold({
      "README.md": "# Test",
      "src/auth.ts": "// Authentication module\nexport function login() {}",
      "src/utils/index.ts": "// Utility functions\nexport function helper() {}",
    });

    const yaml = await initManifest(tmpDir);
    const manifest = parseManifest(yaml);
    const ids = manifest.units.map((u) => u.id);

    expect(ids).toContain("front-door");
    expect(ids).toContain("auth");
    expect(ids).toContain("utils");
  });

  it("scans doc directories for markdown files", async () => {
    scaffold({
      "README.md": "# Test",
      "docs/guide.md": "# User Guide\nHow to use this.",
      "docs/faq.md": "# FAQ\nFrequently asked.",
    });

    const yaml = await initManifest(tmpDir);
    const manifest = parseManifest(yaml);
    const ids = manifest.units.map((u) => u.id);

    expect(ids).toContain("docs-guide");
    expect(ids).toContain("docs-faq");
  });

  it("scans example directories", async () => {
    scaffold({
      "README.md": "# Test",
      "examples/basic/README.md": "# Basic Example",
      "examples/advanced.ts": "// Advanced usage example",
    });

    const yaml = await initManifest(tmpDir);
    const manifest = parseManifest(yaml);
    const ids = manifest.units.map((u) => u.id);

    expect(ids).toContain("example-basic");
    expect(ids).toContain("example-advanced");
  });

  it("scans test directories", async () => {
    scaffold({
      "README.md": "# Test",
      "test/unit.test.ts": "// Unit tests",
    });

    const yaml = await initManifest(tmpDir);
    const manifest = parseManifest(yaml);
    const ids = manifest.units.map((u) => u.id);

    expect(ids).toContain("test-strategy");
  });

  it("generates triggers from filenames with known patterns", async () => {
    scaffold({
      "README.md": "# Test",
      "src/auth.ts": "// Auth module\nexport function login() {}",
    });

    const yaml = await initManifest(tmpDir);
    const manifest = parseManifest(yaml);
    const authUnit = manifest.units.find((u) => u.id === "auth");

    expect(authUnit).toBeDefined();
    expect(authUnit!.triggers).toContain("auth");
    expect(authUnit!.triggers).toContain("authentication");
  });

  it("extracts intents from JSDoc comments", async () => {
    scaffold({
      "README.md": "# Test",
      "src/planner.ts": "/** The deterministic planner scores units by task relevance. */\nexport function plan() {}",
    });

    const yaml = await initManifest(tmpDir);
    const manifest = parseManifest(yaml);
    const planner = manifest.units.find((u) => u.id === "planner");

    expect(planner).toBeDefined();
    expect(planner!.intent).toContain("deterministic planner");
    // Should NOT have the TODO marker since intent was extracted
    expect(yaml).not.toMatch(/planner[\s\S]*?# TODO: review intent[\s\S]*?(?=\n\s+-\s+id:|$)/);
  });

  it("extracts intents from markdown H1 headings", async () => {
    scaffold({
      "README.md": "# Test",
      "docs/migration.md": "# Database Migration Guide\nHow to migrate.",
    });

    const yaml = await initManifest(tmpDir);
    const manifest = parseManifest(yaml);
    const doc = manifest.units.find((u) => u.id === "docs-migration");

    expect(doc).toBeDefined();
    expect(doc!.intent).toBe("Database Migration Guide");
  });

  it("handles an empty project with only README", async () => {
    scaffold({
      "README.md": "# Solo Project\nJust a readme.",
    });

    const yaml = await initManifest(tmpDir);
    const manifest = parseManifest(yaml);
    expect(manifest.units.length).toBe(1);
    expect(manifest.units[0].id).toBe("front-door");

    // Still validates
    const findings = validateManifest(manifest, tmpDir);
    expect(findings.filter((f) => f.level === "error")).toEqual([]);
  });

  it("handles a project with no README gracefully", async () => {
    scaffold({
      "src/main.ts": "// Main entry point\nexport const run = () => {};",
    });

    const yaml = await initManifest(tmpDir);
    const manifest = parseManifest(yaml);
    // Should still produce units from source
    expect(manifest.units.length).toBeGreaterThanOrEqual(1);
    // front-door should not exist since there is no README
    expect(manifest.units.find((u) => u.id === "front-door")).toBeUndefined();
  });

  it("deduplicates unit ids", async () => {
    // Both lib/ and src/ could produce a unit named "auth"
    scaffold({
      "README.md": "# Test",
      "src/auth.ts": "// Auth from src",
      "lib/auth.ts": "// Auth from lib",
    });

    const yaml = await initManifest(tmpDir);
    const manifest = parseManifest(yaml);
    const authUnits = manifest.units.filter((u) => u.id === "auth");
    // First one wins, no duplicates
    expect(authUnits.length).toBe(1);
  });
});

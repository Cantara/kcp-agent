// The repo dogfoods KCP: knowledge.yaml at the root describes this repository.
// These tests keep that manifest honest — parseable, pointing at real files,
// and useful to the planner it ships.

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest } from "../src/client.js";
import { plan } from "../src/planner.js";
import type { Manifest } from "../src/model.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("the repo's own knowledge.yaml", () => {
  let manifest: Manifest;
  beforeAll(async () => {
    manifest = await loadManifest(repoRoot);
  });

  it("parses into the compact model", () => {
    expect(manifest.project).toBe("kcp-agent");
    expect(manifest.units.length).toBeGreaterThan(0);
    expect(manifest.manifests.map((m) => m.id)).toContain("kcp-spec");
  });

  // The manifest is what a consumer reads to learn which kcp-agent it is talking to, and
  // nothing tied it to the package version. It drifted to 0.18.0 while the package shipped
  // 0.21.0 — three releases of silently describing an older agent. The release process
  // bumps package.json; this makes forgetting the manifest fail rather than pass quietly.
  it("declares the same version as package.json", async () => {
    const pkg = JSON.parse(
      await readFile(join(repoRoot, "package.json"), "utf8"),
    ) as { version: string };
    expect(manifest.version, `knowledge.yaml ${manifest.version} vs package.json ${pkg.version}`).toBe(pkg.version);
  });

  it("declares only unit paths that exist on disk", () => {
    for (const unit of manifest.units) {
      expect(existsSync(join(repoRoot, unit.path)), `unit '${unit.id}' → ${unit.path}`).toBe(true);
    }
  });

  it("plans a typical task against itself", () => {
    const p = plan(manifest, "how does the deterministic planner score and select units?");
    const ids = p.selected.map((u) => u.id);
    expect(ids).toContain("planner");
    expect(p.selected.every((u) => u.loadEligible)).toBe(true);
  });
});

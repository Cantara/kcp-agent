// #98 — llms.txt is a radically weaker cousin of knowledge.yaml (a flat link list: no
// audiences, no temporal validity, no signatures, no payment, no federation) that the world
// adopted at meaningful scale. That proves publisher appetite exists; it just landed on the
// weakest available format. So: draft behind that adoption rather than compete with it.
//
// The conversion is deterministic — no LLM — which is what makes it testable at all and
// what lets a publisher re-run it and get the same file.

import { describe, expect, it } from "vitest";
import { parseLlmsTxt, generateManifestFromLlmsTxt } from "../src/llms-txt.js";
import { load } from "js-yaml";

const SAMPLE = `# Acme Docs

> Everything a developer needs to integrate Acme.

Some free prose the format allows and we ignore.

## Guides

- [Quickstart](https://acme.dev/quickstart): Get running in five minutes
- [Authentication](https://acme.dev/auth): API keys, rotation, and scopes

## Reference

- [HTTP API](https://acme.dev/api)

## Optional

- [Changelog](https://acme.dev/changelog): Release notes
`;

describe("parseLlmsTxt", () => {
  const doc = parseLlmsTxt(SAMPLE);

  it("reads the title from the H1", () => {
    expect(doc.title).toBe("Acme Docs");
  });

  it("reads the summary from the blockquote", () => {
    expect(doc.summary).toBe("Everything a developer needs to integrate Acme.");
  });

  it("groups links under their section", () => {
    expect(doc.sections.map((s) => s.name)).toEqual(["Guides", "Reference", "Optional"]);
    expect(doc.sections[0].links.map((l) => l.title)).toEqual(["Quickstart", "Authentication"]);
  });

  it("captures the optional per-link description", () => {
    expect(doc.sections[0].links[0].description).toBe("Get running in five minutes");
    expect(doc.sections[1].links[0].description).toBeUndefined();
  });

  it("keeps the URL intact", () => {
    expect(doc.sections[1].links[0].url).toBe("https://acme.dev/api");
  });

  it("tolerates a file with no sections at all", () => {
    const bare = parseLlmsTxt("# Just A Title\n\n> A summary.\n");
    expect(bare.title).toBe("Just A Title");
    expect(bare.sections).toEqual([]);
  });

  it("ignores prose lines that are not list items", () => {
    // The format permits arbitrary prose between sections; it carries no unit.
    const withProse = parseLlmsTxt("# T\n\n## S\n\nSome explanation.\n\n- [A](https://x.dev/a)\n");
    expect(withProse.sections[0].links).toHaveLength(1);
  });
});

describe("generateManifestFromLlmsTxt", () => {
  const yaml = generateManifestFromLlmsTxt(parseLlmsTxt(SAMPLE));
  const parsed = load(yaml) as Record<string, any>;

  it("produces parseable YAML with the project taken from the title", () => {
    expect(parsed.project).toBe("Acme Docs");
    expect(parsed.kcp_version).toBeDefined();
  });

  it("emits one unit per link, across every section", () => {
    expect(parsed.units).toHaveLength(4);
    expect(parsed.units.map((u: any) => u.id)).toEqual([
      "quickstart",
      "authentication",
      "http-api",
      "changelog",
    ]);
  });

  it("uses the link description as the intent when llms.txt supplies one", () => {
    expect(parsed.units[0].intent).toBe("Get running in five minutes");
  });

  it("falls back to the link title when there is no description", () => {
    expect(parsed.units[2].intent).toContain("HTTP API");
  });

  // A unit path is a file relative to the manifest (SPEC §4), so the absolute URL cannot be
  // one — emitting it produced a manifest that failed `kcp-agent validate`.
  it("relativises the URL into a unit path", () => {
    expect(parsed.units[0].path).toBe("quickstart");
  });

  it("lists off-origin links as federation TODOs rather than emitting invalid units", () => {
    const mixed = parseLlmsTxt(
      "# T\n\n## S\n\n- [Mine](https://acme.dev/a)\n- [Mine2](https://acme.dev/b)\n- [Theirs](https://other.dev/x)\n",
    );
    const out = generateManifestFromLlmsTxt(mixed);
    const units = (load(out) as any).units;
    expect(units.map((u: any) => u.path)).toEqual(["a", "b"]);
    expect(out).toMatch(/point at other origins/);
    expect(out).toMatch(/https:\/\/other\.dev\/x/);
  });

  // The section is the only grouping llms.txt has. Losing it would throw away the single
  // piece of structure the format does carry.
  it("carries the section name through as a trigger", () => {
    expect(parsed.units[0].triggers).toContain("guides");
  });

  it("marks what llms.txt cannot express, rather than inventing it", () => {
    // A converted manifest that silently claimed an audience or a validity window would be
    // asserting something the source never said.
    expect(yaml).toMatch(/TODO/);
    for (const field of ["valid_from", "valid_until", "signing", "payment"]) {
      expect(yaml, `${field} must not be fabricated`).not.toMatch(new RegExp(`^${field}:`, "m"));
    }
  });

  it("honours an explicit publisher", () => {
    const withPub = load(
      generateManifestFromLlmsTxt(parseLlmsTxt(SAMPLE), { publisher: "acme-corp" }),
    ) as Record<string, any>;
    expect(withPub.publisher).toBe("acme-corp");
  });

  it("de-duplicates ids when two links share a title", () => {
    const dup = parseLlmsTxt("# T\n\n## A\n\n- [Docs](https://x.dev/1)\n\n## B\n\n- [Docs](https://x.dev/2)\n");
    const ids = (load(generateManifestFromLlmsTxt(dup)) as any).units.map((u: any) => u.id);
    expect(new Set(ids).size, `ids collided: ${ids.join(", ")}`).toBe(ids.length);
  });

  it("refuses a document with no links rather than emitting an empty manifest", () => {
    expect(() => generateManifestFromLlmsTxt(parseLlmsTxt("# T\n\n> S\n"))).toThrow(/no links/i);
  });
});

// The issue names this as a constraint, not a nicety: a converter that emits something the
// validator rejects has handed the publisher a broken file and called it an upgrade.
describe("the generated manifest satisfies the validator", () => {
  it("passes `kcp-agent validate` end to end", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { validateLocation } = await import("../src/validate.js");

    const dir = mkdtempSync(join(tmpdir(), "kcp-llms-"));
    const yamlOut = generateManifestFromLlmsTxt(parseLlmsTxt(SAMPLE));
    writeFileSync(join(dir, "knowledge.yaml"), yamlOut);

    // The validator requires every unit path to resolve, which is the point: the manifest
    // belongs at the site root, beside the content it describes. A publisher converting
    // their own llms.txt has these; the test has to stand them up.
    for (const unit of (load(yamlOut) as any).units) {
      writeFileSync(join(dir, unit.path), `# ${unit.id}\n`);
    }

    const report = await validateLocation(dir);
    expect(report.ok, JSON.stringify(report.findings ?? report, null, 2)).toBe(true);
  });
});

// Docs with teeth: everything the site and README claim is pinned to code.
//   1. docs/conformance.json — every spec-layer row must name real impl files
//      and real tests; a conformance claim cannot outlive its proof.
//   2. The loop capture in docs/index.html must be verbatim output of
//      `node examples/demos.js loop --no-color` — narration cannot drift.
//   3. The CLI reference (cli.ts header comment + README options table) must
//      list exactly the flags parseArgs actually accepts, and vice versa.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

interface Proof { file: string; test: string }
interface Row { layer: string; section: string; where: string; impl: string[]; proofs: Proof[] }

describe("conformance matrix (docs/conformance.json)", () => {
  const data = JSON.parse(read("docs/conformance.json")) as { spec: string; rows: Row[] };

  it("covers the spec layers the README claims", () => {
    expect(data.spec).toBe("KCP 0.25");
    expect(data.rows.length).toBeGreaterThanOrEqual(10);
    const sections = data.rows.map((r) => r.section);
    for (const s of ["§15", "§4", "§4.11", "§4.22", "§3.2", "§3.6", "§4.14", "§4.15", "§2"]) {
      expect(sections).toContain(s);
    }
    expect(new Set(data.rows.map((r) => r.layer)).size).toBe(data.rows.length);
  });

  it("every implementation file it points at exists", () => {
    for (const row of data.rows) {
      expect(row.impl.length).toBeGreaterThan(0);
      for (const f of row.impl) expect(existsSync(path.join(ROOT, f)), `${row.layer}: ${f}`).toBe(true);
    }
  });

  it("every proof names a test that actually exists in the referenced file", () => {
    for (const row of data.rows) {
      expect(row.proofs.length, `${row.layer} has no proofs`).toBeGreaterThan(0);
      for (const p of row.proofs) {
        expect(existsSync(path.join(ROOT, p.file)), `${row.layer}: ${p.file}`).toBe(true);
        const source = read(p.file);
        expect(source.includes(`"${p.test}"`), `${p.file} must contain a test named "${p.test}"`).toBe(true);
      }
    }
  });
});

describe("the loop capture in docs/index.html", () => {
  it("is verbatim output of `examples/demos.js loop` — the narration cannot drift", () => {
    const html = read("docs/index.html");
    const m = html.match(/<section id="loop"[\s\S]*?<pre class="capture"><code>([\s\S]*?)<\/code><\/pre>/);
    expect(m, "loop section must contain a capture").toBeTruthy();
    const capture = m![1]
      .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
    const out = execFileSync("node", [path.join(ROOT, "examples", "demos.js"), "loop", "--no-color"], {
      cwd: ROOT, encoding: "utf8",
    });
    const lines = capture
      .split("\n").map((l) => l.trim())
      .filter((l) => l && !l.startsWith("$") && !l.endsWith("\\"));
    expect(lines.length).toBeGreaterThanOrEqual(8);
    for (const line of lines) expect(out, `capture line not in demo output: "${line}"`).toContain(line);
  }, 30_000);
});

describe("CLI reference", () => {
  const cli = read("src/cli.ts");
  const header = cli.split("import type")[0]; // the option-doc comment block
  const readme = read("README.md");
  const switchFlags = [...cli.matchAll(/case "(--[a-z-]+)":/g)].map((m) => m[1]);
  const headerFlags = [...header.matchAll(/^\/\/\s+(--[a-z-]+)/gm)].map((m) => m[1]);

  it("parseArgs accepts at least the classic option set", () => {
    expect(switchFlags).toContain("--manifest");
    expect(switchFlags.length).toBeGreaterThanOrEqual(17);
  });

  it("every flag parseArgs accepts is documented in the cli.ts header and README", () => {
    for (const f of switchFlags) {
      expect(headerFlags, `cli.ts header comment is missing ${f}`).toContain(f);
      expect(readme.includes("`" + f), `README is missing ${f}`).toBe(true);
    }
  });

  it("the header documents no flag that parseArgs does not accept", () => {
    for (const f of headerFlags) expect(switchFlags, `header documents unknown flag ${f}`).toContain(f);
  });
});

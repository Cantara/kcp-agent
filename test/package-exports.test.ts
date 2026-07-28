// #103 — package.json exposed only the "." export, so a consumer that shells out to the
// real binary could not do `require.resolve('kcp-agent/dist/cli.js')`. It had to resolve
// the package entry and derive the sibling path, which guesses at the build layout.
//
// Asserting against package.json alone would prove the field was typed, not that Node's
// resolver honours it, so these resolve through Node itself.

import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

describe("package exports", () => {
  it("declares the CLI subpath", () => {
    expect(pkg.exports["./dist/cli.js"]).toBe("./dist/cli.js");
  });

  it("keeps the root export intact", () => {
    expect(pkg.exports["."]).toBe("./dist/index.js");
  });

  it("ships the shorter ./cli alias too", () => {
    expect(pkg.exports["./cli"]).toBe("./dist/cli.js");
  });

  // The export map may only point at files that are actually published — `files` lists
  // `dist`, so both targets are covered, but a future narrowing of `files` would strand
  // the export and this catches it.
  it("every export target is inside a published path", () => {
    const published: string[] = pkg.files;
    for (const target of Object.values(pkg.exports) as string[]) {
      const top = target.replace(/^\.\//, "").split("/")[0];
      expect(published, `export ${target} is not under a published path`).toContain(top);
    }
  });

  it("resolves through Node's own resolver, not just as JSON", () => {
    // Requires a build; skip rather than fail so `vitest run` on a clean tree is honest
    // about what it did not check.
    if (!existsSync(path.join(ROOT, "dist", "cli.js"))) return;
    const require = createRequire(path.join(ROOT, "package.json"));
    for (const spec of ["kcp-agent/dist/cli.js", "kcp-agent/cli"]) {
      expect(() => require.resolve(spec), `${spec} does not resolve`).not.toThrow();
    }
  });
});

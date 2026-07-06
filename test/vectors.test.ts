// Spec conformance vectors (#34). Each vector in vectors/ is a frozen
// (manifest, task, options) → expected-outcome fixture. This test proves the
// reference TS planner reproduces every one exactly; a second implementation
// (e.g. a Go port) is conformant iff it does the same. The corpus is generated
// from this planner by scripts/gen-vectors.mjs — so a drift here means either a
// real regression or an intentional planner change that must be regenerated and
// reviewed.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runVector, type ConformanceVector } from "../src/vectors.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vectors");
const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
const vectors = files.map((f) => JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as ConformanceVector);

describe("conformance vectors — the reference planner reproduces every frozen outcome", () => {
  it("ships a non-trivial corpus covering the core spec layers", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(10);
    const layers = new Set(vectors.map((v) => v.spec));
    for (const s of ["§15", "§4", "§4.11", "§4.22", "§3.2", "§3.6", "§4.14", "§4.15"]) {
      expect(layers, `no vector covers ${s}`).toContain(s);
    }
  });

  it("every vector's name matches its filename (stable, addressable corpus)", () => {
    for (let i = 0; i < files.length; i++) {
      expect(`${vectors[i].name}.json`).toBe(files[i]);
    }
  });

  for (const v of vectors) {
    it(`${v.name} (${v.spec}): ${v.description}`, () => {
      expect(runVector(v)).toEqual(v.expect);
    });
  }
});

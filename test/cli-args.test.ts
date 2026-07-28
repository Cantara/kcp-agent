// The CLI's help text and its argument parser are two independent lists of flags, and
// nothing kept them in agreement. Five flags were documented in USAGE and had no `case`
// in the parser — `init --dry-run`, `--force`, `--publisher` and `watch --once`, `--diff`
// all exited with `Unknown option` before their handler ran. The features behind them
// were implemented and unit-tested; only the way a user reaches them was broken, and no
// test covered that seam.
//
// So the gate is not "these five flags now work" — that would pass forever while the next
// documented flag drifts. The gate derives its expectations from the help text itself:
// every `--flag` the CLI advertises must parse.

import { describe, expect, it } from "vitest";
import { OPTIONS, USAGE, UnknownOptionError, parseArgs } from "../src/cli.js";

/** Every distinct `--flag` token the CLI advertises to users. */
function documentedFlags(): string[] {
  const found = new Set<string>();
  for (const text of [USAGE, OPTIONS]) {
    for (const m of text.matchAll(/--[a-z][a-z0-9-]*/g)) found.add(m[0]);
  }
  return [...found].sort();
}

/**
 * Flags that take a value need one supplied, or the parser consumes the following token
 * and the assertion becomes about argument order rather than about the flag existing.
 * Passing a value to a boolean flag is harmless — it lands in positionals.
 */
function invocationFor(flag: string): string[] {
  return ["plan", flag, "x"];
}

describe("every documented flag is accepted by the parser", () => {
  const flags = documentedFlags();

  it("finds the documented flags at all (guards the regex itself)", () => {
    // If USAGE were reformatted such that this scrape returned nothing, every assertion
    // below would vacuously pass. Pin a floor and a few known members.
    expect(flags.length).toBeGreaterThan(20);
    expect(flags).toContain("--manifest");
    expect(flags).toContain("--json");
  });

  for (const flag of flags) {
    it(`accepts ${flag}`, () => {
      expect(() => parseArgs(invocationFor(flag))).not.toThrow();
    });
  }
});

describe("the five flags that were unreachable (issue #126)", () => {
  it("watch --once sets once", () => {
    expect(parseArgs(["watch", "knowledge.yaml", "--once"]).once).toBe(true);
  });

  it("watch --diff sets diff", () => {
    expect(parseArgs(["watch", "knowledge.yaml", "--diff"]).diff).toBe(true);
  });

  it("init --dry-run sets dryRun", () => {
    expect(parseArgs(["init", ".", "--dry-run"]).dryRun).toBe(true);
  });

  it("init --force sets force", () => {
    expect(parseArgs(["init", ".", "--force"]).force).toBe(true);
  });

  // --publisher was not merely unparsed: it did not exist. USAGE advertised it while the
  // handler read `a.attest`, so `--publisher acme` was an error and `--attest acme` was
  // the undocumented way to do it.
  it("init --publisher takes a value, distinct from --attest", () => {
    const a = parseArgs(["init", ".", "--publisher", "acme"]);
    expect(a.publisher).toBe("acme");
    expect(a.attest).toBeUndefined();
  });

  it("positionals survive alongside the new flags", () => {
    const a = parseArgs(["init", "/tmp/x", "--dry-run", "--force"]);
    expect(a.positionals).toEqual(["/tmp/x"]);
  });
});

describe("unknown options still fail", () => {
  it("throws UnknownOptionError naming the flag", () => {
    expect(() => parseArgs(["plan", "--not-a-real-flag"])).toThrow(UnknownOptionError);
    expect(() => parseArgs(["plan", "--not-a-real-flag"])).toThrow(/--not-a-real-flag/);
  });

  it("does not mistake a negative number or a bare word for a flag", () => {
    expect(() => parseArgs(["plan", "some task", "-5"])).not.toThrow();
  });
});

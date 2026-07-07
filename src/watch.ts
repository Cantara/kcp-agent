// Watch mode — persistent manifest monitoring.
//
// Monitors a manifest file and all declared unit paths for changes, then
// re-validates and optionally re-plans on each change. Debounced to avoid
// re-firing on partial saves. Supports `--once` mode for CI gating.

import { watch as fsWatch, existsSync, statSync, readFileSync, type FSWatcher } from "node:fs";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { loadManifestText, parseManifest } from "./client.js";
import { validateManifest, type ValidationReport } from "./validate.js";
import { plan, type PlanOptions, type AgentPlan } from "./planner.js";
import { diffPlans, type PlanDiff } from "./diff.js";
import { formatValidation, formatDiff } from "./format.js";
import type { FetchGuard } from "./fetch.js";
import type { Manifest } from "./model.js";

export interface WatchOptions {
  /** A pinned task — re-plan on every change. */
  task?: string;
  /** Show plan diffs between changes. */
  diff?: boolean;
  /** Emit newline-delimited JSON events instead of human-readable output. */
  json?: boolean;
  /** Fail-closed: drop non-eligible units instead of listing them. */
  strict?: boolean;
  /** Validate once, then exit (CI mode). */
  once?: boolean;
  /** Planner options forwarded to `plan()`. */
  planOptions?: PlanOptions;
  /** Fetch guard for manifest loading. */
  fetchGuard?: FetchGuard;
}

/** A JSON event emitted in `--json` mode. */
export interface WatchEvent {
  type: "validate" | "plan" | "diff";
  timestamp: string;
  data: unknown;
}

/** Internal result of a single watch cycle. */
export interface WatchCycleResult {
  validation: ValidationReport;
  plan?: AgentPlan;
  diff?: PlanDiff;
}

/**
 * Run a single validation (and optionally plan + diff) cycle.
 * Pure enough to unit-test — the I/O is just `loadManifestText`.
 */
export async function runCycle(
  location: string,
  previousPlan: AgentPlan | undefined,
  options: WatchOptions,
): Promise<WatchCycleResult> {
  const fetchGuard = options.fetchGuard ?? {};

  // Load and validate.
  let text: string;
  let source: string;
  try {
    ({ text, source } = await loadManifestText(location, fetchGuard));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const report: ValidationReport = {
      source: location,
      findings: [{ level: "error", where: "manifest", message }],
      ok: false,
    };
    return { validation: report };
  }

  let manifest: Manifest;
  try {
    manifest = parseManifest(text, source);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const report: ValidationReport = {
      source,
      findings: [{ level: "error", where: "manifest", message: `does not parse: ${message}` }],
      ok: false,
    };
    return { validation: report };
  }

  const baseDir = /^https?:\/\//.test(source) ? undefined : dirname(source);
  const findings = validateManifest(manifest, baseDir);
  const validation: ValidationReport = {
    source,
    project: manifest.project,
    findings,
    ok: !findings.some((f) => f.level === "error"),
  };

  const result: WatchCycleResult = { validation };

  // Plan if a task is pinned.
  if (options.task) {
    const planOpts: PlanOptions = {
      ...options.planOptions,
      strict: options.strict ?? options.planOptions?.strict,
    };
    result.plan = plan(manifest, options.task, planOpts);

    // Diff if requested and a previous plan exists.
    if (options.diff && previousPlan) {
      result.diff = diffPlans(previousPlan, result.plan);
    }
  }

  return result;
}

/** Format and output a cycle result. */
function emitHuman(result: WatchCycleResult): void {
  console.log(formatValidation(result.validation));
  if (result.diff && !result.diff.identical) {
    console.log(formatDiff(result.diff));
  } else if (result.diff?.identical) {
    console.log("  (plan unchanged)");
  }
}

/** Emit a JSON event to stdout. */
function emitJson(event: WatchEvent): void {
  console.log(JSON.stringify(event));
}

/** Emit cycle results as JSON events. */
function emitJsonCycle(result: WatchCycleResult): void {
  const ts = new Date().toISOString();
  emitJson({ type: "validate", timestamp: ts, data: result.validation });
  if (result.plan) {
    emitJson({ type: "plan", timestamp: ts, data: result.plan });
  }
  if (result.diff) {
    emitJson({ type: "diff", timestamp: ts, data: result.diff });
  }
}

/**
 * Resolve the manifest file path and all its unit paths for watching.
 * Returns the manifest path and an array of absolute unit paths that exist.
 */
function resolveWatchPaths(location: string): { manifestPath: string; unitPaths: string[] } {
  let manifestPath = location;

  if (existsSync(manifestPath) && statSync(manifestPath).isDirectory()) {
    const candidates = [
      join(manifestPath, "knowledge.yaml"),
      join(manifestPath, ".well-known", "knowledge.yaml"),
    ];
    manifestPath = candidates.find((c) => existsSync(c)) ?? manifestPath;
  }

  manifestPath = isAbsolute(manifestPath) ? manifestPath : resolve(manifestPath);

  // Try to parse the manifest to get unit paths.
  const unitPaths: string[] = [];
  try {
    const text = readFileSync(manifestPath, "utf8");
    const manifest = parseManifest(text, manifestPath);
    const baseDir = dirname(manifestPath);
    for (const unit of manifest.units) {
      const unitPath = isAbsolute(unit.path) ? unit.path : join(baseDir, unit.path);
      if (existsSync(unitPath)) {
        unitPaths.push(unitPath);
      }
    }
  } catch {
    // If we cannot parse the manifest, just watch the manifest itself.
  }

  return { manifestPath, unitPaths };
}

/**
 * Watch a manifest and its units for changes, re-validating (and optionally
 * re-planning) on each change. In `--once` mode, validates once and returns
 * the exit code.
 *
 * @returns In `--once` mode: a promise that resolves to 0 (clean) or 1 (errors).
 *          In watch mode: a promise that never resolves (runs until killed), or
 *          resolves to 0 if stopped via the returned controller.
 */
export async function watchManifest(
  location: string,
  options: WatchOptions = {},
): Promise<{ exitCode: number; close: () => void }> {
  // -- Once mode: validate once, return exit code. --
  const result = await runCycle(location, undefined, options);

  if (options.json) {
    emitJsonCycle(result);
  } else {
    emitHuman(result);
  }

  if (options.once) {
    return { exitCode: result.validation.ok ? 0 : 1, close: () => {} };
  }

  // -- Persistent watch mode. --
  let previousPlan = result.plan;
  const watchers: FSWatcher[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const onChange = async () => {
    if (closed) return;
    try {
      const cycleResult = await runCycle(location, previousPlan, options);
      if (options.json) {
        emitJsonCycle(cycleResult);
      } else {
        emitHuman(cycleResult);
      }
      if (cycleResult.plan) {
        previousPlan = cycleResult.plan;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (options.json) {
        emitJson({
          type: "validate",
          timestamp: new Date().toISOString(),
          data: { source: location, findings: [{ level: "error", where: "watch", message }], ok: false },
        });
      } else {
        console.error(`watch error: ${message}`);
      }
    }
  };

  const debouncedOnChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      onChange();
    }, 150);
  };

  // Resolve paths and set up watchers.
  const { manifestPath, unitPaths } = resolveWatchPaths(location);

  const startWatcher = (path: string): FSWatcher | null => {
    try {
      const w = fsWatch(path, { persistent: true }, debouncedOnChange);
      w.on("error", () => {
        // File may have been deleted; report it on the next cycle.
      });
      return w;
    } catch {
      // Cannot watch this path — the cycle will report the error.
      return null;
    }
  };

  const mw = startWatcher(manifestPath);
  if (mw) watchers.push(mw);

  for (const unitPath of unitPaths) {
    const uw = startWatcher(unitPath);
    if (uw) watchers.push(uw);
  }

  const close = () => {
    closed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const w of watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    watchers.length = 0;
  };

  // Return the controller; the process stays alive because watchers keep the event loop open.
  return { exitCode: 0, close };
}

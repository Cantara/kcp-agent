// Human-readable rendering of plans, plan trees, validation reports, traces, and diffs.

import type { AgentPlan } from "./planner.js";
import type { PlanNode } from "./follow.js";
import type { ValidationReport } from "./validate.js";
import type { ReplayReport } from "./replay.js";
import type { GroundedAnswer } from "./ground.js";
import type { GroundedReplayReport } from "./replayground.js";
import type { Recalled } from "./memory.js";
import type { DecisionTrace } from "./trace.js";
import type { PlanDiff } from "./diff.js";

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
const c = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
};

export function formatPlan(p: AgentPlan): string {
  const out: string[] = [];
  out.push("");
  out.push(c.bold(`Plan for: "${p.task}"`));
  out.push(
    c.dim(
      `  ${p.manifest.project} v${p.manifest.version}` +
        (p.manifest.kcpVersion ? ` · kcp ${p.manifest.kcpVersion}` : "") +
        (p.manifest.source ? ` · ${p.manifest.source}` : "") +
        ` · as-of ${p.asOf}` +
        (p.environment ? ` · env ${p.environment}` : "")
    )
  );
  out.push("");

  // trust
  const trustLine = p.trust.requiresAttestation
    ? p.trust.agentCanAttest
      ? c.green("✓ attestation required — agent can present it")
      : c.yellow("⚠ attestation required — agent cannot present it (restricted units gated)")
    : c.dim("· no manifest attestation requirement");
  out.push(c.bold("Trust: ") + trustLine);
  if (p.signature) {
    const s = p.signature;
    const line =
      s.status === "verified"
        ? c.green(`✓ ${s.detail}${s.keyId ? ` · key ${s.keyId}` : ""}`)
        : s.status === "invalid"
          ? c.red(`✗ ${s.detail}`)
          : s.status === "unverifiable"
            ? c.yellow(`⚠ signature unverifiable — ${s.detail}`)
            : c.dim(`· ${s.detail}`);
    out.push(c.bold("Signature: ") + line);
  }
  if (p.serving) {
    const s = p.serving;
    const line =
      s.status === "bound"
        ? c.green(`✓ ${s.detail}`)
        : s.status === "unbound"
          ? c.yellow(`⚠ ${s.detail}`)
          : c.dim(`· ${s.detail}`);
    out.push(c.bold("Serving: ") + line);
  }
  out.push("");

  // selected
  out.push(c.bold(`Load plan (${p.selected.length} unit${p.selected.length === 1 ? "" : "s"}):`));
  if (p.selected.length === 0) out.push(c.dim("  (no units selected)"));
  p.selected.forEach((u, i) => {
    const mark = u.loadEligible ? c.green("●") : c.red("○");
    const cost = u.payment.method === "free" ? "free" : u.payment.cost ?? u.payment.method;
    out.push(`  ${mark} ${c.bold(`${i + 1}. ${u.id}`)} ${c.dim(`(score ${u.score})`)}  ${c.dim(u.path)}  ${c.cyan(cost)}`);
    out.push(`     ${c.dim(u.intent)}`);
    out.push(`     ${c.dim("why: " + u.reasons.join("; "))}`);
    if (!u.loadEligible) out.push(`     ${c.red("not load-eligible")}`);
  });
  out.push("");

  // budget
  out.push(c.bold("Budget: ") +
    `tier ${c.cyan(p.budget.rateTier)}` +
    (p.budget.requestsPerMinute !== undefined ? c.dim(` · ${p.budget.requestsPerMinute} req/min`) : "") +
    (p.budget.ceiling !== undefined
      ? c.cyan(` · ${p.budget.projectedSpend}/${p.budget.ceiling} ${p.budget.currency}`) + c.dim(` (${p.budget.remaining} remaining)`)
      : ""));
  if (p.budget.perRequestCosts.length) {
    for (const rc of p.budget.perRequestCosts) out.push(c.dim(`  pay-per-request: ${rc.unit} → ${rc.cost}`));
  }
  out.push(c.dim("  " + p.budget.note));
  out.push("");

  // context budget (only when the agent planned with one)
  if (p.context.ceiling !== undefined) {
    out.push(c.bold("Context: ") +
      c.cyan(`${p.context.projectedTokens?.toLocaleString("en-US")}/${p.context.ceiling.toLocaleString("en-US")} tokens`) +
      c.dim(` (${p.context.remaining?.toLocaleString("en-US")} remaining)`));
    out.push(c.dim("  " + p.context.note));
    out.push("");
  }

  // federation
  if (p.federation.length) {
    out.push(c.bold("Federation:"));
    for (const f of p.federation) {
      const mark = f.selected ? c.green("→") : c.dim("·");
      const cred = f.credentialNeeded ? c.yellow(` [acquire ${f.credentialNeeded}]`) : "";
      out.push(`  ${mark} ${f.id} ${c.dim(f.reason)}${cred}`);
    }
    out.push("");
  }

  // skipped
  if (p.skipped.length) {
    out.push(c.dim(`Skipped (${p.skipped.length}):`));
    for (const s of p.skipped) out.push(c.dim(`  · ${s.id}: ${s.reason}`));
    out.push("");
  }

  if (p.warnings.length) {
    for (const w of p.warnings) out.push(c.yellow(`⚠ ${w}`));
    out.push("");
  }
  return out.join("\n");
}

/** Render a federated plan tree: the root plan, then each followed manifest's plan, indented by hop. */
export function formatPlanTree(node: PlanNode): string {
  const out: string[] = [];
  const walk = (n: PlanNode, depth: number) => {
    const indent = "  ".repeat(depth);
    if (depth > 0) {
      out.push("");
      out.push(indent + c.bold(`═ federated: ${n.refId}`) + " " + c.dim(n.location));
    }
    if (n.error) {
      out.push(indent + c.red(`  ✗ ${n.error}`));
      return;
    }
    if (n.plan) {
      const body = formatPlan(n.plan);
      out.push(depth === 0 ? body : body.split("\n").map((l) => (l ? indent + l : l)).join("\n"));
    }
    const followable = n.notFollowed.filter((r) => r.reason.startsWith("beyond max depth") || r.reason.includes("cycle"));
    for (const r of followable) {
      out.push(indent + c.dim(`  (not followed: ${r.id} — ${r.reason})`));
    }
    for (const child of n.children) walk(child, depth + 1);
  };
  walk(node, 0);
  return out.join("\n");
}

/** Render a replay report: per-manifest verdicts, then the single-line judgment. */
export function formatReplay(r: ReplayReport): string {
  const out: string[] = [];
  out.push("");
  out.push(c.bold(`Replay: ${r.artifact}`));
  for (const ch of r.checks) {
    const mark = ch.status === "identical" ? c.green("✓") : ch.status === "drifted" ? c.red("✗") : c.yellow("⚠");
    out.push(`  ${mark} ${c.bold(ch.project)} ${c.dim(ch.source)}`);
    out.push(
      "     " +
        (ch.status === "identical" ? c.dim(ch.detail) : ch.status === "drifted" ? c.red(`drifted: ${ch.detail}`) : c.yellow(`error: ${ch.detail}`))
    );
  }
  out.push("");
  out.push(
    r.ok
      ? c.green("✓ deterministic: every saved plan reproduced byte-identically")
      : c.red("✗ drift detected — the saved artifact no longer matches the world")
  );
  out.push("");
  return out.join("\n");
}

/** Render a grounded answer: the grounded claims with their citations, then the surfaced gaps. */
export function formatGrounded(g: GroundedAnswer): string {
  const out: string[] = [];
  out.push("");
  out.push(c.bold(`Grounded (${g.grounded.length}/${g.claims.length} claim${g.claims.length === 1 ? "" : "s"}):`));
  for (const claim of g.grounded) {
    out.push(`  ${c.green("●")} ${claim.claim}`);
    out.push(`     ${c.dim(`↳ ${claim.unitId} · sha ${(claim.sha256 ?? "").slice(0, 12)}`)}`);
  }
  if (g.gaps.length) {
    out.push("");
    out.push(c.bold(c.yellow(`Unsubstantiated (${g.gaps.length}):`)) + c.dim(" — could not be grounded in a loaded unit"));
    for (const gap of g.gaps) {
      out.push(`  ${c.yellow("○")} ${gap.claim}`);
      out.push(`     ${c.dim(gap.reason)}`);
    }
    if (g.gapsTruncated > 0) out.push(c.dim(`  … and ${g.gapsTruncated} more (surfaced list capped)`));
  }
  out.push("");
  out.push(
    g.status === "grounded"
      ? c.green("✓ grounded — every claim is backed by a loaded, hash-pinned unit")
      : c.yellow(`⚠ partial-unsupported — ${g.gaps.length + g.gapsTruncated} claim(s) could not be substantiated`)
  );
  out.push("");
  return out.join("\n");
}

/** Render a grounded-answer replay: per-claim re-verification, then the gap lifecycle. */
export function formatGroundedReplay(r: GroundedReplayReport): string {
  const out: string[] = [];
  out.push("");
  out.push(c.bold(`Replay (grounded answer): ${r.artifact}`));
  for (const ch of r.claims) {
    const mark = ch.status === "still-grounded" ? c.green("✓") : c.red("✗");
    const label =
      ch.status === "still-grounded" ? c.green(ch.status) : c.red(ch.status);
    out.push(`  ${mark} ${label} ${c.bold(ch.unitId)} ${c.dim("· " + ch.claim)}`);
    out.push(`     ${c.dim(ch.detail)}`);
  }
  for (const g of r.gaps) {
    const mark = g.status === "gap-closes" ? c.green("↑") : c.dim("·");
    const label = g.status === "gap-closes" ? c.green(g.status) : c.dim(g.status);
    out.push(`  ${mark} ${label} ${c.dim(g.claim)}`);
    out.push(`     ${c.dim(g.detail)}`);
  }
  out.push("");
  out.push(
    r.ok
      ? c.green("✓ still grounded — every cited unit holds its pinned bytes")
      : c.red("✗ stale — a cited unit drifted or is gone; re-run `ask --ground` against today's manifest")
  );
  out.push("");
  return out.join("\n");
}

/** Render recalled episodes — each with its lexical score and (if replayed) freshness. */
export function formatRecall(task: string, hits: Recalled[]): string {
  const out: string[] = [];
  out.push("");
  out.push(c.bold(`Recall: ${task}`));
  if (hits.length === 0) {
    out.push(c.dim("  (no episode overlaps this task)"));
    out.push("");
    return out.join("\n");
  }
  for (const h of hits) {
    const mark =
      h.status === "valid" ? c.green("✓") : h.status === "drifted" ? c.red("✗") : c.dim("?");
    const label =
      h.status === "valid" ? c.green(h.status) : h.status === "drifted" ? c.red(h.status) : c.dim(h.status);
    out.push(`  ${mark} ${label} ${c.cyan(h.entry.kind)} ${c.dim("· score " + h.score)} ${c.bold(h.entry.task)}`);
    out.push(`     ${c.dim(h.entry.id.slice(0, 12) + "… · " + h.entry.recordedAt + " · " + (h.entry.manifestSource ?? "?"))}`);
    out.push(`     ${c.dim(h.detail)}`);
  }
  out.push("");
  return out.join("\n");
}

/** Render a validation report. */
export function formatValidation(report: ValidationReport): string {
  const out: string[] = [];
  out.push("");
  out.push(c.bold(`Validate: ${report.source}`) + (report.project ? c.dim(` (${report.project})`) : ""));
  const errors = report.findings.filter((f) => f.level === "error");
  const warnings = report.findings.filter((f) => f.level === "warning");
  for (const f of report.findings) {
    const mark = f.level === "error" ? c.red("✗") : c.yellow("⚠");
    out.push(`  ${mark} ${c.bold(f.where)}: ${f.message}`);
  }
  out.push("");
  out.push(
    errors.length === 0
      ? c.green(`✓ valid`) + c.dim(` — ${warnings.length} warning(s)`)
      : c.red(`✗ invalid`) + c.dim(` — ${errors.length} error(s), ${warnings.length} warning(s)`)
  );
  out.push("");
  return out.join("\n");
}

/** Render a decision trace: the gate cascade for every unit in the manifest. */
export function formatTrace(t: DecisionTrace): string {
  const out: string[] = [];
  out.push("");
  out.push(c.bold("Decision Trace"));
  out.push(c.dim(`  ${t.units.length} units evaluated · ${t.taskTerms.length} search terms: ${t.taskTerms.join(", ")}`));
  out.push("");

  // Gate summary
  out.push(c.bold("Gate summary:"));
  for (const gs of t.gateSummary) {
    if (gs.passed === 0 && gs.failed === 0) continue; // gate never reached
    const bar = gs.failed > 0
      ? `${c.green(String(gs.passed))} passed, ${c.red(String(gs.failed))} rejected`
      : c.green(`${gs.passed} passed`);
    out.push(`  ${c.dim(gs.gate.padEnd(16))} ${bar}`);
  }
  out.push("");

  // Per-unit cascade
  for (const u of t.units) {
    const mark = u.outcome === "selected" ? c.green("●") : c.red("○");
    const scorePart = u.score !== undefined ? c.dim(` (score ${u.score})`) : "";
    out.push(`${mark} ${c.bold(u.id)}${scorePart} ${c.dim(u.path)}`);
    for (const g of u.gates) {
      const gMark = g.passed ? c.green("  ✓") : c.red("  ✗");
      out.push(`${gMark} ${c.dim(g.gate.padEnd(16))} ${g.detail}`);
    }
    out.push("");
  }

  const selected = t.units.filter((u) => u.outcome === "selected").length;
  const skipped = t.units.filter((u) => u.outcome === "skipped").length;
  out.push(c.dim(`${selected} selected, ${skipped} skipped`));
  out.push("");
  return out.join("\n");
}

/** Render a plan diff: what changed between two plan artifacts. */
export function formatDiff(d: PlanDiff): string {
  const out: string[] = [];
  out.push("");
  out.push(c.bold("Plan Diff"));
  out.push(c.dim(`  A: ${d.a.project} v${d.a.version} · "${d.a.task}" · ${d.a.asOf}`));
  out.push(c.dim(`  B: ${d.b.project} v${d.b.version} · "${d.b.task}" · ${d.b.asOf}`));
  out.push("");

  if (d.identical) {
    out.push(c.green("✓ plans are identical"));
    out.push("");
    return out.join("\n");
  }

  if (d.moves.length) {
    out.push(c.bold(`Moves (${d.moves.length}):`));
    for (const m of d.moves) {
      const arrow = m.direction === "selected_to_skipped"
        ? c.red("selected → skipped")
        : c.green("skipped → selected");
      out.push(`  ${c.bold(m.id)}: ${arrow}`);
      if (m.from.score !== undefined) out.push(`    ${c.dim(`was: score ${m.from.score}`)}`);
      if (m.from.reason) out.push(`    ${c.dim(`was: ${m.from.reason}`)}`);
      if (m.to.score !== undefined) out.push(`    ${c.dim(`now: score ${m.to.score}`)}`);
      if (m.to.reason) out.push(`    ${c.dim(`now: ${m.to.reason}`)}`);
    }
    out.push("");
  }

  if (d.scoreChanges.length) {
    out.push(c.bold(`Score changes (${d.scoreChanges.length}):`));
    for (const s of d.scoreChanges) {
      const dir = s.delta > 0 ? c.green(`+${s.delta}`) : c.red(String(s.delta));
      out.push(`  ${c.bold(s.id)}: ${s.before} → ${s.after} (${dir})`);
    }
    out.push("");
  }

  if (d.presence.length) {
    out.push(c.bold(`Units added/removed (${d.presence.length}):`));
    for (const p of d.presence) {
      const mark = p.side === "b_only" ? c.green("+") : c.red("-");
      out.push(`  ${mark} ${p.id} ${c.dim(p.side === "b_only" ? "(new in B)" : "(removed in B)")}`);
    }
    out.push("");
  }

  if (d.budgetShifts.length) {
    out.push(c.bold("Budget/context shifts:"));
    for (const b of d.budgetShifts) {
      out.push(`  ${c.dim(b.field)}: ${b.before ?? "—"} → ${b.after ?? "—"}`);
    }
    out.push("");
  }

  if (d.reasonChanges.length) {
    out.push(c.bold(`Reason changes (${d.reasonChanges.length}):`));
    for (const r of d.reasonChanges) {
      out.push(`  ${c.bold(r.id)}`);
      out.push(`    ${c.dim(`was: ${r.before}`)}`);
      out.push(`    ${c.dim(`now: ${r.after}`)}`);
    }
    out.push("");
  }

  if (d.warningChanges.added.length || d.warningChanges.removed.length) {
    out.push(c.bold("Warning changes:"));
    for (const w of d.warningChanges.added) out.push(`  ${c.green("+")} ${w}`);
    for (const w of d.warningChanges.removed) out.push(`  ${c.red("-")} ${w}`);
    out.push("");
  }

  return out.join("\n");
}

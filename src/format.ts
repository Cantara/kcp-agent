// Human-readable rendering of plans, plan trees, and validation reports.

import type { AgentPlan } from "./planner.js";
import type { PlanNode } from "./follow.js";
import type { ValidationReport } from "./validate.js";

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
    (p.budget.requestsPerMinute !== undefined ? c.dim(` · ${p.budget.requestsPerMinute} req/min`) : ""));
  if (p.budget.perRequestCosts.length) {
    for (const rc of p.budget.perRequestCosts) out.push(c.dim(`  pay-per-request: ${rc.unit} → ${rc.cost}`));
  }
  out.push(c.dim("  " + p.budget.note));
  out.push("");

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

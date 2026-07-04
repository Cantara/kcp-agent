// Human-readable rendering of an AgentPlan for the terminal.

import type { AgentPlan } from "./planner.js";

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

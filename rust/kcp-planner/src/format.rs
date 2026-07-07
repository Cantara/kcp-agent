//! Human-readable terminal rendering — a Rust port of the `plan` and `validate`
//! renderers in `src/format.ts`. Colors respect `NO_COLOR` and TTY detection.

use crate::budget::fmt_tokens;
use crate::diff::PlanDiff;
use crate::planner::{fmt_num, AgentPlan};
use crate::model::Count;
use crate::trace::DecisionTrace;
use crate::validate::ValidationReport;
use crate::verify::SignatureResult;
use std::io::IsTerminal;

pub struct Colors {
    on: bool,
}

impl Colors {
    /// Color when stdout is a TTY and NO_COLOR is unset (matches format.ts).
    pub fn auto() -> Colors {
        Colors { on: std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none() }
    }
    fn wrap(&self, code: &str, s: &str) -> String {
        if self.on {
            format!("\x1b[{}m{}\x1b[0m", code, s)
        } else {
            s.to_string()
        }
    }
    fn dim(&self, s: &str) -> String {
        self.wrap("2", s)
    }
    fn bold(&self, s: &str) -> String {
        self.wrap("1", s)
    }
    fn green(&self, s: &str) -> String {
        self.wrap("32", s)
    }
    fn yellow(&self, s: &str) -> String {
        self.wrap("33", s)
    }
    fn red(&self, s: &str) -> String {
        self.wrap("31", s)
    }
    fn cyan(&self, s: &str) -> String {
        self.wrap("36", s)
    }
}

fn count_str(c: &Count) -> String {
    match c {
        Count::N(n) => n.to_string(),
        Count::Unlimited => "unlimited".to_string(),
    }
}

pub fn format_plan(p: &AgentPlan, manifest_kcp: Option<&str>, source: Option<&str>, signature: Option<&SignatureResult>, c: &Colors) -> String {
    let mut out: Vec<String> = Vec::new();
    out.push(String::new());
    out.push(c.bold(&format!("Plan for: \"{}\"", p.task)));
    let mut header = format!("  {} v{}", p.manifest_project, p.manifest_version);
    if let Some(kv) = manifest_kcp {
        header.push_str(&format!(" · kcp {}", kv));
    }
    if let Some(src) = source {
        header.push_str(&format!(" · {}", src));
    }
    header.push_str(&format!(" · as-of {}", p.as_of));
    if let Some(env) = &p.environment {
        header.push_str(&format!(" · env {}", env));
    }
    out.push(c.dim(&header));
    out.push(String::new());

    // trust
    let trust_line = if p.trust.requires_attestation {
        if p.trust.agent_can_attest {
            c.green("✓ attestation required — agent can present it")
        } else {
            c.yellow("⚠ attestation required — agent cannot present it (restricted units gated)")
        }
    } else {
        c.dim("· no manifest attestation requirement")
    };
    out.push(format!("{}{}", c.bold("Trust: "), trust_line));
    if let Some(s) = signature {
        let line = match s.status.as_str() {
            "verified" => c.green(&format!("✓ {}{}", s.detail, s.key_id.as_ref().map(|k| format!(" · key {}", k)).unwrap_or_default())),
            "invalid" => c.red(&format!("✗ {}", s.detail)),
            "unverifiable" => c.yellow(&format!("⚠ signature unverifiable — {}", s.detail)),
            _ => c.dim(&format!("· {}", s.detail)),
        };
        out.push(format!("{}{}", c.bold("Signature: "), line));
    }
    out.push(String::new());

    // selected
    out.push(c.bold(&format!("Load plan ({} unit{}):", p.selected.len(), if p.selected.len() == 1 { "" } else { "s" })));
    if p.selected.is_empty() {
        out.push(c.dim("  (no units selected)"));
    }
    for (i, u) in p.selected.iter().enumerate() {
        let mark = if u.load_eligible { c.green("●") } else { c.red("○") };
        let cost = if u.payment.method == "free" { "free".to_string() } else { u.payment.cost.clone().unwrap_or_else(|| u.payment.method.clone()) };
        out.push(format!("  {} {} {}  {}  {}", mark, c.bold(&format!("{}. {}", i + 1, u.id)), c.dim(&format!("(score {})", u.score)), c.dim(&u.path), c.cyan(&cost)));
        out.push(format!("     {}", c.dim(&u.intent)));
        out.push(format!("     {}", c.dim(&format!("why: {}", u.reasons.join("; ")))));
        if !u.load_eligible {
            out.push(format!("     {}", c.red("not load-eligible")));
        }
    }
    out.push(String::new());

    // budget
    let mut budget_line = format!("{}tier {}", c.bold("Budget: "), c.cyan(&p.budget.rate_tier));
    if let Some(rpm) = &p.budget.requests_per_minute {
        budget_line.push_str(&c.dim(&format!(" · {} req/min", count_str(rpm))));
    }
    if let Some(ceiling) = p.budget.ceiling {
        budget_line.push_str(&c.cyan(&format!(" · {}/{} {}", fmt_num(p.budget.projected_spend.unwrap_or(0.0)), fmt_num(ceiling), p.budget.currency.clone().unwrap_or_default())));
        budget_line.push_str(&c.dim(&format!(" ({} remaining)", fmt_num(p.budget.remaining.unwrap_or(0.0)))));
    }
    out.push(budget_line);
    for (unit, cost) in &p.budget.per_request_costs {
        out.push(c.dim(&format!("  pay-per-request: {} → {}", unit, cost)));
    }
    out.push(c.dim(&format!("  {}", p.budget.note)));
    out.push(String::new());

    // context
    if let Some(ceiling) = p.context.ceiling {
        out.push(format!(
            "{}{}{}",
            c.bold("Context: "),
            c.cyan(&format!("{}/{} tokens", fmt_tokens(p.context.projected_tokens.unwrap_or(0)), fmt_tokens(ceiling))),
            c.dim(&format!(" ({} remaining)", fmt_tokens(p.context.remaining.unwrap_or(0))))
        ));
        out.push(c.dim(&format!("  {}", p.context.note)));
        out.push(String::new());
    }

    // federation
    if !p.federation.is_empty() {
        out.push(c.bold("Federation:"));
        for f in &p.federation {
            let mark = if f.selected { c.green("→") } else { c.dim("·") };
            let cred = f.credential_needed.as_ref().map(|cn| c.yellow(&format!(" [acquire {}]", cn))).unwrap_or_default();
            out.push(format!("  {} {} {}{}", mark, f.id, c.dim(&f.reason), cred));
        }
        out.push(String::new());
    }

    // skipped
    if !p.skipped.is_empty() {
        out.push(c.dim(&format!("Skipped ({}):", p.skipped.len())));
        for s in &p.skipped {
            out.push(c.dim(&format!("  · {}: {}", s.id, s.reason)));
        }
        out.push(String::new());
    }

    if !p.warnings.is_empty() {
        for w in &p.warnings {
            out.push(c.yellow(&format!("⚠ {}", w)));
        }
        out.push(String::new());
    }

    out.join("\n")
}

pub fn format_validation(report: &ValidationReport, c: &Colors) -> String {
    let mut out: Vec<String> = Vec::new();
    out.push(String::new());
    let mut header = c.bold(&format!("Validate: {}", report.source));
    if let Some(project) = &report.project {
        header.push_str(&c.dim(&format!(" ({})", project)));
    }
    out.push(header);
    let errors = report.findings.iter().filter(|f| f.level == "error").count();
    let warnings = report.findings.iter().filter(|f| f.level == "warning").count();
    for f in &report.findings {
        let mark = if f.level == "error" { c.red("✗") } else { c.yellow("⚠") };
        out.push(format!("  {} {}: {}", mark, c.bold(&f.where_), f.message));
    }
    out.push(String::new());
    if errors == 0 {
        out.push(format!("{}{}", c.green("✓ valid"), c.dim(&format!(" — {} warning(s)", warnings))));
    } else {
        out.push(format!("{}{}", c.red("✗ invalid"), c.dim(&format!(" — {} error(s), {} warning(s)", errors, warnings))));
    }
    out.push(String::new());

    out.join("\n")
}

fn gate_str(g: &crate::trace::GateName) -> String {
    serde_json::to_value(g).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
}

pub fn format_trace(t: &DecisionTrace, c: &Colors) -> String {
    let mut out: Vec<String> = Vec::new();
    out.push(String::new());
    out.push(c.bold("Decision Trace"));
    out.push(c.dim(&format!("  {} units evaluated · {} search terms: {}", t.units.len(), t.task_terms.len(), t.task_terms.join(", "))));
    out.push(String::new());

    // Gate summary
    out.push(c.bold("Gate summary:"));
    for gs in &t.gate_summary {
        if gs.passed == 0 && gs.failed == 0 {
            continue; // gate never reached
        }
        let bar = if gs.failed > 0 {
            format!("{} passed, {} rejected", c.green(&gs.passed.to_string()), c.red(&gs.failed.to_string()))
        } else {
            c.green(&format!("{} passed", gs.passed))
        };
        out.push(format!("  {} {}", c.dim(&format!("{:<16}", gate_str(&gs.gate))), bar));
    }
    out.push(String::new());

    // Per-unit cascade
    for u in &t.units {
        let mark = if u.outcome == "selected" { c.green("●") } else { c.red("○") };
        let score_part = u.score.map(|s| c.dim(&format!(" (score {})", s))).unwrap_or_default();
        out.push(format!("{} {}{} {}", mark, c.bold(&u.id), score_part, c.dim(&u.path)));
        for g in &u.gates {
            let g_mark = if g.passed { c.green("  ✓") } else { c.red("  ✗") };
            out.push(format!("{} {} {}", g_mark, c.dim(&format!("{:<16}", gate_str(&g.gate))), g.detail));
        }
        out.push(String::new());
    }

    let selected = t.units.iter().filter(|u| u.outcome == "selected").count();
    let skipped = t.units.iter().filter(|u| u.outcome == "skipped").count();
    out.push(c.dim(&format!("{} selected, {} skipped", selected, skipped)));
    out.push(String::new());
    out.join("\n")
}

/// Render a plan diff: what changed between two plan artifacts.
pub fn format_diff(d: &PlanDiff, c: &Colors) -> String {
    let mut out: Vec<String> = Vec::new();
    out.push(String::new());
    out.push(c.bold("Plan Diff"));
    out.push(c.dim(&format!("  A: {} v{} · \"{}\" · {}", d.a.project, d.a.version, d.a.task, d.a.as_of)));
    out.push(c.dim(&format!("  B: {} v{} · \"{}\" · {}", d.b.project, d.b.version, d.b.task, d.b.as_of)));
    out.push(String::new());

    if d.identical {
        out.push(c.green("✓ plans are identical"));
        out.push(String::new());
        return out.join("\n");
    }

    if !d.moves.is_empty() {
        out.push(c.bold(&format!("Moves ({}):", d.moves.len())));
        for m in &d.moves {
            let arrow = if m.direction == "selected_to_skipped" { c.red("selected → skipped") } else { c.green("skipped → selected") };
            out.push(format!("  {}: {}", c.bold(&m.id), arrow));
            if let Some(sc) = m.from.score {
                out.push(format!("    {}", c.dim(&format!("was: score {}", sc))));
            }
            if let Some(r) = &m.from.reason {
                out.push(format!("    {}", c.dim(&format!("was: {}", r))));
            }
            if let Some(sc) = m.to.score {
                out.push(format!("    {}", c.dim(&format!("now: score {}", sc))));
            }
            if let Some(r) = &m.to.reason {
                out.push(format!("    {}", c.dim(&format!("now: {}", r))));
            }
        }
        out.push(String::new());
    }

    if !d.score_changes.is_empty() {
        out.push(c.bold(&format!("Score changes ({}):", d.score_changes.len())));
        for s in &d.score_changes {
            let dir = if s.delta > 0 { c.green(&format!("+{}", s.delta)) } else { c.red(&s.delta.to_string()) };
            out.push(format!("  {}: {} → {} ({})", c.bold(&s.id), s.before, s.after, dir));
        }
        out.push(String::new());
    }

    if !d.presence.is_empty() {
        out.push(c.bold(&format!("Units added/removed ({}):", d.presence.len())));
        for p in &d.presence {
            let mark = if p.side == "b_only" { c.green("+") } else { c.red("-") };
            out.push(format!("  {} {} {}", mark, p.id, c.dim(if p.side == "b_only" { "(new in B)" } else { "(removed in B)" })));
        }
        out.push(String::new());
    }

    if !d.budget_shifts.is_empty() {
        out.push(c.bold("Budget/context shifts:"));
        for b in &d.budget_shifts {
            let before = b.before.map(fmt_num).unwrap_or_else(|| "—".to_string());
            let after = b.after.map(fmt_num).unwrap_or_else(|| "—".to_string());
            out.push(format!("  {}: {} → {}", c.dim(&b.field), before, after));
        }
        out.push(String::new());
    }

    if !d.reason_changes.is_empty() {
        out.push(c.bold(&format!("Reason changes ({}):", d.reason_changes.len())));
        for r in &d.reason_changes {
            out.push(format!("  {}", c.bold(&r.id)));
            out.push(format!("    {}", c.dim(&format!("was: {}", r.before))));
            out.push(format!("    {}", c.dim(&format!("now: {}", r.after))));
        }
        out.push(String::new());
    }

    if !d.warning_changes.added.is_empty() || !d.warning_changes.removed.is_empty() {
        out.push(c.bold("Warning changes:"));
        for w in &d.warning_changes.added {
            out.push(format!("  {} {}", c.green("+"), w));
        }
        for w in &d.warning_changes.removed {
            out.push(format!("  {} {}", c.red("-"), w));
        }
        out.push(String::new());
    }

    out.join("\n")
}

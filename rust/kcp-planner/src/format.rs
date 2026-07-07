//! Human-readable terminal rendering — a Rust port of the `plan` and `validate`
//! renderers in `src/format.ts`. Colors respect `NO_COLOR` and TTY detection.

use crate::budget::fmt_tokens;
use crate::planner::{fmt_num, AgentPlan};
use crate::model::Count;
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

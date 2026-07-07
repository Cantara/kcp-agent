//! `kcp-planner` — the deterministic KCP planner as a small static binary.
//! Commands: `plan` (with `--trace`), `validate`, `diff`. Human-readable colored
//! output, or `--json` for machines. Exit codes: 0 success, 1 failure/invalid/
//! differing, 2 usage error.

use kcp_planner::{
    diff_plans, format_diff, format_plan, format_trace, format_validation, parse_manifest, plan, plan_from_artifact, plan_to_json, trace, trace_to_json,
    validate_location, verify_manifest_text, Colors, PlanOptions,
};
use kcp_planner::planner::{BudgetInput, CapabilitiesInput};
use kcp_planner::validate::load_local_manifest_text;
use sha2::{Digest, Sha256};
use std::process::exit;

const USAGE: &str = "Usage:\n  kcp-planner plan     \"<task>\" --manifest <path|dir> [options] [--trace]\n  kcp-planner validate <path|dir> [--json]\n  kcp-planner diff     <a.json> <b.json> [--json]\n\nRun `kcp-planner plan --help` for options.";

struct Args {
    command: String,
    positionals: Vec<String>,
    manifest: Option<String>,
    env: Option<String>,
    as_of: Option<String>,
    max_units: Option<i64>,
    strict: bool,
    role: Option<String>,
    methods: Option<Vec<String>>,
    credentials: Option<Vec<String>>,
    attest: Option<String>,
    budget: Option<f64>,
    currency: Option<String>,
    context_budget: Option<i64>,
    json: bool,
    trace: bool,
}

fn parse_args(argv: &[String]) -> Args {
    let mut a = Args {
        command: argv.first().cloned().unwrap_or_default(),
        positionals: Vec::new(),
        manifest: None, env: None, as_of: None, max_units: None, strict: false,
        role: None, methods: None, credentials: None, attest: None,
        budget: None, currency: None, context_budget: None, json: false, trace: false,
    };
    let rest = &argv[argv.len().min(1)..];
    let list = |s: &str| s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect::<Vec<_>>();
    let mut i = 0;
    while i < rest.len() {
        let t = &rest[i];
        let mut next = || {
            i += 1;
            rest.get(i).cloned().unwrap_or_default()
        };
        match t.as_str() {
            "--manifest" => a.manifest = Some(next()),
            "--env" => a.env = Some(next()),
            "--as-of" => a.as_of = Some(next()),
            "--max-units" => a.max_units = next().parse().ok(),
            "--strict" => a.strict = true,
            "--role" => a.role = Some(next()),
            "--methods" => a.methods = Some(list(&next())),
            "--credentials" => a.credentials = Some(list(&next())),
            "--attest" => a.attest = Some(next()),
            "--budget" => a.budget = next().parse().ok(),
            "--currency" => a.currency = Some(next()),
            "--context-budget" => a.context_budget = next().parse().ok(),
            "--trace" => a.trace = true,
            "--json" => a.json = true,
            "--help" | "-h" => {}
            other if other.starts_with("--") => {
                eprintln!("Unknown option: {}", other);
                exit(2);
            }
            _ => a.positionals.push(t.clone()),
        }
        i += 1;
    }
    a
}

fn build_options(a: &Args) -> PlanOptions {
    PlanOptions {
        capabilities: Some(CapabilitiesInput {
            role: a.role.clone(),
            payment_methods: a.methods.clone(),
            credentials: a.credentials.clone(),
            attestation_provider: a.attest.clone(),
        }),
        env: a.env.clone(),
        as_of: Some(a.as_of.clone().unwrap_or_else(today_utc)),
        max_units: a.max_units,
        strict: if a.strict { Some(true) } else { None },
        budget: a.budget.map(|amount| BudgetInput { amount, currency: a.currency.clone(), spent: None }),
        context_budget: a.context_budget,
    }
}

/// Today's date (UTC) as YYYY-MM-DD — the one clock the CLI reads. No dep:
/// epoch seconds → days → civil date (Howard Hinnant's algorithm).
fn today_utc() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let z = secs.div_euclid(86400) + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    format!("{:04}-{:02}-{:02}", year, m, d)
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let a = parse_args(&argv);

    match a.command.as_str() {
        "plan" => cmd_plan(&a),
        "validate" => cmd_validate(&a),
        "diff" => cmd_diff(&a),
        "" | "--help" | "-h" | "help" => {
            println!("{}", USAGE);
            exit(if a.command.is_empty() { 2 } else { 0 });
        }
        other => {
            eprintln!("Unknown command: {}\n\n{}", other, USAGE);
            exit(2);
        }
    }
}

fn cmd_plan(a: &Args) {
    let task = a.positionals.join(" ");
    if task.is_empty() {
        eprintln!("Missing task.\n\n{}", USAGE);
        exit(2);
    }
    let location = match &a.manifest {
        Some(m) => m.clone(),
        None => {
            eprintln!("Missing --manifest.\n\n{}", USAGE);
            exit(2);
        }
    };
    let (text, source) = match load_local_manifest_text(&location) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("kcp-planner: {}", e);
            exit(1);
        }
    };
    let sha256 = format!("{:x}", Sha256::digest(text.as_bytes()));
    let manifest = match parse_manifest(&text, Some(&source)) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("kcp-planner: {}: {}", source, e);
            exit(1);
        }
    };
    let options = build_options(a);

    // --trace: the gate cascade for every unit, re-derived from the manifest.
    if a.trace {
        let t = trace(&manifest, &task, &options);
        if a.json {
            let v = trace_to_json(&t, &manifest, &options, &source);
            println!("{}", serde_json::to_string_pretty(&v).unwrap());
        } else {
            let c = Colors::auto();
            // The trace's plan is signature-free (raw plan() output), matching the reference.
            println!("{}", format_plan(&t.plan, manifest.kcp_version.as_deref(), Some(&source), None, &c));
            println!("{}", format_trace(&t, &c));
        }
        return;
    }

    let p = plan(&manifest, &task, &options);
    // The CLI verifies the manifest signature by default and attaches the result
    // to the plan (mirrors the TS reference); the pure planner stays signature-free.
    let sig = verify_manifest_text(&text, manifest.signing.as_ref(), Some(&source));
    if a.json {
        let v = plan_to_json(&p, &manifest, &options, &source, &sha256, &sig);
        println!("{}", serde_json::to_string_pretty(&v).unwrap());
    } else {
        println!("{}", format_plan(&p, manifest.kcp_version.as_deref(), Some(&source), Some(&sig), &Colors::auto()));
    }
}

fn cmd_validate(a: &Args) {
    let location = a.manifest.clone().or_else(|| a.positionals.first().cloned());
    let location = match location {
        Some(l) => l,
        None => {
            eprintln!("Missing manifest location.\n\n{}", USAGE);
            exit(2);
        }
    };
    let report = validate_location(&location, &today_utc());
    if a.json {
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
    } else {
        println!("{}", format_validation(&report, &Colors::auto()));
    }
    exit(if report.ok { 0 } else { 1 });
}

fn cmd_diff(a: &Args) {
    if a.positionals.len() < 2 {
        eprintln!("Usage: kcp-planner diff <a.json> <b.json> [--json]\n\n{}", USAGE);
        exit(2);
    }
    let load = |path: &str| -> kcp_planner::AgentPlan {
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| {
            eprintln!("kcp-planner: {}: {}", path, e);
            exit(1);
        });
        plan_from_artifact(&text).unwrap_or_else(|e| {
            eprintln!("kcp-planner: {}: {}", path, e);
            exit(1);
        })
    };
    let plan_a = load(&a.positionals[0]);
    let plan_b = load(&a.positionals[1]);
    let d = diff_plans(&plan_a, &plan_b);
    if a.json {
        println!("{}", serde_json::to_string_pretty(&d).unwrap());
    } else {
        println!("{}", format_diff(&d, &Colors::auto()));
    }
    exit(if d.identical { 0 } else { 1 });
}

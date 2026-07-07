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

const USAGE: &str = "Usage:\n  kcp-planner plan     \"<task>\" --manifest <path|dir|url> [options] [--trace] [--follow]\n  kcp-planner validate <path|dir|url> [--json]\n  kcp-planner diff     <a.json> <b.json> [--json]\n  kcp-planner replay   <plan.json> [--json]\n  kcp-planner mcp\n\nNetwork options: --follow --max-depth N --max-nodes N --no-verify\n  --require-signature --trust-key <path|url|inline> --allow-private-hosts\n\nRun `kcp-planner plan --help` for options.";

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
    // network
    follow: bool,
    max_depth: Option<usize>,
    max_nodes: Option<usize>,
    no_verify: bool,
    require_signature: bool,
    trust_key: Option<String>,
    allow_private: bool,
}

fn parse_args(argv: &[String]) -> Args {
    let mut a = Args {
        command: argv.first().cloned().unwrap_or_default(),
        positionals: Vec::new(),
        manifest: None, env: None, as_of: None, max_units: None, strict: false,
        role: None, methods: None, credentials: None, attest: None,
        budget: None, currency: None, context_budget: None, json: false, trace: false,
        follow: false, max_depth: None, max_nodes: None, no_verify: false,
        require_signature: false, trust_key: None, allow_private: false,
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
            "--follow" => a.follow = true,
            "--max-depth" => a.max_depth = next().parse().ok(),
            "--max-nodes" => a.max_nodes = next().parse().ok(),
            "--no-verify" => a.no_verify = true,
            "--require-signature" => a.require_signature = true,
            "--trust-key" => a.trust_key = Some(next()),
            "--allow-private-hosts" => a.allow_private = true,
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
        #[cfg(feature = "network")]
        "mcp" => net::cmd_mcp(),
        #[cfg(feature = "network")]
        "replay" => net::cmd_replay(&a),
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
    // A URL manifest or --follow routes through the network layer (fetch + federation).
    #[cfg(feature = "network")]
    {
        if a.follow || location.starts_with("http://") || location.starts_with("https://") {
            net::cmd_plan_follow(a, &location, &task);
            return;
        }
    }
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

/// Network commands (behind the default `network` feature): federated plan, MCP
/// server, and replay. A tokio runtime is created only when one of these runs, so
/// the offline commands stay synchronous.
#[cfg(feature = "network")]
mod net {
    use super::{build_options, Args};
    use kcp_planner::follow::PlanNode;
    use kcp_planner::{format_plan, node_to_json, plan_tree, replay_artifact, serve_mcp, Colors, FetchGuard, FollowOptions};
    use std::process::exit;

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().expect("tokio runtime")
    }

    fn follow_options(a: &Args) -> FollowOptions {
        FollowOptions {
            plan_options: build_options(a),
            max_depth: if a.follow { a.max_depth.unwrap_or(1) } else { 0 },
            max_nodes: a.max_nodes,
            no_verify: a.no_verify,
            require_signature: a.require_signature,
            trusted_key: a.trust_key.clone(),
            fetch_guard: FetchGuard { allow_private: a.allow_private, ..Default::default() },
        }
    }

    fn print_tree_human(node: &PlanNode, c: &Colors) {
        if let Some(p) = &node.plan {
            println!("{}", format_plan(p, node.kcp_version.as_deref(), Some(&node.location), node.signature.as_ref(), c));
        } else if let Some(e) = &node.error {
            println!("✗ {}: {}", node.location, e);
        }
        for child in &node.children {
            print_tree_human(child, c);
        }
    }

    pub fn cmd_plan_follow(a: &Args, location: &str, task: &str) {
        let opts = follow_options(a);
        let tree = runtime().block_on(plan_tree(location, task, &opts));
        if let Some(e) = &tree.error {
            eprintln!("kcp-planner: {}: {}", tree.location, e);
            exit(1);
        }
        if a.json {
            println!("{}", serde_json::to_string_pretty(&node_to_json(&tree, &opts.plan_options)).unwrap());
        } else {
            print_tree_human(&tree, &Colors::auto());
        }
    }

    pub fn cmd_replay(a: &Args) {
        let path = match a.positionals.first() {
            Some(p) => p.clone(),
            None => {
                eprintln!("Usage: kcp-planner replay <plan.json> [--json]");
                exit(2);
            }
        };
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            eprintln!("kcp-planner: {}: {}", path, e);
            exit(1);
        });
        let artifact: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|e| {
            eprintln!("kcp-planner: {}: not JSON: {}", path, e);
            exit(1);
        });
        let guard = FetchGuard { allow_private: a.allow_private, ..Default::default() };
        let report = runtime().block_on(replay_artifact(&artifact, &path, &guard));
        if a.json {
            println!("{}", serde_json::to_string_pretty(&report).unwrap());
        } else {
            for chk in &report.checks {
                let mark = match chk.status.as_str() {
                    "identical" => "✓",
                    "drifted" => "⚠",
                    _ => "✗",
                };
                println!("{} {} ({})\n  {}", mark, chk.source, chk.project, chk.detail);
            }
        }
        exit(if report.ok { 0 } else { 1 });
    }

    pub fn cmd_mcp() {
        if let Err(e) = runtime().block_on(serve_mcp()) {
            eprintln!("kcp-planner: mcp: {}", e);
            exit(1);
        }
    }
}

//! Federation following — the async orchestration around the pure planner (a port
//! of `src/follow.ts`). The planner *decides* which federation refs are eligible;
//! this module fetches them, recursively, fail-closed: refs excluded by context,
//! refs needing a credential the agent lacks, cycles, and hops beyond the depth
//! limit are never fetched — they're reported with the reason. Each fetched
//! manifest passes signature verification before it is planned; an invalid
//! signature poisons that node (and its subtree), never the parent.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;

use sha2::{Digest, Sha256};

use crate::client::{load_manifest_text, normalize, resolve_location};
use crate::fetch::FetchGuard;
use crate::model::parse_manifest;
use crate::planner::{plan, AgentPlan, PlanOptions};
use crate::verify::{verify_manifest_text_net, SignatureResult, VerifyOptions};

/// Default ceiling on the total manifests fetched across a whole federated walk.
pub const DEFAULT_MAX_NODES: usize = 64;

#[derive(Debug, Clone, Default)]
pub struct FollowOptions {
    pub plan_options: PlanOptions,
    /// Federation hops beyond the root manifest (0 = don't follow).
    pub max_depth: usize,
    /// Total manifests fetched across the whole walk (root + every hop). Default 64.
    pub max_nodes: Option<usize>,
    /// Skip signature verification entirely.
    pub no_verify: bool,
    /// Fail-closed unless every fetched manifest has a *verified* signature.
    pub require_signature: bool,
    /// Pinned public key (path/URL/inline) for verification.
    pub trusted_key: Option<String>,
    /// Guard applied to every remote fetch (manifests, signatures, keys).
    pub fetch_guard: FetchGuard,
}

#[derive(Debug, Clone)]
pub struct NotFollowedRef {
    pub id: String,
    pub url: String,
    pub reason: String,
}

/// A node in the plan tree. `plan`/`sha256`/`signature` are the pieces the CLI
/// serializer needs (the pure `AgentPlan` carries neither sha nor signature).
#[derive(Debug, Clone, Default)]
pub struct PlanNode {
    /// Federation ref id that led here; None at the root.
    pub ref_id: Option<String>,
    pub location: String,
    pub plan: Option<AgentPlan>,
    /// kcp_version of the fetched manifest — kept so the node can be serialized
    /// (the plan artifact echoes it) without retaining the whole manifest.
    pub kcp_version: Option<String>,
    pub sha256: Option<String>,
    pub signature: Option<SignatureResult>,
    /// Fetch/parse/signature failure — the node is dead, fail-closed.
    pub error: Option<String>,
    pub not_followed: Vec<NotFollowedRef>,
    pub children: Vec<PlanNode>,
}

fn round6(n: f64) -> f64 {
    format!("{:.6}", n).parse::<f64>().unwrap_or(n)
}

struct Walk<'o> {
    options: &'o FollowOptions,
    task: &'o str,
    visited: HashSet<String>,
    fetched: usize,
    max_depth: usize,
    max_nodes: usize,
    committed: f64,
    base_budget: Option<crate::planner::BudgetInput>,
}

impl<'o> Walk<'o> {
    fn visit<'a>(&'a mut self, loc: String, ref_id: Option<String>, depth: usize) -> Pin<Box<dyn Future<Output = PlanNode> + 'a>> {
        Box::pin(async move {
            let mut node = PlanNode { ref_id, location: loc.clone(), ..Default::default() };
            self.fetched += 1;

            let (text, source) = match load_manifest_text(&loc, &self.options.fetch_guard).await {
                Ok(v) => v,
                Err(e) => {
                    node.error = Some(format!("fetch failed: {}", e));
                    return node;
                }
            };
            node.location = source.clone();
            self.visited.insert(normalize(&source));

            let manifest = match parse_manifest(&text, Some(&source)) {
                Ok(m) => m,
                Err(e) => {
                    node.error = Some(format!("parse failed: {}", e));
                    return node;
                }
            };

            if !self.options.no_verify {
                let vopts = VerifyOptions { trusted_key: self.options.trusted_key.clone(), guard: self.options.fetch_guard.clone() };
                let sig = verify_manifest_text_net(&text, manifest.signing.as_ref(), Some(&source), &vopts).await;
                if sig.status == "invalid" {
                    node.error = Some(format!("signature invalid: {}", sig.detail));
                    node.signature = Some(sig);
                    return node;
                }
                if self.options.require_signature && sig.status != "verified" {
                    node.error = Some(format!("signature required but {}: {}", sig.status, sig.detail));
                    node.signature = Some(sig);
                    return node;
                }
                node.signature = Some(sig);
            }

            // Tree-wide budget ledger: earlier nodes' committed spend counts against
            // each later node's ceiling — one --budget is one ceiling, not per hop.
            let plan_options = if let Some(base) = &self.base_budget {
                let mut b = base.clone();
                b.spent = if self.committed > 0.0 { Some(round6(self.committed)) } else { None };
                PlanOptions { budget: Some(b), ..self.options.plan_options.clone() }
            } else {
                self.options.plan_options.clone()
            };

            let p = plan(&manifest, self.task, &plan_options);
            if self.base_budget.is_some() {
                self.committed = round6(self.committed + p.budget.projected_spend.unwrap_or(0.0));
            }
            node.sha256 = Some(format!("{:x}", Sha256::digest(text.as_bytes())));
            node.kcp_version = manifest.kcp_version.clone();

            // Walk the eligible federation, fail-closed at every excluded ref.
            let federation = p.federation.clone();
            node.plan = Some(p);
            for r in &federation {
                if !r.selected {
                    node.not_followed.push(NotFollowedRef { id: r.id.clone(), url: r.url.clone(), reason: r.reason.clone() });
                    continue;
                }
                if let Some(cred) = &r.credential_needed {
                    node.not_followed.push(NotFollowedRef { id: r.id.clone(), url: r.url.clone(), reason: format!("needs {} before fetch", cred) });
                    continue;
                }
                if depth >= self.max_depth {
                    node.not_followed.push(NotFollowedRef { id: r.id.clone(), url: r.url.clone(), reason: format!("beyond max depth {}", self.max_depth) });
                    continue;
                }
                let child_loc = resolve_location(Some(&source), &r.url);
                if self.visited.contains(&normalize(&child_loc)) {
                    node.not_followed.push(NotFollowedRef { id: r.id.clone(), url: r.url.clone(), reason: "already visited (cycle)".to_string() });
                    continue;
                }
                if self.fetched >= self.max_nodes {
                    node.not_followed.push(NotFollowedRef { id: r.id.clone(), url: r.url.clone(), reason: format!("beyond max nodes {} (fan-out cap)", self.max_nodes) });
                    continue;
                }
                let child = self.visit(child_loc, Some(r.id.clone()), depth + 1).await;
                node.children.push(child);
            }
            node
        })
    }
}

/// Plan a manifest and, up to `max_depth` hops, its eligible federation.
pub async fn plan_tree(location: &str, task: &str, options: &FollowOptions) -> PlanNode {
    let mut walk = Walk {
        options,
        task,
        visited: HashSet::new(),
        fetched: 0,
        max_depth: options.max_depth,
        max_nodes: options.max_nodes.unwrap_or(DEFAULT_MAX_NODES),
        committed: options.plan_options.budget.as_ref().and_then(|b| b.spent).unwrap_or(0.0),
        base_budget: options.plan_options.budget.clone(),
    };
    walk.visit(location.to_string(), None, 0).await
}

/// Serialize a plan tree node to JSON (a port of the shape `kcp-agent plan
/// --follow --json` / the MCP `kcp_plan` tool emit). The node's plan carries the
/// loading layer's sha256 + signature.
pub fn node_to_json(node: &PlanNode, options: &PlanOptions) -> serde_json::Value {
    let mut m = serde_json::Map::new();
    if let Some(rid) = &node.ref_id {
        m.insert("refId".into(), serde_json::Value::from(rid.clone()));
    }
    m.insert("location".into(), serde_json::Value::from(node.location.clone()));
    if let Some(p) = &node.plan {
        m.insert(
            "plan".into(),
            crate::json::plan_to_value(p, node.kcp_version.as_deref(), options, &node.location, node.sha256.as_deref(), node.signature.as_ref()),
        );
    }
    if let Some(sig) = &node.signature {
        m.insert("signature".into(), crate::json::signature_to_value(sig));
    }
    if let Some(err) = &node.error {
        m.insert("error".into(), serde_json::Value::from(err.clone()));
    }
    let not_followed: Vec<serde_json::Value> = node
        .not_followed
        .iter()
        .map(|r| serde_json::json!({ "id": r.id, "url": r.url, "reason": r.reason }))
        .collect();
    m.insert("notFollowed".into(), serde_json::Value::Array(not_followed));
    let children: Vec<serde_json::Value> = node.children.iter().map(|c| node_to_json(c, options)).collect();
    m.insert("children".into(), serde_json::Value::Array(children));
    serde_json::Value::Object(m)
}

/// All successfully planned nodes in the tree, root first, depth-first.
pub fn plans(node: &PlanNode) -> Vec<&AgentPlan> {
    let mut out = Vec::new();
    if let Some(p) = &node.plan {
        out.push(p);
    }
    for child in &node.children {
        out.extend(plans(child));
    }
    out
}

//! Load the content of load-eligible units — a port of `loadPlannedUnits` from
//! src/synthesize.ts (the LLM synthesis itself stays in the TS reference; the
//! Rust core serves the bytes and lets the calling agent's model answer). Remote
//! unit content is fetched through the SSRF guard; local content is read relative
//! to the manifest's directory. Path safety is enforced fail-closed.

use sha2::{Digest, Sha256};

use crate::client::{is_url, resolve_location};
use crate::fetch::{guarded_fetch_text, FetchGuard};
use crate::planner::AgentPlan;

#[derive(Debug, Clone, serde::Serialize)]
pub struct LoadedUnit {
    pub id: String,
    pub path: String,
    /// Project of the manifest the unit came from.
    pub manifest: String,
    pub chars: usize,
    /// sha256 of the exact content bytes — citations are tied to these.
    pub sha256: String,
    pub content: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Unavailable {
    pub id: String,
    pub path: String,
    pub reason: String,
}

/// Path safety for unit content — refuse empty, URL, absolute, or traversing paths.
fn unsafe_path(path: &str) -> bool {
    path.is_empty()
        || is_url(path)
        || path.starts_with("//")
        || std::path::Path::new(path).is_absolute()
        || path.starts_with('/')
        || path.split('/').any(|seg| seg == "..")
}

/// `chars` on the wire matches JS `string.length` (UTF-16 code units).
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Load the content of a plan's load-eligible units. `source` is the manifest's
/// origin (URL or path), used to resolve each unit's relative path.
pub async fn load_planned_units(plan: &AgentPlan, source: &str, guard: &FetchGuard) -> (Vec<LoadedUnit>, Vec<Unavailable>) {
    let mut loaded = Vec::new();
    let mut unavailable = Vec::new();
    let remote_base = if is_url(source) { Some(source) } else { None };
    let base_dir = if remote_base.is_none() { std::path::Path::new(source).parent().map(|p| p.to_path_buf()) } else { None };

    for unit in &plan.selected {
        if !unit.load_eligible {
            unavailable.push(Unavailable { id: unit.id.clone(), path: unit.path.clone(), reason: "not load-eligible in the plan".into() });
            continue;
        }
        if unsafe_path(&unit.path) {
            unavailable.push(Unavailable { id: unit.id.clone(), path: unit.path.clone(), reason: "unsafe path (absolute, traversing, or a URL)".into() });
            continue;
        }
        if remote_base.is_some() {
            let url = resolve_location(Some(source), &unit.path);
            match guarded_fetch_text(&url, guard).await {
                Ok(content) => loaded.push(mk_loaded(unit, &plan.manifest_project, content)),
                Err(e) => unavailable.push(Unavailable { id: unit.id.clone(), path: unit.path.clone(), reason: format!("fetch failed: {}", e) }),
            }
            continue;
        }
        let base = match &base_dir {
            Some(b) => b,
            None => {
                unavailable.push(Unavailable { id: unit.id.clone(), path: unit.path.clone(), reason: "manifest has no source; content not loadable".into() });
                continue;
            }
        };
        let abs = base.join(&unit.path);
        match std::fs::read_to_string(&abs) {
            Ok(content) => loaded.push(mk_loaded(unit, &plan.manifest_project, content)),
            Err(_) => unavailable.push(Unavailable { id: unit.id.clone(), path: unit.path.clone(), reason: "file not found on disk".into() }),
        }
    }
    (loaded, unavailable)
}

fn mk_loaded(unit: &crate::planner::PlannedUnit, project: &str, content: String) -> LoadedUnit {
    let sha256 = format!("{:x}", Sha256::digest(content.as_bytes()));
    LoadedUnit { id: unit.id.clone(), path: unit.path.clone(), manifest: project.to_string(), chars: utf16_len(&content), sha256, content }
}

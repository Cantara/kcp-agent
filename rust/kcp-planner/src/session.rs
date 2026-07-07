//! Session dedup — a port of `dedupeLoaded` from src/session.ts. A caller passes
//! the units it already holds (`known`, as `[{id, sha256}]` or `{id: sha256}`); a
//! loaded unit whose sha still matches comes back as an "unchanged" stub instead
//! of re-served bytes, saving the caller's context window. Any sha drift re-serves.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::synthesize::LoadedUnit;

/// Build id→sha256 from either shape MCP callers send.
pub fn known_map(known: Option<&Value>) -> HashMap<String, String> {
    let mut m = HashMap::new();
    match known {
        Some(Value::Array(arr)) => {
            for e in arr {
                if let (Some(id), Some(sha)) = (e.get("id").and_then(|v| v.as_str()), e.get("sha256").and_then(|v| v.as_str())) {
                    m.insert(id.to_string(), sha.to_string());
                }
            }
        }
        Some(Value::Object(obj)) => {
            for (k, v) in obj {
                if let Some(sha) = v.as_str() {
                    m.insert(k.clone(), sha.to_string());
                }
            }
        }
        _ => {}
    }
    m
}

pub struct DedupResult {
    pub units: Vec<Value>,
    pub deduped: Vec<Value>,
    pub bytes_saved: usize,
}

/// Withhold bytes the caller already holds unchanged (exact sha match).
pub fn dedupe_loaded(loaded: &[LoadedUnit], known: Option<&Value>) -> DedupResult {
    let have = known_map(known);
    let mut units = Vec::new();
    let mut deduped = Vec::new();
    let mut bytes_saved = 0usize;
    for u in loaded {
        if have.get(&u.id).map(|s| s == &u.sha256).unwrap_or(false) {
            units.push(json!({
                "id": u.id,
                "path": u.path,
                "sha256": u.sha256,
                "unchanged": true,
                "note": format!("unchanged since your copy (sha {}…) — not re-served", &u.sha256[..12.min(u.sha256.len())]),
            }));
            deduped.push(json!({ "id": u.id, "sha256": u.sha256 }));
            bytes_saved += u.content.encode_utf16().count();
        } else {
            units.push(serde_json::to_value(u).unwrap_or(Value::Null));
        }
    }
    DedupResult { units, deduped, bytes_saved }
}

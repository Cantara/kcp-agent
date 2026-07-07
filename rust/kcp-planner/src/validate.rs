//! Manifest linter — a Rust port of `src/validate.ts`. Validates the same compact
//! model the planner consumes: errors are structural problems that mislead or
//! fail an agent; warnings are declarations that weaken navigation. Date/URL
//! checks are hand-rolled to keep the dependency tree minimal (no regex crate).

use crate::model::{parse_manifest, Manifest, Unit};
use crate::planner::terms;
use serde::Serialize;
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    pub level: String, // "error" | "warning"
    pub where_: String,
    pub message: String,
}

// `where` is a Rust keyword; rename on the wire to match the TS field.
impl Finding {
    fn error(where_: &str, message: impl Into<String>) -> Finding {
        Finding { level: "error".to_string(), where_: where_.to_string(), message: message.into() }
    }
    fn warning(where_: &str, message: impl Into<String>) -> Finding {
        Finding { level: "warning".to_string(), where_: where_.to_string(), message: message.into() }
    }
}

// Custom serde to emit/read `where` (keyword) with the wire name.
mod finding_serde {
    use super::Finding;
    use serde::ser::SerializeStruct;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    impl Serialize for Finding {
        fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
            let mut st = s.serialize_struct("Finding", 3)?;
            st.serialize_field("level", &self.level)?;
            st.serialize_field("where", &self.where_)?;
            st.serialize_field("message", &self.message)?;
            st.end()
        }
    }

    #[derive(Deserialize)]
    struct FindingWire {
        level: String,
        #[serde(rename = "where")]
        where_: String,
        message: String,
    }

    impl<'de> Deserialize<'de> for Finding {
        fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Finding, D::Error> {
            let w = FindingWire::deserialize(d)?;
            Ok(Finding { level: w.level, where_: w.where_, message: w.message })
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ValidationReport {
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub findings: Vec<Finding>,
    pub ok: bool,
}

const ACCESS_VALUES: [&str; 3] = ["public", "authenticated", "restricted"];

/// Matches the TS `^[a-z][a-z0-9+.-]*:`i scheme test and `//` prefix.
fn looks_like_url(path: &str) -> bool {
    if path.starts_with("//") {
        return true;
    }
    let bytes = path.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
        return false;
    }
    let mut i = 1;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || c == b'+' || c == b'.' || c == b'-') {
            return false;
        }
        i += 1;
    }
    false
}

fn unsafe_path(path: &str) -> Option<String> {
    if path.is_empty() {
        return Some("path is empty".to_string());
    }
    if looks_like_url(path) {
        return Some("path must be relative, not a URL".to_string());
    }
    if std::path::Path::new(path).is_absolute() || path.starts_with('/') {
        return Some("path must be relative, not absolute".to_string());
    }
    if path.split('/').any(|seg| seg == "..") {
        return Some("path must not traverse with '..'".to_string());
    }
    None
}

/// Today (UTC) as YYYY-MM-DD — epoch seconds → civil date (Howard Hinnant). Used
/// by callers that lint without an injected clock (the MCP server).
pub fn today_utc() -> String {
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

/// Matches `^\d{4}-\d{2}-\d{2}([T ].*)?$`.
fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 10 {
        return false;
    }
    let digit = |i: usize| b[i].is_ascii_digit();
    if !(digit(0) && digit(1) && digit(2) && digit(3) && b[4] == b'-' && digit(5) && digit(6) && b[7] == b'-' && digit(8) && digit(9)) {
        return false;
    }
    b.len() == 10 || b[10] == b'T' || b[10] == b' '
}

/// Validate a parsed manifest. `base_dir` enables unit-path existence checks.
pub fn validate_manifest(manifest: &Manifest, base_dir: Option<&str>, today: &str) -> Vec<Finding> {
    let mut f: Vec<Finding> = Vec::new();

    if manifest.project == "(unnamed)" {
        f.push(Finding::warning("manifest", "missing 'project'"));
    }
    if manifest.version == "0.0.0" {
        f.push(Finding::warning("manifest", "missing 'version'"));
    }
    if manifest.kcp_version.is_none() {
        f.push(Finding::warning("manifest", "missing 'kcp_version' — agents cannot tell which spec revision this targets"));
    }
    if manifest.units.is_empty() {
        f.push(Finding::warning("manifest", "declares no units — nothing for an agent to navigate"));
    }

    let mut ids: HashSet<String> = HashSet::new();
    for unit in &manifest.units {
        let where_ = format!("unit '{}'", if unit.id.is_empty() { "(no id)" } else { &unit.id });
        if unit.id.is_empty() {
            f.push(Finding::error(&where_, "missing 'id'"));
        } else if ids.contains(&unit.id) {
            f.push(Finding::error(&where_, "duplicate unit id"));
        }
        ids.insert(unit.id.clone());

        if let Some(problem) = unsafe_path(&unit.path) {
            f.push(Finding::error(&where_, problem));
        } else if let Some(dir) = base_dir {
            if !std::path::Path::new(dir).join(&unit.path).exists() {
                f.push(Finding::error(&where_, format!("path '{}' does not exist", unit.path)));
            }
        }

        if unit.intent.is_empty() {
            f.push(Finding::error(&where_, "missing 'intent' — intent is the primary navigation signal"));
        }
        if unit.triggers.is_empty() {
            f.push(Finding::warning(&where_, "no 'triggers' — unit is only findable through its intent text"));
        }
        if unit.audience.is_empty() {
            f.push(Finding::warning(&where_, "no 'audience' — declare who this unit serves (e.g. [agent, human])"));
        }
        if let Some(access) = &unit.access {
            if !ACCESS_VALUES.contains(&access.as_str()) {
                f.push(Finding::warning(&where_, format!("unknown access '{}' (expected public/authenticated/restricted)", access)));
            }
        }
        validate_temporal(unit, &where_, today, &mut f);
        validate_not_for(unit, &where_, &mut f);
        for m in unit.payment.as_ref().and_then(|p| p.methods.as_ref()).map(|v| v.as_slice()).unwrap_or(&[]) {
            if m.r#type.is_empty() {
                f.push(Finding::error(&where_, "payment method missing 'type'"));
            }
            if m.r#type == "x402" && (m.price_per_request.is_none() || m.currency.is_none()) {
                f.push(Finding::warning(&where_, "x402 payment method should declare 'price_per_request' and 'currency'"));
            }
        }
    }

    for unit in &manifest.units {
        if let Some(succ) = unit.temporal.as_ref().and_then(|t| t.superseded_by.as_ref()) {
            if !ids.contains(succ) {
                f.push(Finding::error(&format!("unit '{}'", unit.id), format!("temporal.superseded_by references unknown unit '{}'", succ)));
            }
        }
    }

    let mut ref_ids: HashSet<String> = HashSet::new();
    for r in &manifest.manifests {
        let where_ = format!("manifest ref '{}'", if r.id.is_empty() { "(no id)" } else { &r.id });
        if r.id.is_empty() {
            f.push(Finding::error(&where_, "missing 'id'"));
        } else if ref_ids.contains(&r.id) {
            f.push(Finding::error(&where_, "duplicate manifest ref id"));
        }
        ref_ids.insert(r.id.clone());
        if r.url.is_empty() {
            f.push(Finding::error(&where_, "missing 'url'"));
        } else if !r.url.starts_with("https://") {
            f.push(Finding::warning(&where_, "url is not https — agents should fetch federation over TLS"));
        }
        if let Some(ai) = &r.agent_identity {
            if ai.required == Some(true) && ai.credential_hint.is_none() {
                f.push(Finding::warning(&where_, "agent_identity.required without 'credential_hint' — agents cannot plan credential acquisition"));
            }
        }
    }

    let ar = manifest.trust.as_ref().and_then(|t| t.agent_requirements.as_ref());
    if let Some(ar) = ar {
        if ar.require_attestation == Some(true) && ar.trusted_providers.is_empty() {
            f.push(Finding::error("manifest", "require_attestation with no trusted_providers — no agent can ever qualify (permanently fail-closed)"));
        }
    }

    if let Some(sig) = &manifest.signing {
        if let Some(scheme) = &sig.scheme {
            let low = scheme.to_lowercase();
            if low != "ed25519" && low != "eddsa" {
                f.push(Finding::warning("manifest", format!("signing scheme '{}' is not one this agent can verify (ed25519)", scheme)));
            }
        }
    }

    f
}

fn validate_not_for(unit: &Unit, where_: &str, f: &mut Vec<Finding>) {
    if unit.not_for.is_empty() {
        return;
    }
    let mut vocab: HashSet<String> = HashSet::new();
    for t in terms(&unit.intent) {
        vocab.insert(t);
    }
    for trig in &unit.triggers {
        for t in terms(trig) {
            vocab.insert(t);
        }
    }
    for nf in &unit.not_for {
        let entry = nf.to_lowercase();
        let mut hits: Vec<String> = vocab.iter().filter(|v| entry.contains(v.as_str())).cloned().collect();
        hits.sort();
        if !hits.is_empty() {
            f.push(Finding::warning(
                where_,
                format!(
                    "not_for '{}' contains the unit's own vocabulary ({}) — term matching will gate this unit against its most natural questions; name the excluded topic in its own words (e.g. \"CCPA\", \"accounting\"), never as a negation of this unit's topic (\"non-X\", \"outside X\")",
                    nf,
                    hits.join(", ")
                ),
            ));
        }
    }
}

fn validate_temporal(unit: &Unit, where_: &str, today: &str, f: &mut Vec<Finding>) {
    let t = match &unit.temporal {
        None => return,
        Some(t) => t,
    };
    if let Some(vf) = &t.valid_from {
        if !is_iso_date(vf) {
            f.push(Finding::error(where_, format!("temporal.valid_from '{}' is not an ISO date", vf)));
        }
    }
    if let Some(vu) = &t.valid_until {
        if !is_iso_date(vu) {
            f.push(Finding::error(where_, format!("temporal.valid_until '{}' is not an ISO date", vu)));
        }
    }
    if let (Some(vf), Some(vu)) = (&t.valid_from, &t.valid_until) {
        if vu < vf {
            f.push(Finding::error(where_, format!("temporal window ends ({}) before it starts ({})", vu, vf)));
        }
    }
    if let Some(vu) = &t.valid_until {
        if is_iso_date(vu) && vu.as_str() < today && t.superseded_by.is_none() {
            f.push(Finding::warning(where_, format!("expired {} with no 'superseded_by' — agents get a dead end instead of a successor", vu)));
        }
    }
}

/// Load a manifest from a local path/dir and validate it. `today` is injected
/// (the one clock the linter reads, for the expired-without-successor warning).
pub fn validate_location(location: &str, today: &str) -> ValidationReport {
    let (text, source) = match load_local_manifest_text(location) {
        Ok(v) => v,
        Err(e) => return ValidationReport { source: location.to_string(), project: None, findings: vec![Finding::error("manifest", e)], ok: false },
    };
    let manifest = match parse_manifest(&text, Some(&source)) {
        Ok(m) => m,
        Err(e) => return ValidationReport { source: source.clone(), project: None, findings: vec![Finding::error("manifest", format!("does not parse: {}", e))], ok: false },
    };
    let base_dir = std::path::Path::new(&source).parent().map(|p| p.to_string_lossy().to_string());
    let findings = validate_manifest(&manifest, base_dir.as_deref(), today);
    let ok = !findings.iter().any(|f| f.level == "error");
    ValidationReport { source, project: Some(manifest.project.clone()), findings, ok }
}

/// Resolve a path or directory (knowledge.yaml / .well-known/knowledge.yaml) to text + source.
/// The `source` label must match the TS reference (`loadManifestText` in client.ts),
/// which builds it with Node's `path.join` — so we normalize the same way (e.g.
/// `join(".", "knowledge.yaml")` yields `knowledge.yaml`, not `./knowledge.yaml`).
pub fn load_local_manifest_text(location: &str) -> Result<(String, String), String> {
    let source = if std::path::Path::new(location).is_dir() {
        let a = node_join(&[location, "knowledge.yaml"]);
        let b = node_join(&[location, ".well-known", "knowledge.yaml"]);
        if std::path::Path::new(&a).exists() {
            a
        } else if std::path::Path::new(&b).exists() {
            b
        } else {
            return Err(format!("no knowledge.yaml found in {}", location));
        }
    } else {
        location.to_string()
    };
    if !std::path::Path::new(&source).exists() {
        return Err(format!("manifest not found: {}", source));
    }
    let text = std::fs::read_to_string(&source).map_err(|e| e.to_string())?;
    Ok((text, source))
}

/// Join path segments the way Node's `path.join` does on POSIX: concatenate with
/// `/`, then normalize (drop `.` segments, resolve `..`). The TS reference records
/// the joined result as the manifest `source`, so byte-parity of `validate --json`
/// depends on matching this — `join(".", "knowledge.yaml")` → `knowledge.yaml`.
fn node_join(parts: &[&str]) -> String {
    let joined = parts.iter().filter(|p| !p.is_empty()).copied().collect::<Vec<_>>().join("/");
    node_normalize(&joined)
}

fn node_normalize(path: &str) -> String {
    let is_abs = path.starts_with('/');
    let mut stack: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => match stack.last() {
                Some(&last) if last != ".." => {
                    stack.pop();
                }
                None if is_abs => {}
                _ => stack.push(".."),
            },
            s => stack.push(s),
        }
    }
    let body = stack.join("/");
    if is_abs {
        format!("/{}", body)
    } else if body.is_empty() {
        ".".to_string()
    } else {
        body
    }
}

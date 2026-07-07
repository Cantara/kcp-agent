//! Locate a manifest — a local path/dir or an HTTPS URL — to text + source. The
//! async counterpart of `validate::load_local_manifest_text`, routing every remote
//! read through the SSRF guard (a port of `loadManifestText` in client.ts).

use crate::fetch::{guarded_fetch_text, FetchGuard};
use crate::validate::load_local_manifest_text;

/// True for an `http(s)://` location (leading whitespace tolerated, matching the TS regex).
pub fn is_url(location: &str) -> bool {
    let l = location.trim_start();
    l.starts_with("https://") || l.starts_with("http://")
}

/// Resolve a location to `(text, source)`. A URL is fetched through the guard; a
/// path/dir is read locally (knowledge.yaml / .well-known/knowledge.yaml).
pub async fn load_manifest_text(location: &str, guard: &FetchGuard) -> Result<(String, String), String> {
    if is_url(location) {
        let text = guarded_fetch_text(location, guard).await?;
        Ok((text, location.to_string()))
    } else {
        load_local_manifest_text(location)
    }
}

/// Resolve a possibly-relative location against a base that may be a URL or a path
/// (a port of TS `resolveLocation`): absolute URL as-is; URL base → URL join; path
/// base → join against the base's directory.
pub fn resolve_location(base: Option<&str>, loc: &str) -> String {
    if is_url(loc) {
        return loc.to_string();
    }
    if let Some(b) = base {
        if is_url(b) {
            if let Ok(joined) = reqwest::Url::parse(b).and_then(|bu| bu.join(loc)) {
                return joined.to_string();
            }
            return loc.to_string();
        }
        if !std::path::Path::new(loc).is_absolute() {
            if let Some(dir) = std::path::Path::new(b).parent() {
                if !dir.as_os_str().is_empty() {
                    return dir.join(loc).to_string_lossy().to_string();
                }
            }
        }
    }
    loc.to_string()
}

/// Normalize a location for cycle detection: URLs and absolute paths as-is, a
/// relative path resolved to absolute (mirrors TS `normalize` in follow.ts).
pub fn normalize(location: &str) -> String {
    if is_url(location) || std::path::Path::new(location).is_absolute() {
        return location.to_string();
    }
    std::path::absolute(location).map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| location.to_string())
}

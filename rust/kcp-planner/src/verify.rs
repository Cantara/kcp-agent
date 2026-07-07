//! Manifest signature verification — a Rust port of `src/verify.ts` (ed25519 over
//! the exact published manifest bytes). The CLI attaches the result to every plan
//! by default (mirroring `follow.ts`), so `plan`/`--json` byte-parity depends on
//! it.
//!
//! Verification is fail-closed: a signature that is present but wrong is fatal
//! (`invalid`); one we cannot load is `unverifiable` and left to policy. This
//! build resolves everything offline — inline material and local `.sig`/key files.
//! Fetching a signature or key over HTTPS lands with the network phase (#50); a
//! remote location is reported `unverifiable` (never fail-open).
//!
//! The ed25519 verification is behind the default `verify-ed25519` feature. The
//! WASM build disables it (no filesystem to read a local `.sig`, and it drops the
//! curve25519/ed25519 dependencies): the offline branches — unsigned / no
//! signature location / unsupported scheme — still resolve, and a locatable
//! signature reports `unverifiable` rather than fail open.

use crate::model::Signing;
#[cfg(feature = "verify-ed25519")]
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

/// Mirrors the TS `SignatureResult` (`{ status, detail, keyId? }`).
#[derive(Debug, Clone, PartialEq)]
pub struct SignatureResult {
    pub status: String, // "verified" | "invalid" | "unverifiable" | "unsigned"
    pub detail: String,
    pub key_id: Option<String>,
}

impl SignatureResult {
    fn new(status: &str, detail: impl Into<String>, key_id: Option<String>) -> SignatureResult {
        SignatureResult { status: status.into(), detail: detail.into(), key_id }
    }
}

/// Verify manifest `text` against its signing block. `source` (the path the
/// manifest was loaded from) anchors relative signature/key locations.
pub fn verify_manifest_text(text: &str, signing: Option<&Signing>, source: Option<&str>) -> SignatureResult {
    let s = match signing {
        None => return SignatureResult::new("unsigned", "manifest declares no signature", None),
        Some(s) => s,
    };
    let key_id = s.key_id.clone();
    let signature = match &s.signature {
        None => {
            return SignatureResult::new(
                "unverifiable",
                "manifest declares a signing block but no signature location — treating as unverified",
                key_id,
            );
        }
        Some(sig) => sig,
    };
    if let Some(scheme) = &s.scheme {
        let low = scheme.to_lowercase();
        if low != "ed25519" && low != "eddsa" {
            return SignatureResult::new("unverifiable", format!("unsupported signing scheme '{}'", scheme), key_id);
        }
    }
    verify_signature_material(text, s, signature, source, key_id)
}

/// Load the signature (and key), then run the ed25519 check. Only compiled with
/// the `verify-ed25519` feature (the CLI); the WASM stub is below.
#[cfg(feature = "verify-ed25519")]
fn verify_signature_material(text: &str, s: &Signing, signature: &str, source: Option<&str>, mut key_id: Option<String>) -> SignatureResult {
    // Locate the signature material (and possibly an embedded key + key id).
    let raw_sig = match load_material(signature, source) {
        Ok(v) => v,
        Err(e) => return SignatureResult::new("unverifiable", format!("cannot load signature: {}", e), None),
    };
    let mut embedded_key: Option<String> = None;
    let signature_material: String = match serde_json::from_str::<serde_json::Value>(&raw_sig) {
        Ok(serde_json::Value::Object(env)) => {
            let sig_field = env.get("signature").map(val_to_string).unwrap_or_default();
            embedded_key = env.get("public_key").map(val_to_string);
            if let Some(kid) = env.get("key_id") {
                key_id = Some(val_to_string(kid));
            }
            if let Some(alg) = env.get("algorithm") {
                let alg = val_to_string(alg);
                let low = alg.to_lowercase();
                if low != "ed25519" && low != "eddsa" {
                    return SignatureResult::new("unverifiable", format!("unsupported signature algorithm '{}'", alg), key_id);
                }
            }
            sig_field
        }
        _ => raw_sig, // raw base64/hex signature file
    };

    let sig_bytes = decode_bytes(&signature_material);
    let sig_bytes = match sig_bytes {
        Some(b) if b.len() == 64 => b,
        _ => return SignatureResult::new("invalid", "signature is not 64 ed25519 signature bytes", key_id),
    };

    // Locate the public key. The manifest's declared key wins; the key embedded in
    // the signature envelope is the last resort (self-attesting).
    let (key_material, via) = if let Some(pk) = &s.public_key {
        match load_material(pk, source) {
            Ok(m) => (m, "declared key"),
            Err(_) if embedded_key.is_some() => (embedded_key.clone().unwrap(), "envelope key"),
            Err(e) => return SignatureResult::new("unverifiable", format!("cannot load public key: {}", e), key_id),
        }
    } else if let Some(ek) = &embedded_key {
        (ek.clone(), "envelope key")
    } else {
        return SignatureResult::new("unverifiable", "no public key available", key_id);
    };

    let verifying_key = match import_public_key(&key_material) {
        Ok(k) => k,
        Err(e) => return SignatureResult::new("unverifiable", format!("cannot import public key: {}", e), key_id),
    };
    let sig = Signature::from_bytes(&sig_bytes.as_slice().try_into().expect("checked len 64"));

    // Verify the exact bytes; retry with a single trailing newline normalized,
    // which survives editor/git end-of-file differences without weakening the check.
    for candidate in [text.to_string(), normalize_trailing_newline(text)] {
        if verifying_key.verify(candidate.as_bytes(), &sig).is_ok() {
            return SignatureResult::new("verified", format!("ed25519 signature verified ({})", via), key_id);
        }
    }
    SignatureResult::new("invalid", "ed25519 signature does not match manifest bytes", key_id)
}

/// No-crypto build (WASM): the manifest declares a signature but this build has no
/// verifier and no filesystem to fetch a local one — report `unverifiable`, never
/// fail open.
#[cfg(not(feature = "verify-ed25519"))]
fn verify_signature_material(_text: &str, _s: &Signing, _signature: &str, _source: Option<&str>, key_id: Option<String>) -> SignatureResult {
    SignatureResult::new("unverifiable", "signature present but this build has no ed25519 verifier (offline)", key_id)
}

/// `text.replace(/\n*$/, "\n")` — strip all trailing newlines, add exactly one.
#[cfg(feature = "verify-ed25519")]
fn normalize_trailing_newline(text: &str) -> String {
    let trimmed = text.trim_end_matches('\n');
    format!("{}\n", trimmed)
}

#[cfg(feature = "verify-ed25519")]
fn val_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Resolve inline-or-local material to a string. Inline material and local file
/// paths are read offline; an HTTPS location is refused (deferred to #50).
#[cfg(feature = "verify-ed25519")]
fn load_material(value: &str, source: Option<&str>) -> Result<String, String> {
    if looks_url(value) {
        return Err("remote fetch not available in this build (see #50)".to_string());
    }
    if looks_inline(value) {
        return Ok(value.to_string());
    }
    let path = resolve_location(source, value);
    std::fs::read_to_string(&path).map_err(|e| format!("{}: {}", path, e))
}

#[cfg(feature = "verify-ed25519")]
fn looks_url(value: &str) -> bool {
    let v = value.trim_start();
    v.starts_with("https://") || v.starts_with("http://")
}

/// Resolve a possibly-relative local location against the manifest's source dir
/// (mirrors TS `resolveLocation` for the non-URL case: `join(dirname(base), loc)`).
#[cfg(feature = "verify-ed25519")]
fn resolve_location(base: Option<&str>, loc: &str) -> String {
    if std::path::Path::new(loc).is_absolute() {
        return loc.to_string();
    }
    match base {
        Some(b) => {
            let dir = std::path::Path::new(b).parent();
            match dir {
                Some(d) if !d.as_os_str().is_empty() => d.join(loc).to_string_lossy().to_string(),
                _ => loc.to_string(),
            }
        }
        None => loc.to_string(),
    }
}

/// Is this inline key/signature material rather than a URL/path? Mirrors TS
/// `looksInline`: PEM markers, or raw material of a telltale ed25519 size.
#[cfg(feature = "verify-ed25519")]
fn looks_inline(value: &str) -> bool {
    if looks_url(value) {
        return false;
    }
    if value.contains("-----BEGIN") {
        return true;
    }
    match decode_bytes(value) {
        Some(b) => matches!(b.len(), 32 | 44 | 64),
        None => false,
    }
}

/// Decode PEM/base64/hex material to bytes — a port of TS `decodeBytes`.
#[cfg(feature = "verify-ed25519")]
fn decode_bytes(material: &str) -> Option<Vec<u8>> {
    let s = material.trim();
    if let Some(inner) = pem_body(s) {
        return base64_decode(&strip_ws(&inner));
    }
    let stripped = strip_ws(s);
    let is_hex = !stripped.is_empty() && stripped.bytes().all(|b| b.is_ascii_hexdigit());
    if is_hex && stripped.len() % 2 == 0 && stripped.len() >= 64 {
        return hex_decode(&stripped);
    }
    let is_b64 = !stripped.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=' || b.is_ascii_whitespace());
    if is_b64 {
        return base64_decode(&stripped);
    }
    None
}

/// Extract the body between PEM `-----BEGIN ...-----` / `-----END ...-----`.
#[cfg(feature = "verify-ed25519")]
fn pem_body(s: &str) -> Option<String> {
    let begin = s.find("-----BEGIN")?;
    let after_begin = &s[begin..];
    let body_start = after_begin.find("-----")? ;
    // Skip the full BEGIN line's closing dashes.
    let rest = &after_begin[body_start + 5..];
    let hdr_end = rest.find("-----")?; // end of "BEGIN X" header
    let body_and_end = &rest[hdr_end + 5..];
    let end = body_and_end.find("-----END")?;
    Some(body_and_end[..end].to_string())
}

#[cfg(feature = "verify-ed25519")]
fn strip_ws(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

#[cfg(feature = "verify-ed25519")]
fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        let hi = (bytes[i] as char).to_digit(16)?;
        let lo = (bytes[i + 1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
        i += 2;
    }
    Some(out)
}

#[cfg(feature = "verify-ed25519")]
fn base64_decode(s: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes: Vec<u8> = s.bytes().filter(|&b| b != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut nbits = 0;
    for c in bytes {
        let v = val(c)? as u32;
        acc = (acc << 6) | v;
        nbits += 6;
        if nbits >= 8 {
            nbits -= 8;
            out.push((acc >> nbits) as u8);
        }
    }
    Some(out)
}

/// Import an ed25519 public key from raw (32) or SPKI-DER (44) bytes.
#[cfg(feature = "verify-ed25519")]
fn import_public_key(material: &str) -> Result<VerifyingKey, String> {
    let bytes = decode_bytes(material).ok_or_else(|| "unrecognized public key encoding".to_string())?;
    let raw: [u8; 32] = if bytes.len() == 32 {
        bytes.as_slice().try_into().unwrap()
    } else if bytes.len() >= 32 {
        // SPKI DER for ed25519 is a 12-byte prefix + the 32-byte key.
        bytes[bytes.len() - 32..].try_into().unwrap()
    } else {
        return Err("public key is too short".to_string());
    };
    VerifyingKey::from_bytes(&raw).map_err(|e| e.to_string())
}

// ── network verification ─────────────────────────────────────────────────────
// The full path (a port of the complete verify.ts): fetch a remote signature/key
// through the SSRF guard, and honor a pinned `trusted_key`. Reuses the sync crypto
// helpers above; the offline `verify_manifest_text` stays untouched.

/// Options for network verification (a port of TS `VerifyOptions`).
#[cfg(feature = "network")]
#[derive(Debug, Clone, Default)]
pub struct VerifyOptions {
    /// Pinned key material (path/URL/inline) — overrides any manifest/envelope key.
    pub trusted_key: Option<String>,
    pub guard: crate::fetch::FetchGuard,
}

/// Verify a manifest, fetching a remote signature/key through the guard. Mirrors
/// the offline `verify_manifest_text` but completes the deferred remote path.
#[cfg(feature = "network")]
pub async fn verify_manifest_text_net(text: &str, signing: Option<&Signing>, source: Option<&str>, opts: &VerifyOptions) -> SignatureResult {
    let s = match signing {
        None => return SignatureResult::new("unsigned", "manifest declares no signature", None),
        Some(s) => s,
    };
    let mut key_id = s.key_id.clone();
    let signature = match &s.signature {
        None => {
            return SignatureResult::new("unverifiable", "manifest declares a signing block but no signature location — treating as unverified", key_id);
        }
        Some(sig) => sig,
    };
    if let Some(scheme) = &s.scheme {
        let low = scheme.to_lowercase();
        if low != "ed25519" && low != "eddsa" {
            return SignatureResult::new("unverifiable", format!("unsupported signing scheme '{}'", scheme), key_id);
        }
    }

    // Signature material (inline, local, or remote through the guard).
    let raw_sig = match load_material_net(signature, source, &opts.guard).await {
        Ok(v) => v,
        Err(e) => return SignatureResult::new("unverifiable", format!("cannot load signature: {}", e), None),
    };
    let mut embedded_key: Option<String> = None;
    let signature_material: String = match serde_json::from_str::<serde_json::Value>(&raw_sig) {
        Ok(serde_json::Value::Object(env)) => {
            let sig_field = env.get("signature").map(val_to_string).unwrap_or_default();
            embedded_key = env.get("public_key").map(val_to_string);
            if let Some(kid) = env.get("key_id") {
                key_id = Some(val_to_string(kid));
            }
            if let Some(alg) = env.get("algorithm") {
                let low = val_to_string(alg).to_lowercase();
                if low != "ed25519" && low != "eddsa" {
                    return SignatureResult::new("unverifiable", format!("unsupported signature algorithm '{}'", val_to_string(alg)), key_id);
                }
            }
            sig_field
        }
        _ => raw_sig,
    };

    // Public key: a pinned key wins, then the manifest's declared key, then the
    // envelope-embedded key (self-attesting).
    let (key_material, via) = if let Some(tk) = &opts.trusted_key {
        match load_material_net(tk, None, &opts.guard).await {
            Ok(m) => (m, "pinned key"),
            Err(e) => return SignatureResult::new("unverifiable", format!("cannot load public key: {}", e), key_id),
        }
    } else if let Some(pk) = &s.public_key {
        match load_material_net(pk, source, &opts.guard).await {
            Ok(m) => (m, "declared key"),
            Err(_) if embedded_key.is_some() => (embedded_key.clone().unwrap(), "envelope key"),
            Err(e) => return SignatureResult::new("unverifiable", format!("cannot load public key: {}", e), key_id),
        }
    } else if let Some(ek) = &embedded_key {
        (ek.clone(), "envelope key")
    } else {
        return SignatureResult::new("unverifiable", "no public key available", key_id);
    };

    crypto_verify(text, &signature_material, &key_material, via, key_id)
}

/// The pure crypto tail shared by the offline and network verify paths.
#[cfg(feature = "verify-ed25519")]
fn crypto_verify(text: &str, sig_material: &str, key_material: &str, via: &str, key_id: Option<String>) -> SignatureResult {
    let sig_bytes = match decode_bytes(sig_material) {
        Some(b) if b.len() == 64 => b,
        _ => return SignatureResult::new("invalid", "signature is not 64 ed25519 signature bytes", key_id),
    };
    let verifying_key = match import_public_key(key_material) {
        Ok(k) => k,
        Err(e) => return SignatureResult::new("unverifiable", format!("cannot import public key: {}", e), key_id),
    };
    let sig = Signature::from_bytes(&sig_bytes.as_slice().try_into().expect("checked len 64"));
    for candidate in [text.to_string(), normalize_trailing_newline(text)] {
        if verifying_key.verify(candidate.as_bytes(), &sig).is_ok() {
            return SignatureResult::new("verified", format!("ed25519 signature verified ({})", via), key_id);
        }
    }
    SignatureResult::new("invalid", "ed25519 signature does not match manifest bytes", key_id)
}

/// Resolve inline / local / remote material to a string. Inline is returned as-is;
/// a relative location is resolved against `source` (URL join or path join); a URL
/// is fetched through the guard.
#[cfg(feature = "network")]
async fn load_material_net(value: &str, source: Option<&str>, guard: &crate::fetch::FetchGuard) -> Result<String, String> {
    if looks_inline(value) {
        return Ok(value.to_string());
    }
    let loc = resolve_location_net(source, value);
    if crate::client::is_url(&loc) {
        return crate::fetch::guarded_fetch_text(&loc, guard).await;
    }
    std::fs::read_to_string(&loc).map_err(|e| format!("{}: {}", loc, e))
}

/// Resolve a location against a base that may itself be a URL (mirrors TS
/// `resolveLocation`): URL base → URL join; path base → dir join.
#[cfg(feature = "network")]
fn resolve_location_net(base: Option<&str>, loc: &str) -> String {
    if crate::client::is_url(loc) {
        return loc.to_string();
    }
    if let Some(b) = base {
        if crate::client::is_url(b) {
            if let Ok(u) = reqwest::Url::parse(b).and_then(|bu| bu.join(loc)) {
                return u.to_string();
            }
        }
    }
    resolve_location(base, loc)
}

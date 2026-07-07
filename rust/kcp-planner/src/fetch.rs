//! Guarded network reads — a Rust port of `src/fetch.ts`. A manifest is untrusted
//! input that chooses URLs the agent then fetches (federation refs, signature/key
//! locations, remote unit content). Bare fetching makes the agent a confused
//! deputy; this helper closes four holes, fail-closed by default:
//!
//!   * scheme:   https only for remote (http only to loopback, only when allowed)
//!   * host:     every resolved address is checked; private/loopback/link-local refused
//!   * redirect: manual — each hop's Location is re-checked against the guard
//!   * size:     the body is streamed against a byte ceiling and aborted over it
//!   * time:     a per-request timeout caps the exchange
//!
//! The planner's fail-closed discipline reaches the socket here.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;

pub const DEFAULT_MAX_BYTES: usize = 8 * 1024 * 1024;
pub const DEFAULT_TIMEOUT_MS: u64 = 15_000;
const MAX_REDIRECTS: usize = 5;

#[derive(Debug, Clone, Default)]
pub struct FetchGuard {
    /// Permit loopback / private / link-local hosts (and http:// to loopback). Default false.
    pub allow_private: bool,
    /// Max response bytes before the read is aborted. Default 8 MiB.
    pub max_bytes: Option<usize>,
    /// Whole-exchange timeout in ms. Default 15000.
    pub timeout_ms: Option<u64>,
}

/// True for IPv4/IPv6 literals that must never be reached from an untrusted manifest.
pub fn is_private_address(addr: &str) -> bool {
    if let Ok(v4) = addr.parse::<Ipv4Addr>() {
        return is_private_v4(v4.octets());
    }
    if let Ok(v6) = addr.parse::<Ipv6Addr>() {
        return is_private_v6(v6, &addr.to_lowercase());
    }
    false
}

fn is_private_v4(o: [u8; 4]) -> bool {
    let (a, b) = (o[0], o[1]);
    a == 0            // 0.0.0.0/8 "this host"
        || a == 10    // private
        || a == 127   // loopback
        || (a == 169 && b == 254)          // link-local incl. cloud metadata 169.254.169.254
        || (a == 172 && (16..=31).contains(&b)) // private
        || (a == 192 && b == 168)          // private
        || (a == 100 && (64..=127).contains(&b)) // CGNAT 100.64/10
        || a >= 224 // multicast / reserved
}

fn is_private_v6(v6: Ipv6Addr, lower: &str) -> bool {
    // IPv4-mapped addresses embed a v4 address a connect() actually reaches — decode
    // and check it (covers both ::ffff:a.b.c.d and the ::ffff:a9fe:a9fe hex form a
    // URL parser normalizes to), or an IPv6 literal slips the v4 check to metadata.
    if let Some(v4) = v6.to_ipv4_mapped() {
        return is_private_v4(v4.octets());
    }
    lower == "::1"                 // loopback
        || lower == "::"           // unspecified
        || lower.starts_with("fe80") // link-local
        || lower.starts_with("fc")   // unique-local fc00::/7
        || lower.starts_with("fd")
        || lower.starts_with("ff") // multicast
}

/// Refuse a URL whose scheme/host an untrusted manifest must not reach; return the
/// checked URL. This *is* the security decision — applied to the initial URL and,
/// identically, to every redirect target.
#[cfg(feature = "network")]
pub async fn assert_public_url(raw_url: &str, guard: &FetchGuard) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw_url).map_err(|_| format!("not a valid URL: {}", raw_url))?;
    let scheme = url.scheme();
    if scheme != "https" && scheme != "http" {
        return Err(format!("refused scheme '{}:' (only http/https are fetched)", scheme));
    }
    let host_raw = url.host_str().ok_or_else(|| format!("URL has no host: {}", raw_url))?;
    let host = host_raw.trim_start_matches('[').trim_end_matches(']'); // strip IPv6 brackets

    // Resolve the host to every address it would connect to, and check them all.
    let addresses: Vec<String> = if host.parse::<IpAddr>().is_ok() {
        vec![host.to_string()]
    } else {
        let resolved: Vec<String> = tokio::net::lookup_host((host, 0))
            .await
            .map_err(|e| format!("cannot resolve host '{}': {}", host, e))?
            .map(|sa| sa.ip().to_string())
            .collect();
        if resolved.is_empty() {
            return Err(format!("host '{}' resolved to no addresses", host));
        }
        resolved
    };

    if !guard.allow_private {
        if let Some(blocked) = addresses.iter().find(|a| is_private_address(a)) {
            return Err(format!(
                "refused private/loopback/link-local address {} for '{}' (pass --allow-private-hosts to permit local and internal manifests)",
                blocked, host
            ));
        }
        if scheme == "http" {
            return Err(format!("refused cleartext http:// for '{}' (use https, or --allow-private-hosts for local)", host));
        }
    }
    Ok(url)
}

/// Fetch text from a URL through the guard: scheme + host + redirect + size + time.
#[cfg(feature = "network")]
pub async fn guarded_fetch_text(raw_url: &str, guard: &FetchGuard) -> Result<String, String> {
    let max_bytes = guard.max_bytes.unwrap_or(DEFAULT_MAX_BYTES);
    let timeout = Duration::from_millis(guard.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none()) // manual — re-check every hop
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?;

    let mut current = raw_url.to_string();
    for _hop in 0..=MAX_REDIRECTS {
        let url = assert_public_url(&current, guard).await?;
        let resp = client.get(url.clone()).send().await.map_err(|e| e.to_string())?;
        let status = resp.status();

        if status.is_redirection() {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| format!("redirect with no Location from {}", url))?;
            current = url.join(loc).map_err(|e| e.to_string())?.to_string();
            continue;
        }
        if !status.is_success() {
            return Err(format!("{} {}", status.as_u16(), status.canonical_reason().unwrap_or("")));
        }
        if let Some(len) = resp.content_length() {
            if len > max_bytes as u64 {
                return Err(format!("response too large: {} bytes exceeds cap {}", len, max_bytes));
            }
        }
        return read_capped(resp, max_bytes, url.as_str()).await;
    }
    Err(format!("too many redirects (>{}) starting at {}", MAX_REDIRECTS, raw_url))
}

/// Stream the body against the byte ceiling, aborting the moment it's exceeded
/// (for servers that don't declare content-length, or lie).
#[cfg(feature = "network")]
async fn read_capped(mut resp: reqwest::Response, max_bytes: usize, href: &str) -> Result<String, String> {
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        buf.extend_from_slice(&chunk);
        if buf.len() > max_bytes {
            return Err(format!("response too large: exceeded cap {} bytes while reading {}", max_bytes, href));
        }
    }
    String::from_utf8(buf).map_err(|e| e.to_string())
}

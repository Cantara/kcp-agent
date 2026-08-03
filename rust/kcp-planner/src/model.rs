//! The compact KCP manifest model — a Rust port of `src/model.ts` + the lenient
//! parsing in `src/client.ts`. Field names are snake_case to match the YAML
//! wire format; serde ignores unknown fields (lenient, like the TS parser).

use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};

fn default_project() -> String {
    "(unnamed)".to_string()
}
fn default_version() -> String {
    "0.0.0".to_string()
}

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    #[serde(default = "default_project")]
    pub project: String,
    #[serde(default = "default_version")]
    pub version: String,
    #[serde(default)]
    pub kcp_version: Option<String>,
    #[serde(default)]
    pub units: Vec<Unit>,
    #[serde(default)]
    pub manifests: Vec<ManifestRef>,
    #[serde(default)]
    pub payment: Option<Payment>,
    #[serde(default)]
    pub rate_limits: Option<RateLimits>,
    #[serde(default)]
    pub trust: Option<Trust>,
    #[serde(default)]
    pub signing: Option<Signing>,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Unit {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub intent: String,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub audience: Vec<String>,
    #[serde(default)]
    pub triggers: Vec<String>,
    #[serde(default)]
    pub access: Option<String>,
    #[serde(default)]
    pub auth_scope: Option<String>,
    #[serde(default)]
    pub deprecated: Option<bool>,
    #[serde(default)]
    pub not_for: Vec<String>,
    #[serde(default)]
    pub payment: Option<Payment>,
    #[serde(default)]
    pub rate_limits: Option<RateLimits>,
    #[serde(default)]
    pub size_tokens: Option<i64>,
    #[serde(default)]
    pub bytes: Option<i64>,
    #[serde(default)]
    pub temporal: Option<Temporal>,
    /// Unit classification — e.g. "skill" for a procedure governed as an
    /// invoke-eligible unit (#100).
    #[serde(default)]
    pub kind: Option<String>,
    /// Explicit eligibility grant for a skill. Skills fail closed by default;
    /// only a unit with `load_eligible: true` is load/invoke-eligible (#100).
    #[serde(default)]
    pub load_eligible: Option<bool>,
    /// Declared action scope for a governed procedure/skill — the tools, paths,
    /// and capabilities it is permitted to touch when invoked (#100).
    #[serde(default)]
    pub action_scope: Option<ActionScope>,
}

/// Declared action scope for a governed procedure/skill (#100).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ActionScope {
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    #[serde(default)]
    pub paths: Option<Vec<String>>,
    #[serde(default)]
    pub capabilities: Option<Vec<String>>,
    #[serde(default)]
    pub spend: Option<Spend>,
}

/// Spend limits declared under a skill's action scope (#107).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Spend {
    #[serde(default)]
    pub max_spend: Option<f64>,
    #[serde(default)]
    pub allowed_vendors: Option<Vec<String>>,
    #[serde(default)]
    pub currency: Option<String>,
}

// Serialization mirrors the TS wire shape exactly (`action_scope` echoed onto a
// planned/traced unit): `tools`/`paths`/`capabilities` are always present as arrays
// (like the reference's `asStrArr`), `spend` is emitted only when declared. Within
// `spend`, `max_spend` is emitted only when set (with JS number formatting — a whole
// value prints as an integer), `allowed_vendors` is always an array, and `currency`
// is emitted only when set. Hand-written (not derived) so field order and array/number
// formatting match byte-for-byte.
impl Serialize for ActionScope {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let empty: &[String] = &[];
        let mut m = s.serialize_map(None)?;
        m.serialize_entry("tools", self.tools.as_deref().unwrap_or(empty))?;
        m.serialize_entry("paths", self.paths.as_deref().unwrap_or(empty))?;
        m.serialize_entry("capabilities", self.capabilities.as_deref().unwrap_or(empty))?;
        if let Some(spend) = &self.spend {
            m.serialize_entry("spend", spend)?;
        }
        m.end()
    }
}

impl Serialize for Spend {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let empty: &[String] = &[];
        let mut m = s.serialize_map(None)?;
        if let Some(ms) = self.max_spend {
            // JS number formatting: a whole value prints as an integer (5, not 5.0).
            if ms.fract() == 0.0 && ms.abs() < 9.0e15 {
                m.serialize_entry("max_spend", &(ms as i64))?;
            } else {
                m.serialize_entry("max_spend", &ms)?;
            }
        }
        m.serialize_entry("allowed_vendors", self.allowed_vendors.as_deref().unwrap_or(empty))?;
        if let Some(currency) = &self.currency {
            m.serialize_entry("currency", currency)?;
        }
        m.end()
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Temporal {
    #[serde(default)]
    pub valid_from: Option<String>,
    #[serde(default)]
    pub valid_until: Option<String>,
    #[serde(default)]
    pub superseded_by: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ManifestRef {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub relationship: Option<String>,
    #[serde(default)]
    pub context: Option<Vec<String>>,
    #[serde(default)]
    pub agent_identity: Option<AgentIdentity>,
    /// Relative path (to this manifest) to a preferred local copy of `url` (SPEC.md §3.6, #136).
    #[serde(default)]
    pub local_mirror: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentIdentity {
    #[serde(default)]
    pub required: Option<bool>,
    #[serde(default)]
    pub credential_hint: Option<String>,
    #[serde(default)]
    pub issuer_hint: Option<String>,
    #[serde(default)]
    pub docs_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Payment {
    #[serde(default)]
    pub default_tier: Option<String>,
    #[serde(default)]
    pub methods: Option<Vec<PaymentMethod>>,
    #[serde(default)]
    pub billing_contact: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PaymentMethod {
    #[serde(default)]
    pub r#type: String,
    #[serde(default)]
    pub currency: Option<String>,
    /// Kept as a string (the YAML quotes it, e.g. "0.25"); parsed to f64 in planning.
    #[serde(default, deserialize_with = "de_stringy_opt")]
    pub price_per_request: Option<String>,
    #[serde(default)]
    pub networks: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RateLimits {
    #[serde(default)]
    pub default: Option<RateLimitTier>,
    #[serde(default)]
    pub authenticated: Option<RateLimitTier>,
    #[serde(default)]
    pub premium: Option<RateLimitTier>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RateLimitTier {
    #[serde(default, deserialize_with = "de_count_opt")]
    pub requests_per_minute: Option<Count>,
}

/// A request count that may be a number or the literal string "unlimited".
#[derive(Debug, Clone, PartialEq)]
pub enum Count {
    N(i64),
    Unlimited,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Trust {
    #[serde(default)]
    pub agent_requirements: Option<AgentRequirements>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentRequirements {
    #[serde(default)]
    pub require_attestation: Option<bool>,
    #[serde(default)]
    pub trusted_providers: Vec<String>,
    #[serde(default)]
    pub attestation_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Signing {
    #[serde(default)]
    pub scheme: Option<String>,
    #[serde(default)]
    pub public_key: Option<String>,
    #[serde(default)]
    pub signature: Option<String>,
    #[serde(default)]
    pub key_id: Option<String>,
}

/// Coerce a scalar (string, number, bool) to an owned String — mirrors the TS
/// `asStr` coercion so a numeric `price_per_request: 0.25` and a quoted
/// `"0.25"` parse identically.
fn de_stringy_opt<'de, D>(d: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;
    let v = serde_yaml::Value::deserialize(d)?;
    Ok(match v {
        serde_yaml::Value::Null => None,
        serde_yaml::Value::String(s) => Some(s),
        serde_yaml::Value::Number(n) => Some(n.to_string()),
        serde_yaml::Value::Bool(b) => Some(b.to_string()),
        _ => return Err(D::Error::custom("price_per_request must be a scalar")),
    })
}

fn de_count_opt<'de, D>(d: D) -> Result<Option<Count>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = serde_yaml::Value::deserialize(d)?;
    Ok(match v {
        serde_yaml::Value::Null => None,
        serde_yaml::Value::String(s) if s == "unlimited" => Some(Count::Unlimited),
        serde_yaml::Value::Number(n) => n.as_i64().map(Count::N),
        _ => None,
    })
}

/// Parse a YAML manifest string into the compact model.
pub fn parse_manifest(text: &str, source: Option<&str>) -> Result<Manifest, serde_yaml::Error> {
    let mut m: Manifest = serde_yaml::from_str(text)?;
    if source.is_some() {
        m.source = source.map(str::to_string);
    }
    Ok(m)
}

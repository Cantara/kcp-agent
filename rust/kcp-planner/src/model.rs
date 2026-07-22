//! The compact KCP manifest model — a Rust port of `src/model.ts` + the lenient
//! parsing in `src/client.ts`. Field names are snake_case to match the YAML
//! wire format; serde ignores unknown fields (lenient, like the TS parser).

use serde::Deserialize;

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
#[derive(Debug, Clone, Deserialize)]
pub struct ActionScope {
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    #[serde(default)]
    pub paths: Option<Vec<String>>,
    #[serde(default)]
    pub capabilities: Option<Vec<String>>,
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

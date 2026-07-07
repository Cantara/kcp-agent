//! `kcp-planner` — a Rust port of the deterministic KCP planner (the LLM-free
//! core of [kcp-agent](https://github.com/Cantara/kcp-agent)).
//!
//! Given a task and a `knowledge.yaml`, [`plan`] produces an inspectable load
//! plan: which units to load and in what order, which to skip and exactly why,
//! how sub-manifests are selected, and what the whole thing costs. Pure — no
//! I/O, no model, no clock (the point-in-time is the injected `as_of`).
//!
//! The behavior is defined by the TypeScript reference implementation and pinned
//! by the shared conformance vectors (`vectors/*.json`); see the `conformance`
//! integration test. Two implementations that agree on every vector validate the
//! spec, not just the code.

pub mod budget;
pub mod diff;
pub mod format;
pub mod json;
pub mod model;
pub mod plan_io;
pub mod planner;
pub mod trace;
pub mod validate;
pub mod verify;
pub mod vectors;

pub use diff::{diff_plans, PlanDiff};
pub use format::{format_diff, format_plan, format_trace, format_validation, Colors};
pub use json::{plan_to_json, plan_to_value, trace_to_json};
pub use model::{parse_manifest, Manifest, Unit};
pub use plan_io::plan_from_artifact;
pub use planner::{plan, score_unit, terms, AgentPlan, PlanOptions};
pub use trace::{trace, trace_outcome, DecisionTrace, GateName, TraceOutcome, GATE_ORDER};
pub use validate::{validate_location, validate_manifest, Finding, ValidationReport};
pub use verify::{verify_manifest_text, SignatureResult};
pub use vectors::{outcome_of, run_vector, ConformanceVector, VectorOutcome};

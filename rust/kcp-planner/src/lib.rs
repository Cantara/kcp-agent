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
pub mod model;
pub mod planner;
pub mod vectors;

pub use model::{parse_manifest, Manifest, Unit};
pub use planner::{plan, score_unit, terms, AgentPlan, PlanOptions};
pub use vectors::{outcome_of, run_vector, ConformanceVector, VectorOutcome};

# kcp-planner (Java)

The deterministic KCP planner for the JVM — a Java port of the [kcp-agent](../../)
reference core, validated against the shared conformance vectors.

> *"The planner as a dependency, not a sidecar."*

Given a `knowledge.yaml` manifest and a task, `KcpPlanner.plan` produces an
inspectable **load plan**: which units to load and in what order, which to skip and
exactly why, how sub-manifests are selected across the federation, and what the whole
thing costs. No LLM, no I/O in the core — pure, auditable computation. It is the same
deterministic planner as the TypeScript reference and the [Rust port](../../rust/kcp-planner),
proven identical by reproducing every vector in [`vectors/`](../../vectors).

## Coordinates

```xml
<dependency>
  <groupId>no.cantara.kcp</groupId>
  <artifactId>kcp-planner</artifactId>
  <version>0.1.0-SNAPSHOT</version>
</dependency>
```

Java 17+. One runtime dependency (SnakeYAML Engine, YAML 1.2). JPMS module
`no.cantara.kcp.planner`.

## Usage

```java
import no.cantara.kcp.planner.*;
import no.cantara.kcp.planner.model.Manifest;

Manifest manifest = ManifestParser.parse(yamlText, "knowledge.yaml");

// Simplest form — default capabilities (role "agent", free payment).
AgentPlan plan = KcpPlanner.plan(manifest, "how do I deploy to production?");

// With options.
AgentPlan plan = KcpPlanner.plan(manifest, "setup CI", PlanOptions.builder()
    .role("developer")
    .maxUnits(10)
    .strict(true)
    .budget(0.05, "USDC")
    .contextBudget(4000)
    .build());

for (PlannedUnit u : plan.selected()) {
    System.out.println(u.id() + "  score=" + u.score() + "  " + u.reasons());
}
for (SkippedUnit s : plan.skipped()) {
    System.out.println("skip " + s.id() + ": " + s.reason());
}
```

`AgentPlan` is a pure data record — the auditable artifact you can read *before* any
content is loaded or any request is paid for.

## The gate cascade

Each unit runs the same 13 gates, in order; the first that fails skips the unit with a
verbatim, human-readable reason (the "every decision is a sentence" contract):

1. `audience` — role-based filtering
2. `not_for` — negative-space exclusion
3. `temporal` — `valid_from` / `valid_until` date gating
4. `deprecated`
5. `supersession` — `superseded_by` with an active-successor check (spec §4.22)
6. `relevance` — term scoring (intent ×3, triggers ×4, id/path ×2)
7. `attestation` — trust-layer gating
8. `payment` — economic affordability
9. `access` — credential requirements
10. `strict` — fail-closed mode
11. `max_units` — greedy cap
12. `money_budget` — spend ceiling
13. `context_budget` — token ceiling

Currency arithmetic uses `BigDecimal`; token arithmetic is integer.

## Conformance

The proof is the [`vectors/`](../../vectors) corpus: `(manifest, task, options) →
expected outcome`. `mvn test` runs every vector through the planner and deep-equals the
result against the expected outcome. Two independent implementations that agree on every
decision validate the spec, not just the code.

```bash
mvn clean test
```

## Scope

This is the deterministic core — `plan`, and (in later phases) `trace`, `diff`,
`validate`, a manifest client with signature verification, an MCP server, and a Spring
Boot starter. There is no LLM synthesis, episodic memory, or `ask` command; those remain
in the TypeScript agent.

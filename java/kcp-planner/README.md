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
  <version>0.16.0</version>
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

## Trace & diff

`KcpPlanner.trace` makes the reasoning transparent — it produces the canonical plan
and then annotates every unit with a structured verdict for each gate it was
evaluated against (the trace is a read, not a fork):

```java
DecisionTrace t = KcpPlanner.trace(manifest, "deploy to production");
for (UnitTrace u : t.units()) {
    System.out.println(u.id() + " → " + u.outcome()
        + (u.rejectedBy() != null ? " (rejected by " + u.rejectedBy().wire() + ")" : ""));
}
t.gateSummary().forEach(g ->
    System.out.println(g.gate().wire() + ": " + g.passed() + " passed, " + g.failed() + " failed"));
```

`KcpPlanner.diffPlans` compares two plan artifacts and reports what moved — units
that flipped selected/skipped, score changes, presence changes, budget/context
shifts, skip-reason changes, warning changes:

```java
PlanDiff d = KcpPlanner.diffPlans(planA, planB);
if (!d.identical()) {
    d.moves().forEach(m -> System.out.println(m.id() + ": " + m.direction()));
}
```

Both are pure. Because the planner is deterministic, every difference has a cause —
the diff names the symptoms; the trace explains them.

## MCP server

The planner is exposed to any MCP client (Claude Desktop, Claude Code, custom agents)
over stdio JSON-RPC 2.0 — newline-delimited framing, implemented directly, no SDK
dependency:

```bash
java -jar kcp-planner.jar          # reads JSON-RPC from stdin, writes to stdout
```

Five tools:

| Tool | What it does |
|---|---|
| `kcp_plan` | the inspectable load plan (with the manifest's SHA-256) |
| `kcp_trace` | the plan plus per-unit gate verdicts |
| `kcp_load` | the plan plus the *content* of load-eligible units (with `known`-unit session dedup) |
| `kcp_validate` | lint a knowledge.yaml — structural errors and navigation-weakening warnings |
| `kcp_replay` | cross-examine a saved plan artifact: re-fetch, compare sha256, re-plan, report drift |

`kcp_plan` and `kcp_trace` output is byte-for-byte identical to the TypeScript reference.
`McpServer.handleMessage` is a pure request → response function; the `initialize`
handshake, `tools/list`, and every `tools/call` are unit-tested.

## Network & signature verification

`ManifestClient` loads a manifest from a local path, a directory, or an `https://`
URL, computes the SHA-256 of the exact bytes, and can verify its Ed25519 signature:

```java
ManifestClient client = ManifestClient.builder()
    .timeout(Duration.ofSeconds(10))
    .build();                         // HTTPS-only to public hosts by default
LoadedManifest lm = client.load("https://example.com/knowledge.yaml", true /* verify */);
if (lm.signature() != null && !lm.signature().verified()) {
    throw new IllegalStateException("untrusted manifest: " + lm.signature().detail());
}
AgentPlan plan = KcpPlanner.plan(lm.manifest(), "how do I deploy?");
```

Every remote read funnels through an **SSRF guard** (`SsrfGuard`): cleartext `http://`
to remote hosts is refused, private / loopback / link-local / multicast addresses are
refused, and the host is resolved and every resolved address checked *before* the
connection — so a name that rebinds to `127.0.0.1` or `169.254.169.254` is refused.
Redirects are followed manually and re-checked at each hop; the response is bounded in
size and time. No external HTTP dependency — `java.net.http.HttpClient`.

`ManifestVerifier` verifies Ed25519 signatures (JDK-native) over the exact manifest
bytes, fail-closed: a present-but-wrong signature is always `invalid`; a signature that
can't be fetched is `unverifiable`, never silently downgraded to `unsigned`.

`FederationWalker` walks a federated manifest tree — planning the root, then following
each selected, un-credential-gated sub-manifest through the same guard — and propagates
the spend committed upstream so the money budget is enforced tree-wide.

## Conformance

The proof is the [`vectors/`](../../vectors) corpus: `(manifest, task, options) →
expected outcome`. `mvn test` runs every vector through the planner and deep-equals the
result against the expected outcome. The decision trace and plan diff are held to the
same standard by golden fixtures generated from the TypeScript reference (per-gate
verdicts and detail strings included). Two independent implementations that agree on
every decision validate the spec, not just the code.

```bash
mvn clean test
```

## Scope

This is the deterministic core — `plan`, `trace`, `diff`, `validate`, a manifest client
with SSRF guard and Ed25519 verification, unit-content loading, replay, and a five-tool
MCP server. A [Spring Boot starter](../kcp-planner-spring-boot-starter) auto-configures it
as an injectable bean; the core here has zero Spring dependency and also runs in Quarkus,
Micronaut, or plain Java. There is no LLM synthesis, episodic memory, or `ask` command;
those remain in the TypeScript agent.

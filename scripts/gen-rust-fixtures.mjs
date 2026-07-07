#!/usr/bin/env node
// Generate golden fixtures for the Rust port's decision-trace (#45) and
// plan-diff (#46) phases — the same "freeze the reference behavior as data"
// approach as the conformance vectors. For trace we reuse every vector's
// (manifest, task, options); for diff we pair a manifest against two option
// sets so the diff has something to report.
//
//   npm run build && node scripts/gen-rust-fixtures.mjs

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = async (m) => import(pathToFileURL(path.join(ROOT, 'dist', m)).href);
const { parseManifest } = await load('client.js');
const { plan } = await load('planner.js');
const { trace } = await load('trace.js');
const { diffPlans } = await load('diff.js');

const VDIR = path.join(ROOT, 'vectors');
// The golden fixtures back the trace/diff conformance tests in BOTH ports; write
// a copy into each so each module's tests stay self-contained (Rust reads from
// its crate dir, Java from its classpath test resources).
const OUT_DIRS = [
  path.join(ROOT, 'rust', 'kcp-planner', 'fixtures'),
  path.join(ROOT, 'java', 'kcp-planner', 'src', 'test', 'resources', 'fixtures'),
];
for (const out of OUT_DIRS) {
  mkdirSync(path.join(out, 'trace'), { recursive: true });
  mkdirSync(path.join(out, 'diff'), { recursive: true });
}
const writeFixture = (kind, file, data) => {
  const body = JSON.stringify(data, null, 2) + '\n';
  for (const out of OUT_DIRS) writeFileSync(path.join(out, kind, file), body);
};

// A trace fixture omits the embedded canonical `plan` (already conformance-
// tested via vectors/) and keeps the trace-specific projection.
const traceOutcome = (t) => ({
  taskTerms: t.taskTerms,
  asOf: t.asOf,
  capabilities: t.capabilities,
  units: t.units,
  gateSummary: t.gateSummary,
});

const vectors = readdirSync(VDIR).filter((f) => f.endsWith('.json')).sort();
for (const f of vectors) {
  const v = JSON.parse(readFileSync(path.join(VDIR, f), 'utf8'));
  const t = trace(parseManifest(v.manifest, v.name), v.task, v.options ?? {});
  writeFixture('trace', f, { name: v.name, manifest: v.manifest, task: v.task, options: v.options ?? {}, expect: traceOutcome(t) });
}
console.log(`wrote ${vectors.length} trace fixtures`);

// Diff fixtures: same manifest, two option sets (a → b), plus one identical pair.
const manifestOf = (name) => JSON.parse(readFileSync(path.join(VDIR, `${name}.json`), 'utf8')).manifest;
const cap = (extra = {}) => ({ role: 'agent', paymentMethods: ['free', 'x402'], ...extra });

const diffCases = [
  {
    name: 'money-budget-flip',
    manifest: manifestOf('budget-greedy-skip'),
    task: 'sovereign compute award',
    a: { asOf: '2026-07-06', capabilities: cap() },
    b: { asOf: '2026-07-06', capabilities: cap(), budget: { amount: 0.25 } },
  },
  {
    name: 'context-budget-flip',
    manifest: manifestOf('context-budget-skip'),
    task: 'sovereign compute award',
    a: { asOf: '2026-07-06', capabilities: cap() },
    b: { asOf: '2026-07-06', capabilities: cap(), contextBudget: 3000 },
  },
  {
    name: 'credential-flip',
    manifest: manifestOf('access-restricted-gated'),
    task: 'merger deal terms',
    a: { asOf: '2026-07-06', capabilities: cap() },
    b: { asOf: '2026-07-06', capabilities: cap({ credentials: ['oauth2'] }) },
  },
  {
    name: 'identical',
    manifest: manifestOf('scoring-relevance'),
    task: 'sovereign compute award',
    a: { asOf: '2026-07-06', capabilities: cap() },
    b: { asOf: '2026-07-06', capabilities: cap() },
  },
];

for (const c of diffCases) {
  const m = parseManifest(c.manifest, c.name);
  const pa = plan(m, c.task, c.a);
  const pb = plan(m, c.task, c.b);
  writeFixture('diff', `${c.name}.json`, { name: c.name, manifest: c.manifest, task: c.task, a: c.a, b: c.b, expect: diffPlans(pa, pb) });
}
console.log(`wrote ${diffCases.length} diff fixtures`);

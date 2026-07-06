#!/usr/bin/env node
// Generate the conformance vector corpus (#34): author the INPUTS here, run the
// reference TS planner to freeze the expected outcome, and write one JSON file
// per vector to vectors/. Regenerate (and review the diff) whenever the planner
// intentionally changes; test/vectors.test.ts fails if the corpus drifts.
//
//   npm run build && node scripts/gen-vectors.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { plan } = await import(pathToFileURL(path.join(ROOT, 'dist', 'planner.js')).href);
const { parseManifest } = await import(pathToFileURL(path.join(ROOT, 'dist', 'client.js')).href);
const { outcomeOf } = await import(pathToFileURL(path.join(ROOT, 'dist', 'vectors.js')).href);

// ── shared manifests ─────────────────────────────────────────────────────────
const NEWSROOM = `kcp_version: "0.25"
project: newsroom
version: 1.0.0
units:
  - id: award-exclusive
    path: stories/award.md
    intent: "Exclusive: the sovereign compute award decision and the winning bid"
    audience: [agent]
    triggers: [sovereign, compute, award, exclusive]
    size_tokens: 2600
    payment: { methods: [{type: x402, currency: USDC, price_per_request: "0.25"}] }
  - id: power-feed
    path: feeds/power.md
    intent: "Live datacenter power-grid capacity feed for the compute award"
    audience: [agent]
    triggers: [datacenter, power, capacity, compute]
    size_tokens: 900
    payment: { methods: [{type: x402, currency: USDC, price_per_request: "0.05"}] }
  - id: free-summary
    path: stories/summary.md
    intent: "Free summary of the sovereign compute award"
    audience: [agent]
    triggers: [sovereign, compute, award]
    size_tokens: 300
  - id: weather
    path: misc/weather.md
    intent: "Local weather forecast"
    audience: [agent]
    triggers: [weather, forecast]
    size_tokens: 100
`;

const VAULT = `kcp_version: "0.25"
project: vault
version: 1.0.0
units:
  - id: board-memo
    path: memos/board.md
    intent: "Board memo on the merger deal terms"
    audience: [agent]
    triggers: [merger, deal, board]
    access: restricted
    auth_scope: "read:board"
    payment: { methods: [{type: x402, currency: USDC, price_per_request: "0.30"}] }
  - id: public-brief
    path: briefs/public.md
    intent: "Public brief on the merger deal"
    audience: [agent]
    triggers: [merger, deal, brief]
`;

const HUMAN_ONLY = `kcp_version: "0.25"
project: hr
version: 1.0.0
units:
  - id: salary-review
    path: hr/salary.md
    intent: "Annual salary review for the merger integration team"
    audience: [human]
    triggers: [salary, review, merger]
  - id: press-kit
    path: comms/press.md
    intent: "Press kit for the merger announcement"
    audience: [agent, human]
    triggers: [press, merger, announcement]
    not_for: [salary negotiation]
`;

const ATTEST = `kcp_version: "0.25"
project: cert
version: 1.0.0
trust:
  agent_requirements:
    require_attestation: true
    trusted_providers: [soc.cert.example]
units:
  - id: advisory
    path: advisories/zero-day.md
    intent: "Zero-day advisory for the incident response team"
    audience: [agent]
    triggers: [zero-day, advisory, incident]
    access: restricted
`;

const TEMPORAL = `kcp_version: "0.25"
project: newsroom
version: 1.0.0
units:
  - id: award-rumour
    path: stories/rumour.md
    intent: "Rumour round-up: who is favourite for the sovereign compute award?"
    audience: [agent]
    triggers: [sovereign, compute, award, rumour]
    temporal:
      valid_from: "2026-06-28"
      valid_until: "2026-07-05"
      superseded_by: award-exclusive
  - id: award-exclusive
    path: stories/award.md
    intent: "Exclusive: the sovereign compute award decision"
    audience: [agent]
    triggers: [sovereign, compute, award, exclusive]
    temporal:
      valid_from: "2026-07-05"
`;

const FEDERATION = `kcp_version: "0.25"
project: platform-hub
version: 1.0.0
units:
  - id: deploy-guide
    path: docs/deploy.md
    intent: "How to deploy to production"
    audience: [agent]
    triggers: [deploy, production, release]
manifests:
  - id: platform-prod
    url: https://prod.example.com/knowledge.yaml
    context: [prod]
  - id: platform-dev
    url: https://dev.example.com/knowledge.yaml
    context: [dev, test]
  - id: vendor
    url: https://vendor.example.com/knowledge.yaml
    agent_identity: { required: true, credential_hint: vendor_token }
`;

const cap = (extra = {}) => ({ role: 'agent', paymentMethods: ['free', 'x402'], ...extra });

// ── the corpus ───────────────────────────────────────────────────────────────
const inputs = [
  { name: 'scoring-relevance', spec: '§15', description: 'query scoring ranks by intent/trigger/id match; an unrelated unit is skipped',
    manifest: NEWSROOM, task: 'sovereign compute award', options: { asOf: '2026-07-06', capabilities: cap() } },

  { name: 'audience-role-excludes', spec: '§4', description: 'a human-only unit is not selected for an agent; audience targeting',
    manifest: HUMAN_ONLY, task: 'merger salary review', options: { asOf: '2026-07-06', capabilities: cap({ role: 'agent' }) } },

  { name: 'not-for-negative-target', spec: '§4', description: 'a unit its publisher scoped out via not_for is skipped even when relevant',
    manifest: HUMAN_ONLY, task: 'salary negotiation press', options: { asOf: '2026-07-06', capabilities: cap({ role: 'human' }) } },

  { name: 'access-restricted-gated', spec: '§4.11', description: 'access:restricted fails closed with no credentials, even when x402 is settleable',
    manifest: VAULT, task: 'merger deal terms', options: { asOf: '2026-07-06', capabilities: cap() } },

  { name: 'access-restricted-credentialed', spec: '§4.11', description: 'the same restricted unit is load-eligible once the agent holds a credential',
    manifest: VAULT, task: 'merger deal terms', options: { asOf: '2026-07-06', capabilities: cap({ credentials: ['oauth2'] }) } },

  { name: 'temporal-supersession-overlap', spec: '§4.22', description: 'on the overlap day the predecessor is skipped because its declared successor is active',
    manifest: TEMPORAL, task: 'sovereign compute award', options: { asOf: '2026-07-05', capabilities: cap() } },

  { name: 'attestation-gated', spec: '§3.2', description: 'a restricted unit is gated when the manifest requires attestation the agent cannot present',
    manifest: ATTEST, task: 'zero-day incident advisory', options: { asOf: '2026-07-06', capabilities: cap() } },

  { name: 'attestation-presented', spec: '§3.2', description: 'the gate opens once the agent presents a trusted attestation provider and the credential the restricted unit needs',
    manifest: ATTEST, task: 'zero-day incident advisory', options: { asOf: '2026-07-06', capabilities: cap({ attestationProvider: 'soc.cert.example', credentials: ['mtls'] }) } },

  { name: 'federation-context-identity', spec: '§3.6', description: 'federation refs are sliced by env context; an agent_identity ref needs its credential before fetch',
    manifest: FEDERATION, task: 'deploy to production', options: { env: 'prod', asOf: '2026-07-06', capabilities: cap() } },

  { name: 'budget-greedy-skip', spec: '§4.14', description: 'greedy by score, buy until the ceiling, skip what would blow it with the arithmetic',
    manifest: NEWSROOM, task: 'sovereign compute award', options: { asOf: '2026-07-06', capabilities: cap(), budget: { amount: 0.25 } } },

  { name: 'context-budget-skip', spec: '§4.15', description: 'a token ceiling is greedy by score; an over-budget unit is skipped with the token arithmetic',
    manifest: NEWSROOM, task: 'sovereign compute award', options: { asOf: '2026-07-06', capabilities: cap(), contextBudget: 3000 } },
];

const dir = path.join(ROOT, 'vectors');
mkdirSync(dir, { recursive: true });
for (const v of inputs) {
  v.expect = outcomeOf(plan(parseManifest(v.manifest, v.name), v.task, v.options));
  writeFileSync(path.join(dir, `${v.name}.json`), JSON.stringify(v, null, 2) + '\n');
}
console.log(`wrote ${inputs.length} vectors to vectors/`);

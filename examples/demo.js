#!/usr/bin/env node
// kcp-agent demo — three plans against the bundled Acme hub, showing the
// deterministic planner exercising the whole KCP stack. Drives the real CLI.
//
//   (npm install && npm run build) once, then:  node examples/demo.js

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const HUB = path.join(ROOT, 'examples', 'demo-hub');

const SCENARIOS = [
  {
    title: 'Prod agent, no attestation, can pay x402',
    blurb: 'The agent runs in prod and can settle x402 micropayments but cannot attest. Watch the ' +
      'restricted runbook get gated, the x402 feed get a per-request budget, the expired legacy ' +
      'policy get skipped, and the prod federation edge ask for a GitHub PAT.',
    args: ['plan', 'how do I deploy a release to production?', '--manifest', HUB, '--env', 'prod', '--methods', 'free,x402'],
  },
  {
    title: 'Same task, dev environment',
    blurb: 'Only the environment changes. The federation slice flips: the dev mirror is selected, the ' +
      'prod platform hub is excluded.',
    args: ['plan', 'how do I deploy a release to production?', '--manifest', HUB, '--env', 'dev'],
  },
  {
    title: 'Authorised agent: attests + holds a credential',
    blurb: 'Now the agent presents the trusted attestation provider and a credential. The restricted ' +
      'incident runbook becomes load-eligible, and the rate-limit tier rises to authenticated.',
    args: ['plan', 'incident rollback runbook', '--manifest', HUB, '--attest', 'internal-agents.acme.com', '--credentials', 'api_key'],
  },
];

for (const s of SCENARIOS) {
  console.log('\n\x1b[1m━━━ ' + s.title + '\x1b[0m\n');
  console.log('\x1b[2m' + s.blurb + '\x1b[0m\n');
  console.log('\x1b[36m  $ kcp-agent ' + s.args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ').replace(HUB, 'examples/demo-hub') + '\x1b[0m');
  const out = execFileSync('node', [CLI, ...s.args], { encoding: 'utf8' });
  console.log(out.split('\n').map((l) => '  ' + l).join('\n'));
}

console.log('\x1b[2m  The plan is deterministic and needs no API key. `kcp-agent ask` adds a Claude answer\x1b[0m');
console.log('\x1b[2m  synthesized from only the load-eligible units.\x1b[0m');

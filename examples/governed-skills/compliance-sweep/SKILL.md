---
name: compliance-sweep
description: Run an autonomous batch compliance sweep across customer records against the current policies and write a findings report. Authorized to read policies/ and customers/ and write only into reports/. Use for periodic audit sweeps; it never edits the records it audits.
---

# Compliance Sweep (autonomous batch skill)

**Purpose.** The unattended audit run: walk every customer record, test it
against the current compliance policies, and emit a findings report. It is a
*batch* skill — it touches many records — which is exactly why its write scope
is pinned to `reports/` and nothing else. It audits; it does not remediate.

**Declared blast radius.** `Read`, `Grep`, `Write`, over `policies/`,
`customers/`, and `reports/`. The only writable path is `reports/` — the skill
can record what it found, but cannot alter a customer record to "fix" a finding.
Separation of audit from remediation is enforced by the scope, not by good
intentions.

## Steps

1. **Load policies** from `policies/`.
2. **Enumerate** the customer records under `customers/` (read-only).
3. **Test each record** against the policies; collect violations with the
   record id and the policy clause each one breaches.
4. **Write the report** into `reports/` only.
5. **Do not remediate.** Flag every finding for a human/remediation skill; never
   edit a `customers/` record from this sweep.

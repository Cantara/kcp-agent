---
name: risk-assessment-2024
description: SUPERSEDED — the 2024 customer risk-assessment playbook. Kept for audit and replay of decisions made under it, but no longer selectable. The active successor is risk-assessment. Use nothing here for new work.
---

# Risk Assessment — 2024 edition (superseded)

**Purpose.** The prior year's version of the risk memo playbook. It is retained
so that decisions made in 2024 can be *replayed and explained* under the rules
that were in force at the time — not so that new assessments run against stale
thresholds.

**Status.** `temporal.superseded_by: risk-assessment`. The planner's
supersession gate skips this unit whenever the successor is active, so a
present-day plan follows `risk-assessment` and never resurrects this one. If
you are auditing a 2024 decision, plan with `--as-of 2024-06-01`.

## Steps (historical)

1. Load the 2024 risk-band table from `policies/`.
2. Read the customer record from `customers/`.
3. Score against the 2024 thresholds (since revised — do not apply today).
4. Write the memo; stop at the recommendation.

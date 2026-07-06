# Integration on-call runbook

When order flow stops:

1. Check the backbone consumer lag dashboard.
2. Replay from the last committed offset — never re-submit from the ERP side
   (creates duplicate production orders; see incident 2026-041).
3. Escalate to the plant MES team if lag is zero but orders are missing.

Escalation: Integration Platform on-call → MES on-call → duty plant manager.

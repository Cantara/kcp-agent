# ADR-007: Route all plant integrations through the ESB

**Status: superseded by ADR-012 (2026-03).**

Decision (2023): all integrations between the ERP and plant systems route
through the enterprise service bus, which owns transformation and retry.

Superseded because the ESB became the bottleneck team: every contract change
queued behind one backlog. Kept on file — the reasoning explains a decade of
integration topology.

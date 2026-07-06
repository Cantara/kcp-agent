# ADR-012: Replace the ESB with an event backbone

**Status: active (2026-03-01).**

Decision: plant integrations publish domain events to the backbone;
consumers own their own projections. Integration contracts are published
schemas (see the order API unit), validated in CI on both sides.

Consequences: the integration catalog gains an owner column — contract
accountability moves from the ESB team to the publishing team.

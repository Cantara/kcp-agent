# Orion ERP integration guide (partner subscription)

Order integration: `order_no` is the idempotency key — re-submission with
the same key is a no-op, never a duplicate. Recipe master data: field
`RCP_VER` must increment monotonically; Orion rejects out-of-order updates
with error contract `ORN-409-RCP`.

Full field mappings per module version in the partner portal.

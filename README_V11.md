# V11 — remaining audit hardening

Run after V10 repair migration. This patch is intentionally small and idempotent.

Fixes:
- DB-level unique protection for `point_transfers.transfer_group_id`.
- Employee audit now stores old/new state.
- Product audit now stores old/new state; price changes remain in `price_history`.
- Evening-summary save now stores old/new state and rejects negative cash values.
- Reasserts the canonical transfer signature and removes old overloads.
- Adds `point_schema_health()` for authenticated admin/operator diagnostics.

Do not remove or change Angar `current_workspace_id()` / `post_operation()`.

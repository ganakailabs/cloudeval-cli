---
name: cloudeval-billing
description: Inspect CloudEval credits, plans, usage, ledger, invoices, top-ups, and checkout links.
---

# CloudEval Billing

## WHEN
- Use for credit balance, plan state, usage trends, ledger summaries, invoices, top-up packs, and buy links.

## DO NOT USE FOR
- Purchasing credits unless the user explicitly asks.
- Sharing full ledger data or customer billing identifiers.

## Required CloudEval Context
- Auth for user/account-specific billing.

## CLI Commands
- `cloudeval credits`
- `cloudeval billing summary`
- `cloudeval billing plans`
- `cloudeval billing usage --range 30d`
- `cloudeval billing ledger --limit 25`
- `cloudeval billing invoices`
- `cloudeval billing topups`
- `cloudeval billing topups buy <pack-id> --print-url`

## MCP Tools
- `billing_summary`
- `billing_usage`
- `billing_ledger`
- `billing_plans`
- `billing_topups`
- `open_url`

## Safety Requirements
- Buying top-ups creates an external checkout flow and must be explicit.
- Summarize ledger entries; do not paste complete ledgers.
- Redact identifiers and payment-related metadata.

## Expected Output / Proof
- Plan, credit status, usage trend, ledger anomaly summary.
- Checkout launcher URL only after explicit buy/top-up request.

## Failure Handling
- If billing auth fails, ask for `cloudeval login`.
- If checkout URL is unavailable, return the launcher URL and status.

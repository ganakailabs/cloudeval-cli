---
name: cloudeval-billing
description: Use when inspecting Cloudeval credits, plans, usage, ledger, invoices, notifications, top-ups, or checkout links.
---

# Cloudeval Billing

## WHEN
- Use for credit status, usage trends, ledger summaries, invoices, notifications, top-up readiness, and plan visibility.
- Use when a user asks to buy more credits or understand consumption.

## DO NOT USE FOR
- Sharing full ledger data, customer billing identifiers, or payment details.
- Creating checkout sessions unless the user explicitly chooses a top-up pack.

## Required Cloudeval Context
- Auth for account-specific billing, credits, ledger, invoices, notifications, and top-ups.
- Range for usage review: `7d`, `30d`, `90d`, or `all`.

## CLI Commands
- `cloudeval credits`
- `cloudeval billing summary`
- `cloudeval billing plans`
- `cloudeval billing usage --range 30d`
- `cloudeval billing ledger --range 30d --limit 25`
- `cloudeval billing invoices --limit 25`
- `cloudeval billing notifications --limit 25`
- `cloudeval billing topups`
- `cloudeval billing topups buy <pack-id> --print-url --no-open`

## MCP Tools
- `billing_summary`, `billing_usage`, `billing_ledger`
- `billing_plans`, `billing_topups`, `billing_invoices`, `billing_notifications`
- `billing_topup_checkout` for explicit checkout creation

## Operating Pattern
1. Start with summary to understand plan, remaining credits, and status.
2. Use usage and ledger for trends; summarize rather than copying events.
3. Use invoices and notifications only when billing operations are in scope.
4. Before checkout, show candidate packs and ask for explicit pack selection.

## Safety Requirements
- Redact ledger ids, customer identifiers, and account/session ids.
- Checkout creation is externally visible and must be explicit.
- Do not infer payment success from checkout session creation.

## Expected Output / Proof
- Plan and credit position.
- Usage trend and notable charge patterns.
- Top-up pack candidates or checkout URL if explicitly created.
- Billing frontend link.

## Failure Handling
- If billing auth fails, ask for `cloudeval login`.
- If no top-up packs are returned, report that checkout cannot proceed from CLI data.
- If checkout lacks a URL, return the session status and next link if present.

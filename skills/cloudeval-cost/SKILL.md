---
name: cloudeval-cost
description: Triage CloudEval cost reports, billing usage, savings opportunities, and anomalies.
---

# CloudEval Cost

## WHEN
- Use for `cost-review` recipes, cost report triage, savings summaries, and billing usage context.

## DO NOT USE FOR
- Creating charges, buying top-ups, or running reports without explicit approval.

## Required CloudEval Context
- Project id for report-backed cost review.
- Optional range for billing usage: `7d`, `30d`, `90d`, or `all`.

## CLI Commands
- `cloudeval recipes run cost-review --project <id>`
- `cloudeval reports cost --project <id>`
- `cloudeval billing usage --range 30d`

## MCP Tools
- `recipes_get`
- `recipes_run`
- `reports_list`
- `billing_usage`
- `ask`

## Safety Requirements
- Do not paste full billing ledger entries.
- Redact account/session/customer identifiers.
- Mark missing reports or missing billing data as missing evidence.

## Expected Output / Proof
- Top cost drivers.
- Estimated savings and confidence.
- Anomalies or trend changes.
- Ordered actions.

## Failure Handling
- If cost report is unavailable, recommend report generation but wait for approval.
- If usage data is unavailable, produce report-only triage and note the gap.

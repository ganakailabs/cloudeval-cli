---
name: cloudeval-cost
description: Use when triaging CloudEval cost reports, billing usage, savings opportunities, anomalies, or credit impact.
---

# CloudEval Cost

## WHEN
- Use for `cloudeval-cloud-cost-review`, cost report triage, savings summaries, anomaly review, and billing usage context.
- Use when the user asks why credits or cloud costs changed.

## DO NOT USE FOR
- Billing checkout or plan changes without the billing skill.
- Claims that are not backed by a cost report, billing usage, or explicit missing-evidence note.

## Required CloudEval Context
- Project id for cost reports.
- Optional billing range: `7d`, `30d`, `90d`, or `all`.
- Auth for reports and billing usage.

## CLI Commands
- `cloudeval recipes run cloudeval-cloud-cost-review --project <id> --range 30d`
- `cloudeval reports list --project <id> --kind cost`
- `cloudeval reports cost --project <id>`
- `cloudeval billing usage --range 30d`
- `cloudeval billing ledger --range 30d --limit 25`

## MCP Tools
- `reports_list`, `reports_cost`
- `billing_usage`, `billing_ledger`, `billing_summary`
- `recipes_get`, `recipes_run`, `ask`

## Operating Pattern
1. Confirm report freshness with `reports list`.
2. Use cost report details for cloud cost drivers and billing usage for CloudEval credit consumption.
3. Rank findings by impact, confidence, and actionability.
4. Separate confirmed evidence, inferred risk, and missing data.

## Safety Requirements
- Do not paste full billing ledger entries.
- Redact project/account/user identifiers.
- Mark missing reports or missing billing data as missing evidence.

## Expected Output / Proof
- Top cost drivers.
- Savings opportunities with rough priority.
- Anomalies or unusual usage.
- Next commands or report links.

## Failure Handling
- If cost reports are absent, recommend `cloudeval reports run --type cost` but do not run it automatically.
- If billing usage is unavailable, proceed from report evidence and state the limitation.

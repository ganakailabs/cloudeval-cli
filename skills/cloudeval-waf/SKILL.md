---
name: cloudeval-waf
description: Use when triaging Cloudeval Well-Architected findings, failed rules, pillar risk, or remediation plans.
---

# Cloudeval WAF

## WHEN
- Use for `cloudeval-well-architected-framework-review`, Well-Architected reports, rule failures, pillar summaries, and remediation planning.
- Use when the user asks what is risky about a Cloudeval project.

## DO NOT USE FOR
- Creating new assessment frameworks or unsupported rule engines.
- Regenerating WAF reports unless the user explicitly asks.

## Required Cloudeval Context
- Project id.
- Latest WAF report and rules if available.
- Optional severity filter.

## CLI Commands
- `cloudeval recipes run cloudeval-well-architected-framework-review --project <id>`
- `cloudeval reports list --project <id> --kind waf`
- `cloudeval reports waf --project <id>`
- `cloudeval reports rules --project <id>`
- `cloudeval reports run --project <id> --type waf`

## MCP Tools
- `reports_list`, `reports_waf`, `reports_rules`
- `recipes_get`, `recipes_run`, `ask`

## Operating Pattern
1. Establish report freshness and rule availability.
2. Group failed/warned rules by pillar and severity.
3. Rank remediation by blast radius, evidence strength, and dependency order.
4. Include a small verification plan for each major remediation.

## Safety Requirements
- Do not overclaim beyond report evidence.
- Do not expose raw topology or project identifiers unless requested.
- Treat `reports run --type waf` as explicit credit/backend work.

## Expected Output / Proof
- Pillar-by-pillar findings.
- Severity and confidence.
- Ordered remediation plan.
- Missing evidence notes.

## Failure Handling
- If no WAF report exists, recommend running one and stop.
- If rules are empty, summarize report-level evidence and say rules were unavailable.

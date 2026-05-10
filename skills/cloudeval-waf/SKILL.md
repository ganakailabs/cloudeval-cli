---
name: cloudeval-waf
description: Triage CloudEval Well-Architected findings and remediation plans.
---

# CloudEval WAF

## WHEN
- Use for WAF findings, architecture posture, pillar summaries, and remediation planning.

## DO NOT USE FOR
- Claiming compliance certification.
- Running WAF reports without explicit user approval.

## Required CloudEval Context
- Project id and latest WAF report/rules.

## CLI Commands
- `cloudeval recipes run waf-triage --project <id>`
- `cloudeval reports waf --project <id>`
- `cloudeval reports rules --project <id>`
- `cloudeval reports run --project <id> --type waf`

## MCP Tools
- `recipes_get`
- `recipes_run`
- `reports_list`
- `ask`

## Safety Requirements
- Separate confirmed report findings from assumptions.
- Prioritize by severity, pillar, and likely blast radius.
- Avoid exposing raw project/report JSON in public summaries.

## Expected Output / Proof
- Pillar summary.
- Critical/high/medium findings.
- Remediation order and owners/actions where inferable.

## Failure Handling
- If WAF report is missing or stale, say so and ask before regenerating.

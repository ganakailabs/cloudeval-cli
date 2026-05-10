---
name: cloudeval-reports
description: Use CloudEval cost and Well-Architected report commands and MCP tools.
---

# CloudEval Reports

## WHEN
- Use to list, show, run, download, or summarize cost and WAF reports.

## DO NOT USE FOR
- Inventing report data when reports are missing.
- Pasting full raw report JSON into public outputs.

## Required CloudEval Context
- Auth and a project id.
- Report generation may consume backend compute and credits.

## CLI Commands
- `cloudeval reports list --project <id>`
- `cloudeval reports show <report-id>`
- `cloudeval reports cost --project <id>`
- `cloudeval reports waf --project <id>`
- `cloudeval reports rules --project <id>`
- `cloudeval reports run --project <id> --type cost|waf|architecture|unit-tests|all`
- `cloudeval reports download --project <id> --type all --view raw|parsed|formatted`

## MCP Tools
- `reports_list`
- `reports_run`
- `reports_download`
- `open_url`

## Safety Requirements
- Running reports is explicit and may consume credits.
- Downloading reports can expose sensitive architecture/cost data.
- Prefer parsed/formatted summaries over raw JSON in agent replies.

## Expected Output / Proof
- Report kind, project, generated timestamp, and frontend report link.
- For downloads, include files written only when requested.

## Failure Handling
- If no reports exist, ask before running `reports run`.
- If a report is partial, state partial status and missing evidence.

---
name: cloudeval-reports
description: Use when listing, showing, generating, downloading, or summarizing Cloudeval cost and Well-Architected reports.
---

# Cloudeval Reports

## WHEN
- Use for `reports list/show/cost/waf/rules/run/download`, report summaries, architecture reviews, and report export packs.
- Use when a user asks what Cloudeval found for a project.

## DO NOT USE FOR
- Running report jobs without explicit user approval.
- Publishing raw report JSON, customer topology, or billing evidence into public artifacts.

## Required Cloudeval Context
- Auth and a project id.
- Existing reports for read-only analysis; report generation only when requested.
- Optional output path for downloads.

## CLI Commands
- `cloudeval reports list --project <id> --kind all|cost|waf`
- `cloudeval reports show <report-id> --project <id>`
- `cloudeval reports cost --project <id>`
- `cloudeval reports waf --project <id>`
- `cloudeval reports rules --project <id>`
- `cloudeval reports run --project <id> --type cost|waf|architecture|unit-tests|all --wait`
- `cloudeval reports download --project <id> --type all --view raw|parsed|formatted --output <path>`

## MCP Tools
- Read-only: `reports_list`, `reports_show`, `reports_cost`, `reports_waf`, `reports_rules`.
- Explicit actions: `reports_run`, `reports_download`.
- Supporting tools: `projects_get`, `open_url`, `ask`, `recipes_get`, `recipes_run`.

## Operating Pattern
1. Start with `reports_list` to establish what exists and freshness.
2. Use `reports_cost`, `reports_waf`, or `reports_rules` for focused evidence.
3. Use `reports_run` only after naming project id, report type, expected credit/compute impact, and wait behavior.
4. Use `reports_download` only with an explicit output path; prefer formatted or parsed views for sharing.

## Safety Requirements
- Report generation consumes backend resources and can consume credits.
- Downloads write local files and may contain sensitive topology, cost, or rule evidence.
- Keep summaries evidence-backed and avoid raw payload dumps.

## Expected Output / Proof
- Report id/type/project/generated time or generated job ids.
- Frontend report URL.
- Files written for downloads.
- Missing or stale evidence called out separately.

## Failure Handling
- If no report exists, recommend `cloudeval reports run` but do not run it automatically.
- If report detail is unavailable, fall back to report list and state the limitation.
- If writing a file fails, report the path and do not imply export succeeded.

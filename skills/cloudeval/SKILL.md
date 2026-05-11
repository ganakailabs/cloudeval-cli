---
name: cloudeval
description: Use when routing CloudEval CLI or MCP work across projects, reports, billing, credentials, connections, diagnostics, recipes, and agent workflows.
---

# CloudEval Skill Router

## WHEN
- Use when a user asks to inspect, operate, troubleshoot, or automate CloudEval from a terminal, Codex, Cursor, Claude, VS Code, or another MCP client.
- Start here when intent spans multiple CloudEval domains or when the correct command is unclear.
- Prefer MCP tools when available; use CLI commands when the user needs exact terminal steps or install-time behavior.

## DO NOT USE FOR
- Unsupported cloud scanners, unsupported repository integrations, generic infrastructure review, or private backend internals.
- Reading local secrets, session databases, `.env*`, `.cloudeval-downloads/`, smoke artifacts, or raw report JSON unless explicitly requested.

## Required CloudEval Context
- Discovery: `cloudeval capabilities --format json`, `cloudeval recipes list`, `cloudeval help agents`.
- Auth: `cloudeval login` for user workflows or a scoped `CLOUDEVAL_ACCESS_KEY` for automation.
- Project scope: run `cloudeval projects list` when no project id is provided for project/report work.

## CLI Commands
- `cloudeval recipes list|show|run`
- `cloudeval ask`, `cloudeval agent`, `cloudeval chat`, `cloudeval sessions`
- `cloudeval projects`, `cloudeval reports`, `cloudeval billing`, `cloudeval credentials`, `cloudeval connections`
- `cloudeval mcp status|setup|serve`, `cloudeval status`, `cloudeval doctor`, `cloudeval config`, `cloudeval models`

## MCP Tools
- Discovery: `capabilities_get`, `recipes_list`, `recipes_get`.
- Read-only evidence: `projects_list`, `projects_get`, `reports_list`, `reports_cost`, `reports_waf`, `billing_summary`, `billing_usage`, `connections_list`, `models_list`, `sessions_list`, `status`, `doctor`.
- Explicit actions: `ask`, `recipes_run`, `reports_run`, `reports_download`, `projects_export_diagram`, `credentials_create`, `credentials_revoke`, `billing_topup_checkout`, `open_url`.

## Operating Pattern
1. Classify the request as read-only, token-consuming, local-file-writing, browser-opening, or externally visible.
2. Collect the narrowest evidence set first: capabilities, project, report, billing, connection, credential, config, or session data.
3. Use a recipe when the workflow matches a catalog entry; otherwise use the smallest direct command/tool.
4. Return proof: command/tool used, scope, result summary, files written, frontend URL, and any missing evidence.

## Safety Requirements
- Redact account, session, tenant, customer, credential, billing, and report identifiers by default.
- Treat report generation, project creation, credential creation/revoke, billing checkout, browser opening, and local file writes as explicit actions.
- Keep machine-readable data on stdout; progress, warnings, auth prompts, and browser-open messages belong on stderr.

## Expected Output / Proof
- State the command or MCP tool used.
- Include the project/report/billing scope in summary form.
- Include returned frontend links and file paths when available.
- Separate confirmed findings from assumptions or missing data.

## Failure Handling
- If auth fails, ask the user to run `cloudeval login` or provide a scoped access key.
- If a project is missing, run `cloudeval projects list` or ask for `--project`.
- If a command requires human approval in non-interactive mode, report the approval request and do not fake success.

---
name: cloudeval
description: Route CloudEval CLI and MCP work across projects, reports, billing, credentials, connections, diagnostics, and agent workflows.
---

# CloudEval Skill Router

## WHEN
- Use when a user asks to inspect or operate CloudEval from a terminal, script, Codex, Cursor, Claude, or another MCP client.
- Prefer MCP tools when the agent host has `cloudeval mcp serve`; otherwise use explicit CLI commands.

## DO NOT USE FOR
- Generic IaC scanning, unsupported repository integrations, unsupported cloud scanners, or backend internals.
- Reading local secrets, session databases, `.env*`, `.cloudeval-downloads/`, smoke artifacts, or raw report JSON unless explicitly requested.

## Required CloudEval Context
- Auth: `cloudeval login` or `CLOUDEVAL_ACCESS_KEY`.
- Discovery: `cloudeval capabilities --format json`, `cloudeval recipes list`, `cloudeval help agents`.
- Project context: `cloudeval projects list` before project-scoped work when no project is provided.

## CLI Commands
- `cloudeval recipes list|show|run`
- `cloudeval ask`, `cloudeval agent`, `cloudeval chat`
- `cloudeval projects`, `cloudeval reports`, `cloudeval billing`, `cloudeval credentials`
- `cloudeval mcp status|setup|serve`, `cloudeval status`, `cloudeval doctor`

## MCP Tools
- Start with `capabilities_get`.
- Use specific tools such as `projects_list`, `reports_list`, `billing_summary`, `recipes_list`, and `recipes_get`.
- Use `recipes_run` only when token-consuming recipe execution is intended.

## Safety Requirements
- Redact account, session, tenant, customer, billing, and credential identifiers by default.
- Treat report generation, project creation, credential creation/revoke, billing checkout, browser opening, and local file writes as explicit actions.
- Keep stdout machine-readable; progress, warnings, and auth prompts belong on stderr.

## Expected Output / Proof
- State the command or MCP tool used.
- Include project/report/billing scope in summary form.
- Include frontend links when returned by CloudEval.

## Failure Handling
- If auth fails, ask the user to run `cloudeval login` or provide an access key.
- If a project is missing, run `cloudeval projects list` or ask for `--project`.
- If a command needs human approval in non-interactive mode, report `HITL_REQUIRED`.

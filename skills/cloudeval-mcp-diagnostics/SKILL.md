---
name: cloudeval-mcp-diagnostics
description: Use when setting up or diagnosing CloudEval MCP, config, auth, doctor, status, update, completion, banner, and deeplinks.
---

# CloudEval MCP Diagnostics

## WHEN
- Use for MCP setup in Codex, Cursor, Claude, VS Code, or generic clients.
- Use for install/update checks, auth status, config profiles, command capabilities, shell completion, and CLI health.

## DO NOT USE FOR
- Running project reports, creating credentials, or checkout sessions unless explicitly routed to another skill.
- Editing client config files without showing a dry run first.

## Required CloudEval Context
- No auth required for local diagnostics.
- Auth required for private MCP tools after setup.
- Client name and desired toolset for MCP setup.

## CLI Commands
- `cloudeval mcp status --format json`
- `cloudeval mcp setup codex|claude|cursor|vscode|generic --dry-run --toolset readonly|reports|billing|projects|all`
- `cloudeval mcp setup <client> --toolset readonly`
- `cloudeval mcp serve --toolset readonly`
- `cloudeval status`, `cloudeval doctor --mcp`, `cloudeval auth status`
- `cloudeval capabilities --format json`, `cloudeval help agents`
- `cloudeval completion install --shell zsh`, `cloudeval update --check`

## MCP Tools
- `capabilities_get`
- `auth_status`, `status`, `doctor`
- `config_show`, `config_get`, `config_profiles`
- `models_list`
- `recipes_list`, `recipes_get`

## Operating Pattern
1. Run `mcp status` or `capabilities_get` to identify available toolsets.
2. Use `--dry-run` before writing client config.
3. Prefer `readonly` toolset for default agent setup; broaden only for a specific workflow.
4. Validate with `doctor --mcp` and a client-side tools/list when possible.

## Safety Requirements
- Redact account/session ids unless `--show-sensitive-ids` or verbose output is explicitly requested.
- Client config writes are explicit; dry run first.
- Do not include access keys in client config unless the user intentionally chooses that automation path.

## Expected Output / Proof
- MCP server command, config path, toolset, and client name.
- Doctor/status checks with pass/warn/fail.
- Next command for login, setup, or troubleshooting.

## Failure Handling
- If the client command is unavailable, return manual config instructions.
- If MCP starts but tools are missing, compare requested toolset with `mcp status`.
- If auth is unavailable in MCP, run `cloudeval login` outside the MCP stdio session.

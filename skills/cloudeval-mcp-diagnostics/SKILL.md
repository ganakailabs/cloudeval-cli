---
name: cloudeval-mcp-diagnostics
description: Set up and diagnose CloudEval MCP, config, auth, doctor, status, update, completion, banner, and deeplinks.
---

# CloudEval MCP Diagnostics

## WHEN
- Use for MCP setup/status, agent integration, local config, auth status, diagnostics, update checks, completion, banner, and frontend links.

## DO NOT USE FOR
- Editing MCP client config without user intent.
- Opening browsers in automation unless explicitly requested.

## Required CloudEval Context
- No auth needed for local status/help/setup dry runs.
- Auth required for live backend capability and protected MCP tools.

## CLI Commands
- `cloudeval mcp status --format json`
- `cloudeval mcp setup codex|claude|cursor|vscode|generic --dry-run --toolset readonly|reports|billing|projects|all`
- `cloudeval mcp serve --toolset readonly`
- `cloudeval auth status`
- `cloudeval status --format json`
- `cloudeval doctor --deep --mcp --format json`
- `cloudeval config show|get|set|unset|path|profiles`
- `cloudeval setup --non-interactive`
- `cloudeval update --check`
- `cloudeval completion install --shell <shell>`
- `cloudeval open <target> --print-url --no-open`

## MCP Tools
- `capabilities_get`
- `auth_status`
- `status`
- `doctor`
- `open_url`
- `recipes_list`

## Safety Requirements
- `mcp serve` stdout is reserved for JSON-RPC; diagnostics go to stderr.
- Browser opening and config writes must be explicit.
- Do not expose local config secrets or auth storage contents.

## Expected Output / Proof
- Tool/resource/prompt counts.
- Selected MCP toolset and setup instructions.
- Clear status/doctor checks.

## Failure Handling
- If an MCP client cannot find the binary, use an absolute command path in setup.
- If auth is missing, run `cloudeval login` or use `CLOUDEVAL_ACCESS_KEY`.

---
name: cloudeval-connections
description: Inspect and open CloudEval cloud/template connections.
---

# CloudEval Connections

## WHEN
- Use to list, inspect, or open CloudEval connections.

## DO NOT USE FOR
- Creating provider connections unless a CloudEval command exists and the user explicitly asks.
- Exposing provider credentials or connection secrets.

## Required CloudEval Context
- Authenticated user.

## CLI Commands
- `cloudeval connections list`
- `cloudeval connections get <id>`
- `cloudeval connections open <id>`

## MCP Tools
- `connections_list`
- `connections_get`
- `open_url`

## Safety Requirements
- Redact customer/account metadata.
- Treat connection details as potentially sensitive infrastructure context.

## Expected Output / Proof
- Connection id/name/provider/type/sync status.
- Frontend connection link when available.

## Failure Handling
- If a connection id is missing, list connections first.
- If a connection is not found, ask for a valid id.

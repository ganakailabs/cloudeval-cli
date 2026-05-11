---
name: cloudeval-connections
description: Use when inspecting CloudEval cloud/template connections, connection health, or connection frontend links.
---

# CloudEval Connections

## WHEN
- Use for `connections list|get|open`, connection audits, and project-to-connection context.
- Use when a project appears stale or missing source context.

## DO NOT USE FOR
- Creating provider credentials or modifying cloud accounts.
- Showing embedded secrets or raw provider payloads.

## Required CloudEval Context
- Auth and optional connection id.
- Project id if the connection is being checked as part of a project healthcheck.

## CLI Commands
- `cloudeval connections list`
- `cloudeval connections get <id>`
- `cloudeval open connections --print-url --no-open`
- `cloudeval open connection <id> --print-url --no-open`

## MCP Tools
- `connections_list`
- `connections_get`
- `open_url`
- `projects_get` when correlating to a project

## Operating Pattern
1. List connections before fetching a specific connection unless the id is known.
2. Summarize provider, source, status, and project association.
3. Return a frontend link for investigation.
4. If connection data contains provider details, summarize and redact.

## Safety Requirements
- Do not expose connection secrets, tenant/account ids, or full raw payloads by default.
- Browser opening is explicit; print links for agents.

## Expected Output / Proof
- Connection id/name/provider/source/status.
- Frontend connection URL.
- Any missing association or stale-sync clue.

## Failure Handling
- If connection id is missing, run `connections list`.
- If a connection cannot be fetched, report the id and suggest the connections page.

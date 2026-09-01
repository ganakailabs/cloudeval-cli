---
name: cloudeval-projects
description: Use when listing, inspecting, creating, opening, or health-checking Cloudeval projects and template project workflows.
---

# Cloudeval Projects

## WHEN
- Use for project inventory, project healthchecks, template-file or template-URL project creation, and frontend project links.
- Use before report, WAF, cost, or diagram work when a project id is missing.

## DO NOT USE FOR
- Unsupported project sources or cloud analysis outside Cloudeval project APIs.
- Dumping raw project payloads containing customer or provider identifiers into public docs.

## Required Cloudeval Context
- Auth is required for private project list/get/create.
- Template project creation requires `--template-file` or `--template-url`; parameters are optional.
- Provider must be one already accepted by `cloudeval projects create`.

## CLI Commands
- `cloudeval projects list`
- `cloudeval projects get <id>`
- `cloudeval projects create --template-file <path> --name <name>`
- `cloudeval projects create --template-url <url> --parameters-file <path> --provider azure --name <name>`
- `cloudeval open projects --print-url --no-open`
- `cloudeval open project <id> --view both --layout architecture|dependency --print-url --no-open`

## MCP Tools
- `projects_list`, `projects_get`
- `connections_list`, `connections_get`
- `open_url`
- `projects_export_diagram` when visualization output is explicitly requested

## Operating Pattern
1. List projects if no project id is available; choose only with user confirmation unless a default profile project exists.
2. For create workflows, render the exact command first and explain what it will create.
3. After create, use `reports run` only if the user asks to generate reports.
4. Provide frontend links with `--print-url --no-open` for agents and scripts.

## Safety Requirements
- Project creation is explicit mutation.
- Browser opening is explicit; prefer printing links in automation.
- Do not expose raw template parameters or provider identifiers unless requested.

## Expected Output / Proof
- Project id/name/provider/source/status.
- Creation command or created project summary.
- Frontend URL for projects or selected project.
- Missing project/report/sync evidence if unavailable.

## Failure Handling
- If auth fails, run `cloudeval login`.
- If template creation lacks a template file or URL, stop and request one.
- If project id is unknown, list projects instead of guessing.

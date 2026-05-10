---
name: cloudeval-projects
description: Work with CloudEval projects, template project creation, project links, and diagram exports.
---

# CloudEval Projects

## WHEN
- Use to list, inspect, open, create template projects, or export project diagrams.

## DO NOT USE FOR
- Generic IaC scanning outside CloudEval template project support.
- Creating projects without an explicit user request.

## Required CloudEval Context
- Auth for project list/get/create.
- Template project creation accepts existing CloudEval inputs: local JSON template file, template URL, parameters file, parameters URL, provider, name, and description.

## CLI Commands
- `cloudeval projects list`
- `cloudeval projects get <id>`
- `cloudeval projects open <id>`
- `cloudeval projects create --template-file <path>|--template-url <url>`
- `cloudeval projects export-diagram <id> --layout architecture|dependency --format png|jpeg|svg --labels all|viewport --output <file>`

## MCP Tools
- `projects_list`
- `projects_get`
- `projects_export_diagram`
- `open_url`

## Safety Requirements
- Project creation is explicit mutation.
- Diagram export writes local files only when an output path is provided.
- Redact project/customer metadata in public summaries.

## Expected Output / Proof
- Project id/name/provider/source/status summary.
- Frontend project link when available.
- Diagram output path and byte count for exports.

## Failure Handling
- If project id is missing, list projects first.
- If diagram export fails, report the HTTP status/content-type and avoid writing partial misleading outputs.

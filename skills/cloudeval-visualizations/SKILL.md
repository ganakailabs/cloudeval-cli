---
name: cloudeval-visualizations
description: Use when exporting Cloudeval architecture or dependency diagrams and preparing visual evidence for reviews.
---

# Cloudeval Visualizations

## WHEN
- Use for architecture diagram export, dependency diagram export, graph image downloads, and frontend visualization links.
- Use when the user needs visual proof of architecture or relationship state from an existing Cloudeval project.

## DO NOT USE FOR
- Generating synthetic diagrams unrelated to Cloudeval project graph data.
- Publishing diagrams externally before labels, resources, and topology have been reviewed.

## Required Cloudeval Context
- Project id.
- Explicit output path for local image export.
- Layout choice: `architecture` for architecture view, `dependency` for relationship view.

## CLI Commands
- `cloudeval recipes show cloudeval-architecture-diagram-export`
- `cloudeval recipes show cloudeval-dependency-diagram-export`
- `cloudeval projects export-diagram <id> --layout architecture --format png --labels all --output <file>`
- `cloudeval projects export-diagram <id> --layout dependency --format svg --labels all --output <file>`
- `cloudeval open project <id> --view both --layout architecture|dependency --print-url --no-open`

## MCP Tools
- `projects_export_diagram`
- `open_url`
- `recipes_get`

## Operating Pattern
1. Confirm project id and intended layout.
2. Ask for or derive an explicit output path; never write to an implicit repo artifact path.
3. Export with `labels=all` for review quality unless the user wants viewport labels.
4. Return file path, format, label mode, byte count when available, and frontend link.

## Safety Requirements
- Diagram exports write local files and may expose topology or resource names.
- Use public graph mode only for intentionally public/share graphs.
- Do not embed generated images in public docs until the user approves the content.

## Expected Output / Proof
- Exact export command or MCP tool call.
- Output file path and format.
- Architecture or dependency frontend URL.
- Any auth/public graph mode returned by the backend.

## Failure Handling
- If export fails, report status/content type and avoid claiming a file was produced.
- If output path is missing, stop and request one.
- If graph labels are sensitive, recommend re-exporting with a safer label mode or reviewing the image before sharing.

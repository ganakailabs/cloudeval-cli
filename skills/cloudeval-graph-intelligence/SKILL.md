---
name: cloudeval-graph-intelligence
description: Use when inspecting Cloudeval project graphs, graph drift, sync history, dependency impact, critical paths, and graph-derived risk signals.
---

# Cloudeval Graph Intelligence

## WHEN
- Use for graph drift, dependency impact, critical path, sync-run, and graph snapshot reviews.
- Use when a user asks what changed in a project graph or what resources may be affected by a selected resource.
- Use for `cloudeval-graph-drift-watch` and `cloudeval-impact-analysis` recipes.

## DO NOT USE FOR
- Generic graph analysis outside Cloudeval project graph APIs.
- Creating synthetic topology, changing infrastructure, or claiming drift without graph evidence.
- Publishing raw topology, resource identifiers, or customer graph data into public artifacts.

## Required Cloudeval Context
- Authenticated Cloudeval session or scoped access key.
- Cloudeval project id.
- Optional resource id for impact-focused analysis.
- Optional sync version range for graph diff work.

## CLI Commands
- `cloudeval projects graph <project-id> --format json`
- `cloudeval projects graph sync-runs <project-id> --format json`
- `cloudeval projects graph timeline <project-id> --format json`
- `cloudeval projects graph diff <project-id> --from <sync-version> --to <sync-version> --format json`
- `cloudeval projects graph insights <project-id> --focus overview --format json`
- `cloudeval projects graph insights <project-id> --focus impact --resource <resource-id> --format json`
- `cloudeval projects graph insights <project-id> --focus critical-paths --format json`
- `cloudeval open project <project-id> --view both --layout dependency --print-url --no-open`

## MCP Tools
- `projects_graph_get`
- `projects_graph_sync_runs`
- `projects_graph_timeline`
- `projects_graph_diff`
- `projects_graph_insights`
- `projects_get`
- `open_url`
- `recipes_get`, `recipes_run`

## Operating Pattern
1. Confirm the project id and whether the user wants drift, impact, critical path, or overview analysis.
2. Inspect graph metadata and recent sync runs before claiming a change.
3. Use timeline or diff only when retained sync versions exist.
4. For resource-specific impact, first resolve or confirm the resource id.
5. Separate confirmed graph evidence from missing baseline, missing resource id, or stale sync data.

## Safety Requirements
- Treat topology, resource names, resource ids, and graph edges as sensitive by default.
- Redact account, tenant, project, and session identifiers in shared summaries.
- Do not export or publish diagrams from graph data unless the user explicitly requests that workflow.
- Do not infer production blast radius without stating the graph evidence used.

## Expected Output / Proof
- Project and graph scope in summary form.
- Sync version or timeline evidence when drift is discussed.
- Changed resources, impacted paths, or critical paths with confidence.
- Frontend dependency-view link when useful.
- Missing baseline or stale-data notes when graph evidence is incomplete.

## Failure Handling
- If no project id is provided, run `cloudeval projects list` or ask for a project id.
- If no retained baseline exists, say that graph diff cannot be computed yet and suggest a fresh sync.
- If a resource id is missing or ambiguous, inspect graph resources before running impact analysis.
- If graph APIs are unavailable, fall back to `projects get`, `reports list`, and a frontend project link.

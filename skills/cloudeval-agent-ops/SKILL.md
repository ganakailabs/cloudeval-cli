---
name: cloudeval-agent-ops
description: Use when running CloudEval ask, agent, chat/TUI, model selection, recipes, or local session recovery from CLI or MCP.
---

# CloudEval Agent Ops

## WHEN
- Use for one-shot `ask`, non-interactive `agent`, interactive `chat`/TUI, model defaults, recipe execution, and session recovery.
- Use when another coding agent needs a pipeable CloudEval command with predictable stdout/stderr behavior.

## DO NOT USE FOR
- Project creation, report generation, credential lifecycle, billing checkout, or diagram exports unless a recipe explicitly routes there.
- Quoting full local transcripts unless the user explicitly asks for that exact session.

## Required CloudEval Context
- Auth for `ask`, `agent`, model-backed recipes, and project-aware responses.
- Project id for project-scoped questions.
- Model from `cloudeval models list` or configured default from `cloudeval models default get`.

## CLI Commands
- `cloudeval ask "question" --project <id> --format text|json|ndjson|markdown`
- `cloudeval agent "task" --project <id> --progress`
- `cloudeval chat --mode ask|agent`
- `cloudeval models list`, `cloudeval models default get|set`
- `cloudeval sessions list|get|search|export`, `cloudeval chat --resume <thread-id>`
- `cloudeval recipes run <id> --project <id>`

## MCP Tools
- `ask` with `mode=ask|agent`
- `recipes_list`, `recipes_get`, `recipes_run`
- `models_list`, `models_default_get`, `models_default_set`
- `sessions_list`, `sessions_get`, `sessions_search`, `sessions_export`

## Operating Pattern
1. For agent integrations, prefer `--format json` or `--format ndjson`; for humans, default text is fine.
2. Use `ask` for bounded questions and `agent` only when tool use, planning, or HITL may be needed.
3. If a request might mutate CloudEval state, switch to the relevant domain skill before running it.
4. Store or resume useful threads with `sessions`; summarize rather than dumping transcripts.

## Safety Requirements
- Questions and final answers go to stdout; progress, loaders, warnings, and auth flow text go to stderr.
- Agent mode can consume credits and can ask for HITL; never treat a HITL request as completed work.
- Redact project/account/session identifiers in shared summaries.

## Expected Output / Proof
- Final answer text or JSON envelope with `response`, `threadId`, `project`, and `frontendUrl`.
- Model used when relevant.
- Session id or resume command if the user wants to continue.

## Failure Handling
- If no final response is returned, retry with `--verbose` or `--format ndjson` and report the last stream status.
- If model validation fails, list available models and ask the user to choose one.
- If auth is missing, run `cloudeval login` before retrying private project work.

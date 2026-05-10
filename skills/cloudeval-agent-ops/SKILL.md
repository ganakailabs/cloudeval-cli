---
name: cloudeval-agent-ops
description: Use CloudEval ask, agent, chat, model, and session capabilities safely from CLI or MCP.
---

# CloudEval Agent Ops

## WHEN
- Use for one-shot questions, deeper agent tasks, interactive TUI/chat, model selection, or local session history.

## DO NOT USE FOR
- Mutating cloud resources outside CloudEval.
- Bypassing HITL approval or hiding progress/output stream behavior.

## Required CloudEval Context
- Authenticated CLI or access key.
- Optional project id for grounded project answers.

## CLI Commands
- `cloudeval ask "question" --project <id> --format json`
- `cloudeval agent "task" --project <id> --format json`
- `cloudeval chat --mode ask|agent`
- `cloudeval models list`
- `cloudeval sessions list|get|search|rename|export|delete|prune`

## MCP Tools
- `ask`
- `models_list`
- `recipes_run` for predefined ask/agent recipes.

## Safety Requirements
- Use `--non-interactive` for automation.
- Use `--progress none` or `--format ndjson --progress ndjson` when stdout must be strictly parseable.
- Do not paste raw session databases or full session/account identifiers.

## Expected Output / Proof
- Final answer on stdout.
- JSON envelopes with `ok`, `command`, `data`, and optional `frontendUrl`.
- Session id redacted unless the user explicitly asks for sensitive ids.

## Failure Handling
- If no final answer is returned, retry with `--format ndjson` or `--verbose` to inspect progress.
- If HITL is required in automation, surface exit code `6` and the approval question.

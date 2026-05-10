---
name: cloudeval-credentials
description: Manage CloudEval scoped access-key credentials with redaction and explicit mutation.
---

# CloudEval Credentials

## WHEN
- Use to inspect templates, create scoped access keys, list credentials, inspect one credential, or revoke a credential.

## DO NOT USE FOR
- Printing full access keys except immediately after an explicit create command.
- Creating broad credentials when a scoped template is available.

## Required CloudEval Context
- Authenticated user with credential management capability.
- Project id when the credential template or workflow requires project scope.

## CLI Commands
- `cloudeval credentials templates`
- `cloudeval credentials create --template <id> --name <name> --project <id>`
- `cloudeval credentials list --project <id>`
- `cloudeval credentials inspect <credential-id>`
- `cloudeval credentials revoke <credential-id> --reason <reason>`

## MCP Tools
- No credential MCP tools are exposed in this version.
- Use CLI commands intentionally for credential mutations.

## Safety Requirements
- Credential create/revoke is explicit mutation.
- Never paste full tokens or access keys outside the create result.
- Prefer `--access-key-stdin` for automation.

## Expected Output / Proof
- Template or credential id/name/status/capability summary.
- One-time access key only from `credentials create`.

## Failure Handling
- If capability is missing, report the backend error and required capability.
- If revoking, require a clear reason.

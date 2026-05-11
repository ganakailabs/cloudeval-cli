---
name: cloudeval-credentials
description: Use when managing CloudEval scoped access-key templates, creation, inspection, rotation, or revocation.
---

# CloudEval Credentials

## WHEN
- Use for access-key templates, automation key setup, credential inventory, inspection, rotation, and revocation.
- Use when configuring agents or CI with scoped CloudEval access.

## DO NOT USE FOR
- User browser login, session tokens, or storing secrets in repository files.
- Printing one-time secrets unless the user explicitly requests them in the current secure context.

## Required CloudEval Context
- Auth as a user with credential permissions.
- Project id for scoped key creation.
- Template id from `cloudeval credentials templates`.

## CLI Commands
- `cloudeval credentials templates`
- `cloudeval credentials list --project <id>`
- `cloudeval credentials inspect <credential-id>`
- `cloudeval credentials create --template <id> --name <name> --project <id> --expires 90d`
- `cloudeval credentials revoke <credential-id> --reason rotated`

## MCP Tools
- Read-only: `credentials_templates`, `credentials_list`, `credentials_inspect`.
- Explicit: `credentials_create`, `credentials_revoke`.

## Operating Pattern
1. List templates before recommending a create command.
2. Scope credentials to the smallest project and shortest practical expiry.
3. For rotation, create and verify the replacement before revoking the old credential.
4. Return redacted summaries by default.

## Safety Requirements
- Never paste full access keys, tokens, key prefixes with enough context to identify a customer, or credential secrets.
- Creation and revocation are explicit mutations.
- If creating via MCP, secrets are redacted by default unless `showSecret=true`.

## Expected Output / Proof
- Template id/name.
- Credential id/name/status redacted as needed.
- Exact create/revoke command.
- Confirmation that no secret was persisted to repo-local files.

## Failure Handling
- If project id is missing, run `cloudeval projects list` or ask for one.
- If create succeeds but the secret is redacted, tell the user how to rerun securely if they need the one-time key.
- If revocation is requested, confirm replacement access first.

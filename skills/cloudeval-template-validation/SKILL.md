---
name: cloudeval-template-validation
description: Use when validating, parsing, testing, or release-gating Cloudeval-supported cloud template files with existing validation and rule commands.
---

# Cloudeval Template Validation

## WHEN
- Use for local template parse, validation, test-suite, rule lookup, and release-gate workflows.
- Use before creating a Cloudeval template project from local template files.
- Use for `cloudeval-template-preflight` and `cloudeval-template-release-gate` recipes.

## DO NOT USE FOR
- Unsupported IaC formats or cloud scanners that Cloudeval does not currently expose.
- Creating projects, running cost or WAF reports, or modifying cloud accounts.
- Pasting full private templates, parameters, secrets, or generated report payloads into public artifacts.

## Required Cloudeval Context
- Authenticated Cloudeval session or scoped access key.
- Local template JSON file path.
- Optional local parameters JSON file path.
- Validation policy choices such as severity threshold or failed-only output.

## CLI Commands
- `cloudeval validate parse --template-file <template.json> --parameters-file <parameters.json> --format json`
- `cloudeval validate template --template-file <template.json> --parameters-file <parameters.json> --details --format json`
- `cloudeval validate template --template-file <template.json> --parameters-file <parameters.json> --min-severity Warning --failed-only --format json`
- `cloudeval validate tests --template-file <template.json> --parameters-file <parameters.json> --wait --format json`
- `cloudeval rules categories --format json`
- `cloudeval rules search "public network" --format json`
- `cloudeval rules show <rule-id> --format json`

## MCP Tools
- `template_parse`
- `template_validate`
- `template_test`
- `rules_categories`
- `rules_search`
- `rules_get`
- `recipes_get`, `recipes_run`

## Operating Pattern
1. Confirm the template file path exists and whether parameters are required.
2. Parse first to establish resource inventory and catch syntax or parameter issues.
3. Run validation with details for human review, or failed-only/min-severity for automation gates.
4. Use rule search/show only to explain failed checks or likely remediation paths.
5. Keep gate output deterministic: pass/fail, failed checks, severity, and next commands.

## Safety Requirements
- Treat template contents and parameter values as sensitive unless the user explicitly says they are public.
- Do not print secrets, secure string parameter values, tenant ids, subscription ids, or raw private templates.
- Validation and test commands may consume credits or backend resources; avoid hidden retries.
- Do not describe unsupported repository, deployment-gate, or generic scanner workflows as available.

## Expected Output / Proof
- Parsed resource count and high-level resource types.
- Validation pass/fail status with failed check count and severity.
- Test-suite status and rule ids needed for remediation.
- Exact command used and any local file path involved.
- Clear distinction between failed checks, warnings, and missing evidence.

## Failure Handling
- If the template file is missing, stop and ask for a valid local path.
- If parameters are missing, report the unresolved parameter names and suggest a parameters file.
- If validation is unavailable, return the backend error and do not claim the gate passed.
- If a rule id cannot be fetched, keep the failed rule summary and note that rule details were unavailable.

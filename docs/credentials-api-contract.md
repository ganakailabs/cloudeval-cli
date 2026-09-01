# Cloudeval Credentials API Contract

This contract backs the CLI `credentials` commands and the frontend
**Settings -> Developer -> Auth Keys** page. The public product label is
**Auth Keys**. The backend and CLI resource name is `credentials`. The v1
credential type is `access_key`.

## Canonical Endpoints

The CLI calls these routes under its configured API base URL:

- `GET /v1/credential-templates`
- `POST /v1/credentials`
- `GET /v1/credentials`
- `GET /v1/credentials/{credential_id}`
- `POST /v1/credentials/{credential_id}/revoke`
- `GET /v1/identity`
- `GET /v1/capabilities`

## Key Format And Storage

Access keys are generated once, returned once, and then discarded.

```text
cev_<environment>_ak_<public_key_id>_<secret>
```

Example:

```text
cev_live_ak_01JABCDEF1234567890_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Do not store raw access keys in Azure Key Vault or the application database.
Use the application database for credential metadata, scopes, constraints,
usage counters, and audit events. Use Azure Key Vault for cryptographic
material only:

- `credential-hmac-pepper-v1`
- future HMAC pepper versions
- future envelope-encryption keys for sensitive metadata

Verification flow:

1. Parse `public_key_id` from the raw access key.
2. Load the credential row by `public_key_id`.
3. Load the Key Vault pepper referenced by `hash_key_version`.
4. Compute HMAC-SHA256 over the full raw access key.
5. Timing-safe compare with `credentials.secret_hash`.
6. Reject expired, revoked, disabled, out-of-scope, over-budget, or
   under-permissioned credentials.

If compliance asks for "Key Vault per key", store only non-retrievable
verification or envelope-encryption material there. Do not make raw access keys
recoverable.

## Data Model

`service_accounts`:

- `id`, `org_id`, `project_id`, `name`, `description`, `status`
- `created_by_user_id`, `created_at`, `disabled_at`

`credentials`:

- `id`, `org_id`, `type = access_key`, `environment`, `name`, `description`
- `status`, `public_key_id`, `key_prefix` (a server-side `key_suffix` may exist in storage but is **not** returned by APIs)
- `secret_hash`, `hash_alg`, `hash_key_version`
- `subject_type = service_account`, `subject_id`
- `created_by_user_id`, `expires_at`, `revoked_at`, `revoked_by_user_id`
- `revoke_reason`, `last_used_at`, `last_used_ip`
- `last_used_user_agent`, `last_used_endpoint`

`credential_capabilities`:

- `credential_id`, `capability`

`credential_project_scopes`:

- `credential_id`, `project_id`

`credential_constraints`:

- `credential_id`, `max_credits_per_day`, `max_jobs_per_day`
- `ip_allowlist`, `requires_approval_for`, `created_at`

`credential_usage_daily`:

- `credential_id`, `date`, `credits_used`, `jobs_started`

`credential_audit_events`:

- `id`, `org_id`, `credential_id`, `actor_type`, `actor_id`
- `event_type`, `request_id`, `ip`, `user_agent`, `endpoint`
- `metadata`, `created_at`

`rbac_roles`, `rbac_permissions`, `rbac_role_bindings`:

- Seed roles: `owner`, `admin`, `developer`, `viewer`,
  `automation_manager`, `report_runner`, `readonly_agent`
- Role bindings include `org_id`, optional `project_id`, `principal_type`,
  `principal_id`, and `role_id`

## RBAC And Runtime Authorization

RBAC is required.

- Users need `credentials:manage` to create, list, inspect, or revoke
  credentials. During staging bootstrap, signed-in humans may manage their own
  project-scoped credentials while org RBAC rows are backfilled.
- A creator cannot grant capabilities beyond their own effective permissions.
- A creator cannot scope a credential to projects they cannot administer.
- Access keys require at least one project scope, and project-capability
  runtime calls must include project context in the path or query.
- `credentials:manage` is not grantable to access keys in v1.
- Runtime access is the intersection of service-account RBAC, credential
  capabilities, resource scope, expiry/revocation state, service-account
  status, IP allowlist, daily budgets, and endpoint-required capability.
- Every mutating request requires `Idempotency-Key` and writes an audit event.
  Replayed create requests return existing metadata with `access_key: null`;
  one-time secrets are never reprinted.

Capability catalog v1:

```text
projects:read
projects:create
connections:read
connections:create
diagrams:export
reports:read
reports:run
reports:download
billing:read
billing:topup
ask:run
mcp:use
credentials:manage
```

## Endpoint Shapes

### `GET /v1/credential-templates`

Returns CLI/UI presets:

```json
{
  "templates": [
    {
      "id": "ci",
      "name": "GitHub Actions CI",
      "default_capabilities": ["projects:read", "reports:run", "reports:read"],
      "default_expires": "90d",
      "supports_budgets": true,
      "supports_ip_allowlist": true
    }
  ]
}
```

### `POST /v1/credentials`

Required header:

```http
Idempotency-Key: <uuid>
```

Request:

```json
{
  "template": "ci",
  "name": "github-actions-prod",
  "project_id": "proj_123",
  "expires": "90d",
  "capabilities": ["projects:read", "reports:run", "reports:read"],
  "constraints": {
    "max_credits_per_day": 1000,
    "max_jobs_per_day": 20,
    "ip_allowlist": ["203.0.113.10"]
  }
}
```

Response:

```json
{
  "credential": {
    "id": "cred_123",
    "type": "access_key",
    "name": "github-actions-prod",
    "status": "active",
    "key_prefix": "cev_live_ak_01JABCDEF1234567890",
    "subject_type": "service_account",
    "subject_id": "sa_123",
    "project_ids": ["proj_123"],
    "capabilities": ["projects:read", "reports:run", "reports:read"],
    "expires_at": "2026-08-08T00:00:00Z"
  },
  "access_key": "cev_live_ak_01JABCDEF1234567890_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

`access_key` appears only in the initial create response. It is `null` for an
idempotent replay because raw access keys are not recoverable.

### `GET /v1/credentials`

Optional filters: `project_id`, `status`, `subject_id`.

```json
{
  "credentials": [
    {
      "id": "cred_123",
      "name": "github-actions-prod",
      "status": "active",
      "key_prefix": "cev_live_ak_01JABCDEF1234567890",
      "subject_type": "service_account",
      "subject_id": "sa_123",
      "subject_name": "github-actions-prod",
      "project_ids": ["proj_123"],
      "capabilities": ["projects:read", "reports:run"],
      "expires_at": "2026-08-08T00:00:00Z",
      "last_used_at": "2026-05-09T12:30:00Z"
    }
  ]
}
```

### `GET /v1/credentials/{credential_id}`

Returns metadata, capabilities, constraints, usage, and recent audit events.
Never returns the raw access key.

### `POST /v1/credentials/{credential_id}/revoke`

Required header:

```http
Idempotency-Key: <uuid>
```

Request:

```json
{
  "reason": "rotated"
}
```

Response:

```json
{
  "credential": {
    "id": "cred_123",
    "status": "revoked",
    "revoked_at": "2026-05-09T12:45:00Z",
    "revoke_reason": "rotated"
  }
}
```

### `GET /v1/identity`

Returns the effective user or service-account identity:

```json
{
  "identity": {
    "type": "service_account",
    "id": "sa_123",
    "name": "github-actions-prod",
    "org_id": "org_123",
    "project_ids": ["proj_123"]
  },
  "capabilities": ["projects:read", "reports:run", "reports:read"],
  "roles": ["report_runner"]
}
```

### `GET /v1/capabilities`

Returns live effective capabilities for the current identity:

```json
{
  "product": "Cloudeval",
  "auth": {
    "supports": ["browser_pkce", "device_flow", "access_key", "mcp_oauth"]
  },
  "current_identity": {
    "type": "service_account",
    "id": "sa_123",
    "name": "github-actions-prod"
  },
  "capabilities": ["projects:read", "reports:run", "reports:read"],
  "allowed_tools": [
    {
      "name": "reports.run",
      "risk": "low",
      "required_capabilities": ["reports:run"],
      "supports_dry_run": false
    }
  ],
  "limits": {
    "credits_remaining_today": 850,
    "jobs_remaining_today": 17,
    "max_parallel_jobs": 3
  },
  "templates": ["ci", "readonly-agent"]
}
```

## Structured Errors

Credential and capability failures should use machine-readable error bodies:

```json
{
  "error": {
    "code": "capability_denied",
    "message": "This credential cannot run reports.",
    "required_capabilities": ["reports:run"],
    "request_id": "req_123",
    "docs_url": "https://docs.cloudeval.ai/errors/capability_denied"
  }
}
```

The CLI preserves `request_id`, `required_capabilities`, and `docs_url` in
machine-readable error envelopes when the backend returns them.

## CLI Contract

```bash
cloudeval credentials templates --format json
cloudeval credentials create --template ci --name github-actions-prod --project <id> --expires 90d --format github-actions
cloudeval credentials list --project <id> --format json
cloudeval credentials inspect <credential_id> --format json
cloudeval credentials revoke <credential_id> --reason "rotated" --idempotency-key <uuid>
cloudeval identity --format json
cloudeval capabilities --live --format json
```

Automation auth uses `--access-key`, `--access-key-stdin`, and
`CLOUDEVAL_ACCESS_KEY`. Prefer stdin or the environment for automation.
`--access-key` remains available but prints a warning because process arguments
can leak through shell history and process listings. The beta `--api-key`,
`--api-key-stdin`, and `CLOUDEVAL_API_KEY` names are hard errors, not aliases.
MCP authenticates at server startup only; MCP tool schemas do not accept
per-call access-key arguments.

`--format github-actions` prints:

```yaml
CLOUDEVAL_ACCESS_KEY: cev_live_ak_...
CLOUDEVAL_PROJECT_ID: proj_...
```

When `credentials create` writes a one-time secret to `--output`, the CLI writes
the file with private permissions on POSIX systems. List and inspect commands
must never print the raw access key.

## Frontend Contract

Add **Settings -> Developer -> Auth Keys** in the frontend application.

Required UI surfaces:

- List keys with name, id, prefix, owner service account, project scope,
  capabilities, status, expiry, last used, and revoke action.
- Create wizard with template, name, required project scope, capabilities,
  expiry, budgets, and optional IP allowlist.
- One-time secret screen with copy access key, `.env` snippet, GitHub Actions
  snippet, and warning that the key cannot be viewed again.
- Inspect drawer with metadata, capabilities, constraints, usage summary, audit
  events, and revoke button.
- RBAC-aware controls: hide create/revoke actions unless the user has
  `credentials:manage`; disable capability choices the user cannot grant, and
  never allow `credentials:manage` to be selected for an access key.

The frontend must use the same `/v1/credentials`,
`/v1/credential-templates`, `/v1/identity`, and `/v1/capabilities` APIs as the
CLI. Snippets must use `CLOUDEVAL_ACCESS_KEY`, not `CLOUDEVAL_API_KEY`.

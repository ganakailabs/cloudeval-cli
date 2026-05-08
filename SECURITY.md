# Security Policy

## Responsible Disclosure

Please report suspected vulnerabilities, leaked credentials, or unsafe default
behavior privately before opening a public issue. Email security reports to
`security@ganak.ai` with:

- A short summary of the issue.
- Steps to reproduce or the affected commit/release.
- Whether any token, session, account, tenant, customer, billing, or report data
  may have been exposed.

Do not include live secrets in screenshots or public issue text. Redact all but
the first and last four characters when an identifier is needed for correlation.

## Sensitive Data

Treat these as sensitive in this repository, logs, tests, docs, support threads,
and agent transcripts:

- API keys, OAuth access tokens, refresh tokens, device codes, cookies, and
  authorization headers.
- Account IDs, session IDs, tenant IDs, checkout session IDs, customer emails,
  billing ledger rows, and invoices.
- Project report JSON, generated architecture/cost artifacts, private diagrams,
  local session databases, and smoke-test outputs from real backends.
- Local config under `~/.config/cloudeval`, `.env*`, `.cloudeval-downloads/`,
  and any copied smoke artifact directory.

## Leaked Credentials

If a credential or sensitive identifier is committed or published:

1. Revoke or rotate the credential first.
2. Remove it from the current tree.
3. Rewrite any affected Git refs and tags when the value should not remain in
   public history.
4. Rebuild and replace release assets if binaries or source archives included
   the value.
5. Run `pnpm security:scan` before republishing.

History rewrites do not clean existing forks, third-party clones, package
registries, release binary downloads, or external caches. Treat exposed secrets
as compromised even after the repository is cleaned.

## Local Smoke Artifacts

Real-backend smoke tests write outputs to an OS temporary directory by default
and delete that directory on success. Use `CLOUDEVAL_SMOKE_KEEP_DIR=1` only when
you need to inspect artifacts locally. If you set `CLOUDEVAL_SMOKE_ARTIFACT_DIR`,
choose a path outside the repository unless you are deliberately collecting a
redacted fixture.

Never commit smoke outputs from authenticated runs.

## Security Scan

Run:

```bash
pnpm security:scan
```

The scan performs:

- Gitleaks full-history scanning.
- Gitleaks current tracked/untracked candidate scanning using Git excludes.
- Targeted regex checks for common API keys and accidental Azure app auth
  identifiers.

Install nothing manually for the default path; the script downloads a temporary
Gitleaks binary when one is not already available.

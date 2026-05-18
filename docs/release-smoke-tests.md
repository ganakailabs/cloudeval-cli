# Release Smoke Tests

Use the release smoke script to verify the same install path users run for a
published CloudEval CLI release. The script executes the public installer in an
isolated temporary `HOME`, verifies the installed files, then runs a small set of
agent-safe commands against the real CloudEval backend FQDN,
`https://cloudeval.ai`.

## Quick Run

Run the latest release:

```bash
bash scripts/smoke-release-real-backend.sh
```

Run a specific release:

```bash
bash scripts/smoke-release-real-backend.sh v0.7.3
```

The same command is available through the root package script:

```bash
pnpm smoke:release:real
```

If `pnpm` is not on your `PATH`, run the shell script directly.

## npm package smoke

Before publishing `@ganakailabs/cloudeval-cli` to npm, verify the package
manifest and dry-run the exact tarball:

```bash
pnpm test:npm-package
(cd packages/cli && npm pack --dry-run)
```

The dry-run must include `dist`, `README.md`, `LICENSE`, `NOTICE`,
`THIRD_PARTY_NOTICES.md`, and `sbom.spdx.json`. The package should expose the
`cloudeval`, `eva`, and `cloud` binaries from `dist/cli.js`.

After installing a package or release in an isolated home, verify the cleanup
surface without deleting files:

```bash
cloudeval uninstall --dry-run --format json
```

`cloudeval uninstall --yes` removes installer-owned files while keeping
`~/.config/cloudeval`. Add `--remove-config` only for destructive local auth,
settings, and session cleanup.

## Defaults

The script uses the public CloudEval FQDN by default:

```bash
CLOUDEVAL_SMOKE_INSTALLER_URL=https://cli.cloudeval.ai/install.sh
CLOUDEVAL_SMOKE_BASE_URL=https://cloudeval.ai/api/proxy/v1
CLOUDEVAL_SMOKE_HEALTH_URL=https://cloudeval.ai/api/proxy/v1/health
```

The FQDN health route is protected in production. For unauthenticated smoke
runs, HTTP `401` with `AUTH_REQUIRED` or `AUTH_REQUIRED_PUBLIC` is treated as a
pass because it proves the route is reachable through `cloudeval.ai` and the
auth boundary is active.

## What It Covers

The smoke script verifies:

- The public installer at `scripts/install.sh` can be fetched and executed.
- GitHub latest release resolution, or the explicit release tag you pass.
- The installer selects the current OS/architecture release asset.
- The installer downloads the CLI binary and `yoga.wasm`, preferring compressed
  assets when the release provides them and falling back to raw assets.
- The installer validates release checksums.
- The installer downloads `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, and
  `sbom.spdx.json` into `~/.local/share/cloudeval/licenses` when the release
  provides them.
- The installer creates `~/.local/bin/cloudeval`.
- The installer creates the `eva` and `cloud` aliases on non-Windows platforms.
- The installer prints optional agent and credential setup guidance without
  running login, creating credentials, or writing MCP client config in CI.
- Interactive update/install flows can offer optional MCP onboarding for
  detected, all, or selected clients; unattended `--yes`/CI flows skip the
  prompt unless explicitly configured. MCP onboarding keeps per-client output
  concise and ends with a summary instead of printing full setup tables during
  installation.
- The installed CLI resolves from `PATH`.
- Release binary version matches the resolved release tag.
- `cloudeval --help` renders command help.
- `cloudeval status --format json` returns parseable success JSON.
- `cloudeval capabilities --format json` returns parseable success JSON.
- `cloudeval credentials templates --format json` and
  `cloudeval capabilities --live --format json` are covered by the
  non-interactive mock-backend suite because they require authenticated backend
  credential APIs.
- `cloudeval projects graph ...`, `cloudeval validate ...`, and
  `cloudeval rules ...` are covered by the non-interactive mock-backend suite
  because they require authenticated project/template context. This includes
  exact validation check targeting with repeatable `--rule` and async
  completion with bounded `--wait` / `--wait-timeout`, detailed per-check
  validation output with `--details`, and template test-suite output through
  `cloudeval validate tests`.
- `cloudeval models list --format json` reaches the real backend and returns at
  least one model.
- `cloudeval billing plans --format json --non-interactive` returns a parseable
  JSON error envelope when unauthenticated, with no stderr noise.
- `https://cloudeval.ai/api/proxy/v1/health` is reachable and either returns
  healthy JSON or the expected protected-route JSON.

Authenticated smoke coverage should use a stored `cloudeval login` session. For
new, incomplete, or deleted-and-recreated accounts, `cloudeval login --verbose`
should authenticate through `cloudeval.ai/device/login` and show the CLI
onboarding steps in an interactive terminal. The login approval URL should carry
an account chooser hint so the browser auth provider does not silently reuse the
wrong signed-in account. `cloudeval login --headless
--verbose` should run quick Playground setup and leave `cloudeval projects list
--format json` able to resolve the default Playground without a follow-up repair
from `cloudeval ask`.

## Environment Variables

Use these variables to customize the smoke run:

```bash
CLOUDEVAL_SMOKE_VERSION=v0.7.3
CLOUDEVAL_SMOKE_REPO=ganakailabs/cloudeval-cli
CLOUDEVAL_SMOKE_INSTALLER_URL=https://cli.cloudeval.ai/install.sh
CLOUDEVAL_SMOKE_BASE_URL=https://cloudeval.ai/api/proxy/v1
CLOUDEVAL_SMOKE_HEALTH_URL=https://cloudeval.ai/api/proxy/v1/health
CLOUDEVAL_SMOKE_KEEP_DIR=1
CLOUDEVAL_SMOKE_ARTIFACT_ROOT=/tmp
CLOUDEVAL_SMOKE_ARTIFACT_DIR=/tmp/cloudeval-smoke-debug
CLOUDEVAL_INSTALL_AGENT_SETUP=0
CLOUDEVAL_INSTALL_MCP_CLIENTS=codex,cursor
CLOUDEVAL_INSTALL_AGENT_SETUP_PROMPT=1
CLOUDEVAL_DOWNLOAD_PROGRESS=0
CLOUDEVAL_CURL_MAX_TIME=900
CLOUDEVAL_CURL_SPEED_TIME=30
CLOUDEVAL_CURL_SPEED_LIMIT=1024
```

`CLOUDEVAL_SMOKE_KEEP_DIR=1` preserves the downloaded binary and JSON outputs
for inspection. Without it, the temporary smoke directory is removed on exit.
By default smoke artifacts are created under the OS temporary directory, not the
repository. `CLOUDEVAL_SMOKE_ARTIFACT_ROOT` changes that temporary parent.
`CLOUDEVAL_SMOKE_ARTIFACT_DIR` uses an explicit directory and preserves it; use
a path outside the repository for real-backend runs.

The installer shows compact labeled progress bars in interactive terminals. CI
smoke runs keep downloads quiet by default, but still inherit the same connect,
max-time, and stall detection checks.

`CLOUDEVAL_INSTALL_AGENT_SETUP=0` disables installer onboarding. When enabled,
`CLOUDEVAL_INSTALL_MCP_CLIENTS` can preselect `detected`, `all`, or a
comma-separated group such as `codex,cursor`. `CLOUDEVAL_INSTALL_AGENT_SETUP_PROMPT=1`
is used by interactive update flows so the installer can skip install
confirmation prompts while still asking about optional MCP onboarding.

## Expected Output

A successful unauthenticated run looks like this:

```text
==> Installing CloudEval CLI through the public installer
repo=ganakailabs/cloudeval-cli
requested_version=latest
resolved_version=v0.7.3
installer_url=https://cli.cloudeval.ai/install.sh
install_home=/tmp/tmp.example/home
base_url=https://cloudeval.ai/api/proxy/v1

Welcome to
...
Installation Details:
  Requested Version: latest
  Resolved Release: v0.7.3
  Platform: macos-arm64
  Binary Asset: cloudeval-macos-arm64
  Checksum Verification: required
...
Installation complete!

ok - installer created cloudeval executable and yoga.wasm
ok - installer created eva alias
ok - installed cloudeval resolves from PATH

==> Running installed CLI smoke checks
ok - version is 0.7.3
ok - help renders
ok - status returned JSON success
ok - capabilities returned JSON success
ok - models-list returned JSON success
ok - billing-plans-unauthenticated returned JSON error envelope

==> Checking backend FQDN reachability
ok - FQDN backend route is reachable and protected as expected

==> Smoke test completed
release=v0.7.3
```

## When To Run

Run this smoke test:

- After every release workflow completes.
- After backend deploys that affect auth, model discovery, billing, or proxy
  routing.
- Before announcing a CLI binary as usable by external agents.
- Before debugging agent integrations, to separate binary/release issues from
  client configuration issues.

## Relation To Other Tests

This smoke test does not replace the source-level CLI tests. It exercises the
published release binary against the real backend with a small, high-signal set
of commands.

## Read-Only Command Smoke

Use the read-only smoke script when you want broader CLI command coverage
against the real backend and the public frontend FQDN without creating or
mutating CloudEval resources:

```bash
pnpm smoke:readonly:real
```

If `pnpm` is not on your `PATH`, run the shell script directly:

```bash
bash scripts/smoke-readonly-real-backend.sh
```

The script prints colored status labels, the exact CLI invocation, readable
command output, and a final summary. Every completed check emits `[PASS] <name>`
followed by a `cli:` block and an `output:` block. JSON commands show the
command envelope and response shape or counts, text commands show a few
non-empty output lines, frontend deeplinks show the generated URL, and the MCP
check shows tool/resource/prompt counts. Sensitive IDs, authorization values,
and access-key-shaped strings in command output are redacted by default.

Example:

```text
[PASS] models-list
  cli:
    /Users/prateek/.local/bin/cloudeval \
      models \
      list \
      --base-url \
      https://cloudeval.ai/api/proxy/v1 \
      --non-interactive \
      --format \
      json
  output:
    command: models list
    ok: true
    models: 5
    source: backend
[PASS] open-reports
  cli:
    /Users/prateek/.local/bin/cloudeval \
      open \
      reports \
      --project \
      smoke-project \
      --tab \
      overview \
      --report-type \
      all \
      --frontend-url \
      https://cloudeval.ai \
      --print-url \
      --no-open
  output:
    https://cloudeval.ai/app/reports/smoke-project?tab=overview&reportType=all
[PASS] mcp-serve-readonly
  cli:
    /Users/prateek/.local/bin/cloudeval \
      mcp \
      serve \
      --toolset \
      readonly \
      --base-url \
      https://cloudeval.ai/api/proxy/v1
  output:
    tools=<count> resources=<count> prompts=<count>

=== Final summary ===
[PASS] overall: passed
  passed: 30
  failed: 0
  skipped: 1
  total: 31
```

The read-only script covers:

- Public/local commands: `--version`, `--help`, `help agents`, `capabilities`,
  `status`, `doctor`, `auth status`, `banner`, shell completions, config
  commands, expanded recipe commands, model commands, sessions commands, and
  MCP initialize/list paths. MCP tool schemas must not expose `accessKey` as a
  per-call argument.
- Frontend deeplinks: overview, chat, projects, project details, connections,
  reports, and billing with `--print-url --no-open`.
- Authenticated read-only commands when usable auth exists: projects,
  connections, reports, credits, and billing.
- Optional access-key smoke when `CLOUDEVAL_SMOKE_ACCESS_KEY` is set: pipes the
  value through `--access-key-stdin` and verifies authenticated credits JSON.
- The basic non-interactive `ask` command when `CLOUDEVAL_SMOKE_RUN_ASK=1` is
  set. It is opt-in so the default read-only run does not consume model tokens.
- The basic non-interactive `agent` command when `CLOUDEVAL_SMOKE_RUN_AGENT=1`
  is set. It is opt-in for the same token-usage reason as `ask`.
- The basic non-interactive `recipes run cloudeval-cloud-cost-review` path can be covered with
  the same authenticated project setup; it is token-consuming for ask/agent
  backed recipes. Guide recipes such as `cloudeval-architecture-diagram-export`,
  `cloudeval-dependency-diagram-export`, `cloudeval-report-export-pack`, and
  `cloudeval-credential-rotation` should print explicit commands instead of performing
  side effects implicitly.

Useful controls:

```bash
CLOUDEVAL_SMOKE_CLI_BIN=/path/to/cloudeval
CLOUDEVAL_SMOKE_CLI_SOURCE=auto|local|installed
CLOUDEVAL_SMOKE_BASE_URL=https://cloudeval.ai/api/proxy/v1
CLOUDEVAL_SMOKE_FRONTEND_URL=https://cloudeval.ai
CLOUDEVAL_SMOKE_RUN_ASK=1
CLOUDEVAL_SMOKE_RUN_AGENT=1
CLOUDEVAL_SMOKE_ACCESS_KEY=cev_live_ak_...
CLOUDEVAL_SMOKE_REQUIRE_AUTH=1
CLOUDEVAL_SMOKE_STRICT_REPORTS=1
CLOUDEVAL_SMOKE_SHOW_RESULTS=0
CLOUDEVAL_SMOKE_RESULT_LINES=10
CLOUDEVAL_SMOKE_COLOR=always
```

By default, auth-gated checks are skipped when the shell has no usable stored
auth. Set `CLOUDEVAL_SMOKE_REQUIRE_AUTH=1` to fail instead.
Color defaults to `auto`; use `CLOUDEVAL_SMOKE_COLOR=always` for CI logs or
`CLOUDEVAL_SMOKE_COLOR=never` for plain text.

When run from this repository, `pnpm smoke:readonly:real` defaults to the
current checkout through a temporary local wrapper. This is the right path for
validating branch changes before release. Use
`CLOUDEVAL_SMOKE_CLI_SOURCE=installed` to test the already-installed
`cloudeval` binary, or `CLOUDEVAL_SMOKE_CLI_BIN=/path/to/cloudeval` to test a
specific executable.

For full non-interactive source coverage against a mock backend:

```bash
pnpm -C packages/cli test:cli:noninteractive
```

For the same suite against a locally packaged executable:

```bash
pnpm -C packages/cli test:cli:noninteractive:packaged
```

For the broader authenticated live backend suite:

```bash
pnpm -C packages/cli test:cli:noninteractive:live
```

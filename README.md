# Cloudeval CLI

Command-line interface for Cloudeval.

## Install

### One-line install (recommended)

```bash
curl -fsSL https://cli.cloudeval.ai/install.sh | bash
```

The installer downloads release binaries from GitHub Releases and verifies the
matching `.sha256` checksum before installing.

If the vanity URL is unavailable, use the GitHub fallback:

```bash
curl -fsSL https://raw.githubusercontent.com/ganakailabs/cloudeval-cli/main/scripts/install.sh | bash
```

After install:

```bash
cloudeval chat
eva chat
```

Update later:

```bash
cloudeval update --check
cloudeval update --yes
```

`cloudeval update` prints a readable status summary by default, not a
field/value table. Use `--format json`, `--format ndjson`, or
`--format markdown` for machine-readable output. Interactive text commands show
a cached once-per-day update nudge when a newer release is available. Set
`CLOUDEVAL_NO_UPDATE_CHECK=1` to suppress the nudge.

### Build locally

```bash
pnpm install
pnpm --filter cloudeval-cli build:executable:current
```

Run:

```bash
./packages/cli/dist/bin/cloudeval chat
```

## Commands

```bash
cloudeval setup [--non-interactive] [--base-url <url>] [--frontend-url <url>] [--project <id>] [--model <name>] [--profile <name>]
cloudeval config show|get|set|unset|path|profiles [--profile <name>] [--format text|json|ndjson|markdown]
cloudeval doctor [--deep] [--format text|json|ndjson|markdown]
cloudeval status [--format text|json|ndjson|markdown]
cloudeval models list [--base-url <url>] [--format text|json|ndjson|markdown]
cloudeval models default get|set [--profile <name>]
cloudeval sessions list|get|export|delete|prune [--format text|json|ndjson|markdown]
cloudeval tui [--base-url <url>] [--project <id>] [--model <name>] [--profile <name>]
cloudeval chat [--base-url <url>] [--machine] [--conversation <id>] [--model <name>] [--debug] [--profile <name>]
cloudeval ask <question> [--project <id>] [--output <file>] [--json] [--base-url <url>] [--machine] [--model <name>] [--profile <name>]
cloudeval projects export-diagram <id> --layout architecture|dependency --format png|jpeg|svg --labels all|viewport --output <file> [--headers-output <file>] [--public] [--frontend-url <url>] [--machine]
cloudeval credits [--format text|json|ndjson|markdown]
cloudeval billing topups [--format text|json|ndjson|markdown]
cloudeval billing topup <pack-id> [--currency <code>] [--country-code <code>] [--print-url|--open] [--format text|json|ndjson|markdown]
cloudeval billing topups buy <pack-id> [--currency <code>] [--country-code <code>] [--print-url|--open] [--format text|json|ndjson|markdown]
cloudeval mcp status [--format text|json|ndjson|markdown]
cloudeval mcp setup codex|claude|cursor|generic [--dry-run] [--command <path>] [--toolset all|readonly|projects|reports|billing]
cloudeval mcp serve [--toolset all|readonly|projects|reports|billing] [--base-url <url>] [--frontend-url <url>] [--machine] [--profile <name>]
cloudeval login [--headless]
cloudeval logout [--all-devices]
cloudeval auth status
cloudeval update [--check|-c] [--yes|-y] [--format|-f text|json|ndjson|markdown] [--output|-o <file>]
cloudeval capabilities --format json
cloudeval banner
```

`setup` and `config` write profile-specific defaults under
`~/.config/cloudeval`. `ask`, `chat`, `tui`, `models`, `status`, and `doctor`
respect the active profile through `--profile` or `CLOUDEVAL_PROFILE`, while
explicit flags still win for automation.

`cloudeval projects export-diagram` reports resolved absolute paths in human
output, JSON `data.output`, JSON `data.headersOutput`, and `filesWritten` so
headless agents can open the downloaded image without inferring the working
directory.

## MCP Server

CloudEval can run as a local stdio MCP server for agent tools that support the
Model Context Protocol:

```bash
cloudeval mcp serve
cloudeval mcp serve --toolset readonly
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "cloudeval": {
      "command": "cloudeval",
      "args": ["mcp", "serve"]
    }
  }
}
```

Codex CLI:

```bash
codex mcp add cloudeval -- cloudeval mcp serve
codex mcp list
```

Claude Desktop and Cursor setup helpers:

```bash
cloudeval mcp setup claude --dry-run --toolset reports --format json
cloudeval mcp setup cursor --dry-run --toolset billing --format json
```

Generic MCP client configuration:

```bash
cloudeval mcp setup generic --dry-run --toolset readonly --format json
```

For Ollama-powered agents, configure the MCP host launched by Ollama, such as a
local coding agent or editor extension. CloudEval does not need an
Ollama-specific bridge; the host only needs a stdio MCP server entry pointing at
`cloudeval mcp serve`.

For local development before installing the binary:

```bash
pnpm --filter cloudeval-cli build
codex mcp add cloudeval -- node /absolute/path/to/cloudeval-cli/packages/cli/dist/cli.js mcp serve
```

Claude Desktop, Cursor, and other JSON-configured MCP clients can use the same
stdio command shape:

```json
{
  "mcpServers": {
    "cloudeval": {
      "command": "cloudeval",
      "args": ["mcp", "serve"]
    }
  }
}
```

The server advertises Cursor-safe MCP tool names containing only letters,
numbers, and underscores: `capabilities_get`, `projects_list`, `projects_get`,
`projects_export_diagram`, `ask`, `reports_list`, `reports_run`,
`reports_download`, `billing_summary`, `billing_usage`, `billing_ledger`, and
`open_url`. Older dotted names such as `projects.list`,
`projects.exportDiagram`, and `open.url` remain accepted as call aliases for
backward compatibility, but MCP clients should use the underscore names because
some clients filter out dotted tool names. Authenticate with `cloudeval login`,
`cloudeval login --headless`, or `--machine` with service-principal
credentials. Run login before starting `mcp serve`; stdin is reserved for MCP
JSON-RPC messages.
The server starts without probing stored auth, writes protocol messages only to
stdout, writes `[cloudeval-mcp]` lifecycle diagnostics to stderr, supports
newline-delimited JSON-RPC over stdio for modern clients, and accepts legacy
`Content-Length` stdio frames for older MCP clients.

For help:

```bash
cloudeval --help
cloudeval chat --help
```

## Non-Interactive CLI Tests

Run the source-level non-interactive suite:

```bash
pnpm -C packages/cli test:cli:noninteractive
```

Run the same suite against the fully packaged local executable:

```bash
pnpm -C packages/cli test:cli:noninteractive:packaged
```

The suite starts a local mock backend and covers setup/config profiles,
doctor/status diagnostics, model discovery/defaults, local session history,
project creation/list/get, connections, report list/show/cost/WAF/rules/download,
diagram image downloads, billing/credits/top-up checkout, frontend deeplinks,
shell completion, capabilities, auth status, update checks, and one-shot `ask` streaming. To
test a specific binary, pass `CLOUDEVAL_CLI_BIN`:

```bash
CLOUDEVAL_CLI_BIN=/path/to/cloudeval pnpm -C packages/cli test:cli:noninteractive
```

Run against the authenticated real backend:

```bash
pnpm -C packages/cli test:cli:noninteractive:live
```

The live suite uses the currently stored CLI session and fails if cloud project,
report, billing, deeplink, or chat routes are not working. It skips real project
creation by default; include it with:

```bash
CLOUDEVAL_LIVE_ALLOW_MUTATION=1 pnpm -C packages/cli test:cli:noninteractive:live
```

## Release Smoke Tests

Smoke-test the public installer and installed release binary against the real
CloudEval FQDN:

```bash
bash scripts/smoke-release-real-backend.sh
```

or through the root package script:

```bash
pnpm smoke:release:real
```

The smoke test runs the same public installer users run, with `HOME` pointed at
a temporary directory. It verifies the installed binary, `yoga.wasm`, `eva`
alias, and PATH resolution, then runs `status`, `capabilities`, `models list`,
and unauthenticated billing JSON-envelope checks against
`https://cloudeval.ai/api/proxy/v1`. See
[docs/release-smoke-tests.md](docs/release-smoke-tests.md) for covered checks,
environment variables, authenticated optional checks, and expected output.

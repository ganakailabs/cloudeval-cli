# Cloudeval CLI

Command-line interface for Cloudeval.

## Install

### One-line install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/ganakailabs/cloudeval-cli/main/scripts/install.sh | bash
```

The installer downloads release binaries from GitHub Releases and verifies the
matching `.sha256` checksum before installing.

After `cli.cloudeval.ai` is configured, the preferred vanity URL can be:

```bash
curl -fsSL https://cli.cloudeval.ai/install.sh | bash
```

After install:

```bash
cloudeval chat
eva chat
```

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
cloudeval models list [--base-url <url>] [--api-key-stdin|--api-key <key>] [--format text|json|ndjson|markdown]
cloudeval models default get|set [--profile <name>]
cloudeval sessions list|get|export|delete|prune [--format text|json|ndjson|markdown]
cloudeval tui [--base-url <url>] [--project <id>] [--model <name>] [--profile <name>]
cloudeval chat [--base-url <url>] [--api-key-stdin|--api-key <key>] [--machine] [--conversation <id>] [--model <name>] [--debug] [--profile <name>]
cloudeval ask <question> [--project <id>] [--output <file>] [--json] [--base-url <url>] [--api-key-stdin|--api-key <key>] [--machine] [--model <name>] [--profile <name>]
cloudeval credits [--format text|json|ndjson|markdown]
cloudeval billing topups [--format text|json|ndjson|markdown]
cloudeval billing topup <pack-id> [--currency <code>] [--country-code <code>] [--print-url|--open] [--format text|json|ndjson|markdown]
cloudeval billing topups buy <pack-id> [--currency <code>] [--country-code <code>] [--print-url|--open] [--format text|json|ndjson|markdown]
cloudeval mcp serve [--base-url <url>] [--frontend-url <url>] [--api-key <key>] [--machine] [--profile <name>]
cloudeval login [--headless]
cloudeval logout [--all-devices]
cloudeval auth status
cloudeval capabilities --format json
cloudeval banner
```

`setup` and `config` write profile-specific defaults under
`~/.config/cloudeval`. `ask`, `chat`, `tui`, `models`, `status`, and `doctor`
respect the active profile through `--profile` or `CLOUDEVAL_PROFILE`, while
explicit flags still win for automation.

## MCP Server

CloudEval can run as a local stdio MCP server for agent tools that support the
Model Context Protocol:

```bash
cloudeval mcp serve
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
      "args": ["mcp", "serve"],
      "env": {
        "CLOUDEVAL_API_KEY": "optional-machine-token"
      }
    }
  }
}
```

The server exposes `ask`, `projects.list`, `projects.get`, `reports.list`,
`reports.run`, `reports.download`, `billing.summary`, `billing.usage`,
`billing.ledger`, `open.url`, and `capabilities.get`. Authenticate with
`cloudeval login`, configure `CLOUDEVAL_API_KEY` in the MCP client environment,
or pass `--machine` with service-principal credentials. `--api-key-stdin` is not
available for `mcp serve` because stdin is reserved for MCP JSON-RPC messages.
The server writes protocol messages only to stdout; diagnostics from
`--verbose` go to stderr.

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
billing/credits/top-up checkout, frontend deeplinks, shell completion, capabilities, auth status,
and one-shot `ask` streaming. To test a specific binary, pass `CLOUDEVAL_CLI_BIN`:

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

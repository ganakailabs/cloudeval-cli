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
cloudeval chat [--base-url <url>] [--api-key-stdin|--api-key <key>] [--machine] [--conversation <id>] [--model <name>] [--debug] [--verbose]
cloudeval ask <question> [--project <id>] [--output <file>] [--json] [--base-url <url>] [--api-key-stdin|--api-key <key>] [--machine] [--model <name>] [--debug] [--verbose]
cloudeval login [--headless] [--verbose]
cloudeval logout [--all-devices]
cloudeval auth status
cloudeval banner
```

For help:

```bash
cloudeval --help
cloudeval chat --help
```

## Auth Debugging

Use verbose mode to inspect redacted auth, onboarding, and project-repair
requests:

```bash
cloudeval login --headless --verbose
CLOUDEVAL_CLI_DEBUG=1 cloudeval auth status
```

The normal CLI login path uses CloudEval's backend device-code endpoint and
shows a CloudEval approval URL. If `/api/v1/auth/device/code` is blocked by a
web auth layer, the CLI fails with a middleware diagnostic instead of sending
consumer Google/GitHub users into Microsoft Entra tenant auth.

Direct Microsoft Entra fallback is only for tenant-backed accounts and can be
forced explicitly:

```bash
CLOUDEVAL_CLI_ALLOW_DIRECT_AZURE_FALLBACK=1 cloudeval login --headless
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

The suite starts a local mock backend and covers project creation/list/get,
connections, report list/show/cost/WAF/rules/download, billing/credits, frontend
deeplinks, shell completion, capabilities, auth status, and one-shot `ask`
streaming. To test a specific binary, pass `CLOUDEVAL_CLI_BIN`:

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

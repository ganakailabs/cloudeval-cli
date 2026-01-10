# Cloudeval CLI

Command-line interface for Cloudeval.

## Install

### One-line install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/ganakailabs/cloudeval-cli/main/scripts/install.sh | bash
```

After install:

```bash
cloudeval chat
eva chat
```

### Build locally

```bash
pnpm install
pnpm --filter @cloudeval/cli build:executable
```

Run:

```bash
./packages/cli/dist/bin/cloudeval chat
```

## Commands

```bash
cloudeval chat [--base-url <url>] [--api-key <key>] [--conversation <id>] [--model <name>] [--debug]
cloudeval login
cloudeval logout
cloudeval banner
```

For help:

```bash
cloudeval --help
cloudeval chat --help
```

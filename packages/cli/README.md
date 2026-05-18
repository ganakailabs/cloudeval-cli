# CloudEval CLI

CloudEval CLI brings CloudEval into your terminal, scripts, and agent tools. It
supports cloud chat, Agent mode, Agent Profiles, project and report inspection,
template validation, recipes, local hooks, and MCP server workflows.

[CloudEval](https://cloudeval.ai) | [Docs](https://docs.cloudeval.ai/reference/cli-overview) | [GitHub](https://github.com/ganakailabs/cloudeval-cli) | [Issues](https://github.com/ganakailabs/cloudeval-cli/issues) | [Releases](https://github.com/ganakailabs/cloudeval-cli/releases)

## Install

```bash
npm install -g @ganakailabs/cloudeval-cli
cloudeval --help
```

The npm package requires Node.js 20 or newer and installs these command aliases:

- `cloudeval`
- `cloud`
- `eva`

For standalone macOS, Linux, and Windows binaries, use the GitHub releases or
the shell installer:

```bash
curl -fsSL https://cli.cloudeval.ai/install.sh | bash
```

## Common Commands

```bash
cloudeval                         # Terminal UI
cloudeval login                   # Browser device login
cloudeval status                  # Account, API, and local CLI status
cloudeval ask "Summarize my cloud risk" --format json
cloudeval agent "Find cost and architecture risks" --format json
cloudeval agents list
cloudeval agents run cost --project <project-id> --format json
cloudeval projects list
cloudeval reports list
cloudeval mcp serve --toolset readonly
cloudeval capabilities --format json
```

## What It Covers

- Terminal UI for chat, Agent mode, projects, reports, billing, and settings.
- Scriptable commands with `json`, `ndjson`, `markdown`, and text output.
- Agent Profiles: `architecture`, `cost`, `triage`, and `remediation`.
- MCP tools for Codex, Cursor, Claude, VS Code, and other stdio JSON-RPC hosts.
- Project graph, report, recipe, rules, and validation workflows.
- Local opt-in hooks for CLI and Agent Profile events.

## Authentication

Use `cloudeval login` for local development. For CI or hosted agents, create a
scoped CloudEval access key in the app or with `cloudeval credentials create`,
then provide it as `CLOUDEVAL_ACCESS_KEY`.

## Documentation

- CLI overview: <https://docs.cloudeval.ai/reference/cli-overview>
- Command reference: <https://docs.cloudeval.ai/reference/cli-command-reference>
- MCP setup: <https://docs.cloudeval.ai/reference/mcp-client-setup>
- Release smoke tests: <https://github.com/ganakailabs/cloudeval-cli/blob/main/docs/release-smoke-tests.md>

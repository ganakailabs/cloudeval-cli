<p align="center">
  <img src="docs/assets/cloudeval-cli-banner.png" alt="Welcome to CloudEval" width="100%">
</p>

# CloudEval CLI

**Terminal, automation, and MCP tooling for CloudEval.**

[![Latest release](https://img.shields.io/github/v/release/ganakailabs/cloudeval-cli?sort=semver&style=flat-square&label=release)](https://github.com/ganakailabs/cloudeval-cli/releases/latest)
[![CloudEval](https://img.shields.io/badge/product-CloudEval-b6f23c?style=flat-square&labelColor=0b0f0a)](https://cloudeval.ai)
[![Docs](https://img.shields.io/badge/docs-docs.cloudeval.ai-2d6cdf?style=flat-square&logo=readthedocs&logoColor=white)](https://docs.cloudeval.ai/quickstart/use-the-cli.md)
[![Discord](https://img.shields.io/badge/Discord-community-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/tk5dcU2a7T)
[![Issues](https://img.shields.io/github/issues/ganakailabs/cloudeval-cli?style=flat-square&logo=github&label=issues)](https://github.com/ganakailabs/cloudeval-cli/issues)

CloudEval CLI turns ARM templates, GitHub-hosted IaC, and live Azure context into cost, architecture, and Well-Architected signals. Use it as an interactive terminal app, a scriptable CI tool, or an MCP server for Codex, Cursor, Claude, VS Code, and other stdio JSON-RPC clients.

## Install

macOS, Linux, WSL2, and Git Bash on Windows:

```bash
curl -fsSL https://cli.cloudeval.ai/install.sh | bash
```

Then open a new shell or reload your profile and sign in:

```bash
source ~/.bashrc   # or: source ~/.zshrc
cloudeval login
cloudeval status
cloudeval chat
```

Device login goes through `cloudeval.ai`. No local Azure app registration is needed for normal CLI use.

The installer:

- downloads checksum-verified GitHub release assets and installs `cloudeval`;
- creates the `eva` alias on non-Windows platforms;
- can install shell completions for bash, zsh, and fish;
- can offer MCP setup for detected Codex, Claude Desktop, Cursor, and VS Code clients;
- explains credential setup but does not create access keys or write secrets into MCP config.

Useful install controls:

```bash
curl -fsSL https://cli.cloudeval.ai/install.sh | CLOUDEVAL_INSTALL_AGENT_SETUP=0 bash
curl -fsSL https://cli.cloudeval.ai/install.sh | CLOUDEVAL_INSTALL_MCP_CLIENTS=codex,cursor bash
curl -fsSL https://raw.githubusercontent.com/ganakailabs/cloudeval-cli/main/scripts/install.sh | bash
```

Update later with:

```bash
cloudeval update --check
cloudeval update --yes
```

## Common Workflows

| Goal | Command |
| --- | --- |
| Open the terminal UI | `cloudeval` or `cloudeval chat` |
| Ask one question | `cloudeval ask "Summarize my cloud risk" --format json` |
| Run a deeper agent task | `cloudeval agent "Find cost and architecture risks" --format json` |
| List projects and reports | `cloudeval projects list`, `cloudeval reports list` |
| Run reusable workflows | `cloudeval recipes list`, `cloudeval recipes run <id>` |
| Inspect automation metadata | `cloudeval capabilities --format json` |
| Diagnose local setup | `cloudeval doctor --deep` |
| Manage access keys | `cloudeval credentials templates`, `cloudeval credentials create ...` |
| Serve MCP tools | `cloudeval mcp serve --toolset readonly` |

Run `cloudeval <command> --help` for exact flags. The full command reference lives in [docs.cloudeval.ai](https://docs.cloudeval.ai/reference/cli-command-reference.md).

## Authentication And Credentials

Human login is for interactive CLI use:

```bash
cloudeval login
cloudeval auth status
cloudeval identity --format json
```

Access keys are for CI, hosted agents, and other non-interactive automation. Create them only after login and project selection:

```bash
cloudeval projects list
cloudeval credentials templates --format json
cloudeval credentials create \
  --template ci \
  --name github-actions-prod \
  --project <project-id> \
  --expires 90d \
  --idempotency-key "$(uuidgen)" \
  --format github-actions
```

`--format github-actions` prints `CLOUDEVAL_ACCESS_KEY` and `CLOUDEVAL_PROJECT_ID` once. The raw key is not shown again by `credentials list` or `credentials inspect`.

Test an access key without putting it in shell history:

```bash
printf '%s\n' "$CLOUDEVAL_ACCESS_KEY" | cloudeval projects list \
  --access-key-stdin \
  --format json \
  --non-interactive
```

Credential rules:

- prefer `--access-key-stdin` or `CLOUDEVAL_ACCESS_KEY`;
- `--access-key` is accepted but warns because process arguments and shell history can leak;
- old beta names `--api-key`, `--api-key-stdin`, and `CLOUDEVAL_API_KEY` fail with a migration error;
- access-key-shaped strings, authorization headers, and sensitive URL query parameters are redacted by default;
- `--show-sensitive-ids` shows full IDs only, not token secrets.

## MCP For Agents

Start MCP after signing in, or provide a scoped `CLOUDEVAL_ACCESS_KEY` in the host environment:

```bash
cloudeval login
cloudeval mcp serve
cloudeval mcp serve --toolset readonly
```

Client setup helpers:

```bash
codex mcp add cloudeval -- cloudeval mcp serve --toolset readonly
cloudeval mcp setup cursor --dry-run --toolset reports --format json
cloudeval mcp setup vscode --dry-run --toolset readonly --format json
```

MCP notes:

- tool names use underscores such as `projects_list`, `recipes_list`, and `billing_summary`;
- legacy dotted names remain aliases;
- stdout is JSON-RPC only and `[cloudeval-mcp]` diagnostics go to stderr;
- tool schemas do not accept per-call access-key arguments;
- `mcp serve` does not support `--access-key-stdin` because stdin is the protocol stream.

Developer setup details are at [cli.cloudeval.ai/developer/](https://cli.cloudeval.ai/developer/).

## Output Contract

CloudEval CLI is designed to be pipeable:

- supported output formats are `text`, `json`, `ndjson`, and `markdown` where applicable;
- machine-readable command payloads go to stdout;
- progress, prompts, browser-open messages, and warnings go to stderr;
- human approval required in non-interactive mode exits with code `6` and returns `HITL_REQUIRED`.

For agent integration metadata:

```bash
cloudeval capabilities --format json
cloudeval capabilities --live --format json
cloudeval help agents
```

## Project Example

```bash
curl -L -o template.json \
  https://raw.githubusercontent.com/Azure/azure-quickstart-templates/master/quickstarts/microsoft.compute/1vm-2nics-2subnets-1vnet/azuredeploy.json

cloudeval projects create \
  --name "Azure VM network review" \
  --provider azure \
  --template-file ./template.json \
  --format json
```

Use `--template-url` when you do not want a local file. Follow with `reports run`, `reports download`, and `projects export-diagram` as needed.

## Docs

| Link | Purpose |
| --- | --- |
| [Use the CLI](https://docs.cloudeval.ai/quickstart/use-the-cli.md) | Install, login, create a project, and ask questions |
| [CLI command reference](https://docs.cloudeval.ai/reference/cli-command-reference.md) | Full command and flag list |
| [MCP client setup](https://docs.cloudeval.ai/reference/mcp-client-setup.md) | Codex, Cursor, Claude, VS Code, and generic MCP hosts |
| [Agent and automation rules](https://docs.cloudeval.ai/reference/agent-and-automation-rules.md) | Safe automation conventions |
| [Troubleshooting](https://docs.cloudeval.ai/troubleshooting/sign-in-and-onboarding.md) | Sign-in, onboarding, reports, and billing |

## Build From Source

Read [AGENTS.md](AGENTS.md) before touching auth, credentials, smoke artifacts, or user-facing command behavior.

```bash
git clone https://github.com/ganakailabs/cloudeval-cli.git
cd cloudeval-cli
pnpm install
pnpm build
pnpm -C packages/cli dev --help
```

Build a standalone binary for the current OS:

```bash
pnpm --filter cloudeval-cli build:executable:current
./packages/cli/dist/bin/cloudeval --help
```

Run checks:

```bash
pnpm lint
pnpm test
pnpm -C packages/cli test:cli:noninteractive
pnpm security:scan
```

## Community

- [CloudEval app](https://cloudeval.ai)
- [Docs](https://docs.cloudeval.ai/)
- [Releases](https://github.com/ganakailabs/cloudeval-cli/releases)
- [Issues](https://github.com/ganakailabs/cloudeval-cli/issues)
- [Discord](https://discord.gg/tk5dcU2a7T)

## License

See [LICENSE](LICENSE).

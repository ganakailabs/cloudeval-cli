# CloudEval CLI

**Agent-ready terminal and MCP tooling for [CloudEval](https://cloudeval.ai).** Create evaluation projects from ARM templates or live connections, run cost and architecture reports, ask grounded questions, inspect billing, and wire the same capabilities into Codex, Cursor, Claude, or any MCP client—without scraping the browser UI.

Machine-readable first: JSON, NDJSON, Markdown, and readable text where commands support `--format`. Progress and prompts stay on stderr so stdout stays pipeable for scripts. Sensitive IDs are redacted by default; opt in only when you need raw identifiers in a trusted shell.

**Full terminal experience** — Multiline chat, workspace tabs, slash commands, ghost-style suggestions, streaming reasoning progress, and local SQLite session history (search, resume, export, prune).

**One-shot automation** — `ask` for direct answers, `agent` for deeper planner-style runs, both with stable exit codes (including `6` / `HITL_REQUIRED` when human approval is needed in `--non-interactive` mode).

**Projects and reports** — Create projects from local ARM JSON or GitHub template URLs, list and open projects, run and download cost and Well-Architected reports, export architecture diagrams for reviews and other agents.

**MCP without hacks** — `cloudeval mcp serve` exposes Cursor-safe tool names over stdio; setup helpers for Codex, Claude Desktop, Cursor, and generic clients. Toolsets gate billing and mutation-heavy surfaces.

**Shell completion** — Bash, Zsh, Fish, and PowerShell scripts share the same completion engine as the CLI. The curl installer can offer `cloudeval completion install` for your login shell.

---

## Quick install

### Linux, macOS, WSL2, Git Bash on Windows

Checksum-verified release binary:

```bash
curl -fsSL https://cli.cloudeval.ai/install.sh | bash
```

The installer downloads GitHub release assets, verifies `.sha256` checksums, installs `cloudeval`, adds the `eva` alias on non-Windows platforms, and appends `~/.local/bin` to your shell profile when needed. On macOS and Linux it can run `cloudeval completion install` for bash, zsh, or fish (from `$SHELL`). Set `CLOUDEVAL_INSTALL_COMPLETION=0` to skip that prompt.

Fallback (raw GitHub):

```bash
curl -fsSL https://raw.githubusercontent.com/ganakailabs/cloudeval-cli/main/scripts/install.sh | bash
```

### Windows

There is no first-party PowerShell one-liner yet. Use **WSL2**, **Git Bash**, or another environment where `bash` and `curl` behave like a Unix shell, then run the Linux installer above.

> **Heads up:** Native Windows paths are less battle-tested than macOS/Linux/WSL2. If something breaks, [open an issue](https://github.com/ganakailabs/cloudeval-cli/issues) with your shell and install method.

After installation:

```bash
source ~/.bashrc    # or: source ~/.zshrc
cloudeval login
cloudeval status
cloudeval chat
```

`cloudeval login` uses CloudEval device login through `cloudeval.ai` (no local Azure app registration for normal use). Interactive terminals run CLI onboarding for new or incomplete accounts; headless and non-TTY sessions use the fast Playground setup path. To default the TUI to Agent mode: `cloudeval setup --mode agent --non-interactive`.

---

## Getting started

```bash
cloudeval                         # Terminal UI
cloudeval chat                    # Interactive chat
cloudeval ask "Summarize my cloud risk" --format json
cloudeval agent "Find cost and architecture risks" --format json
cloudeval models list
cloudeval projects list
cloudeval reports list
cloudeval billing summary
cloudeval capabilities --format json
cloudeval help agents
cloudeval doctor --deep
cloudeval update --check
```

📖 **[Full documentation →](https://docs.cloudeval.ai/quickstart/use-the-cli.md)**

## TUI vs one-shot vs MCP (quick reference)

| Goal | Interactive / TUI | Script or CI | MCP (`mcp serve`) |
| --- | --- | --- | --- |
| Grounded chat | `cloudeval` or `cloudeval chat` | — | Tools call the same APIs |
| Single answer | Ask mode in TUI | `cloudeval ask "…" --format json` | `ask` tool |
| Deeper task | Agent mode in TUI | `cloudeval agent "…" --format json` | Planner-capable flows via tools |
| Continue thread | `cloudeval chat --conversation <id>` | Same flags where supported | Session/thread via your client |
| Projects & reports | Slash commands / panels | `projects`, `reports`, `open` commands | `projects_*`, `reports_*`, … |
| Billing | Billing panels / links | `billing`, `credits` | `billing_*` (toolset-gated) |

For every flag and command, see the [CLI command reference](https://docs.cloudeval.ai/reference/cli-command-reference.md) and run `cloudeval <command> --help`.

---

## Documentation

Product and CLI docs live on **[docs.cloudeval.ai](https://docs.cloudeval.ai/index.md)**:

| Section | What's covered |
| --- | --- |
| [Use the CLI](https://docs.cloudeval.ai/quickstart/use-the-cli.md) | Install, login, first project, reports, grounded ask |
| [Quickstart](https://docs.cloudeval.ai/quickstart/index.md) | Shortest path to a useful report |
| [CLI overview](https://docs.cloudeval.ai/reference/cli-overview.md) | When to use the CLI vs UI, behavior, surfaces |
| [CLI command reference](https://docs.cloudeval.ai/reference/cli-command-reference.md) | Commands and options, grouped by task |
| [Terminal UI](https://docs.cloudeval.ai/reference/terminal-ui.md) | TUI concepts and keyboard flow |
| [MCP client setup](https://docs.cloudeval.ai/reference/mcp-client-setup.md) | Codex, Cursor, Claude, VS Code, generic |
| [Agent and automation rules](https://docs.cloudeval.ai/reference/agent-and-automation-rules.md) | Reliable integrations, machine-readable context |
| [Automate with the CLI](https://docs.cloudeval.ai/workflows/automate-evaluations-with-the-cli.md) | CI-style import, eval, download, deeplinks |
| [Headless diagram downloads](https://docs.cloudeval.ai/reference/headless-diagram-image-downloads.md) | PNG/SVG from CLI or agents |
| [llms.txt / agent context](https://docs.cloudeval.ai/reference/llms-and-agent-context.md) | `llms.txt`, `llms-full.txt` for agents |
| [Troubleshooting](https://docs.cloudeval.ai/troubleshooting/sign-in-and-onboarding.md) | Sign-in, onboarding, reports, billing |

**Releases:** [Latest GitHub release](https://github.com/ganakailabs/cloudeval-cli/releases/latest)

---

## Command cheat sheet

<details>
<summary>Expand full command list (also in docs)</summary>

```bash
cloudeval setup [--non-interactive] [--base-url <url>] [--frontend-url <url>] [--project <id>] [--model <name>] [--mode ask|agent] [--profile <name>]
cloudeval config show|get|set|unset|path|profiles [--profile <name>] [--format text|json|ndjson|markdown]
cloudeval doctor [--deep] [--format text|json|ndjson|markdown]
cloudeval status [--format text|json|ndjson|markdown] [--show-sensitive-ids]
cloudeval models list [--base-url <url>] [--format text|json|ndjson|markdown]
cloudeval models default get|set [--profile <name>]
cloudeval sessions list|get|search|rename|export|delete|prune [--format text|json|ndjson|markdown]
cloudeval tui [--base-url <url>] [--project <id>] [--model <name>] [--mode ask|agent] [--profile <name>]
cloudeval chat [--base-url <url>] [--conversation <id>] [--model <name>] [--mode ask|agent] [--debug] [--profile <name>]
cloudeval ask <question> [--project <id>] [--output <file>] [--format text|json|ndjson|markdown] [--base-url <url>] [--model <name>] [--profile <name>]
cloudeval agent <task> [--project <id>] [--output <file>] [--format text|json|ndjson|markdown] [--base-url <url>] [--model <name>] [--profile <name>]
cloudeval projects create --template-file <path>|--template-url <url> [--parameters-file <path>|--parameters-url <url>] [--format text|json|ndjson|markdown]
cloudeval projects list|get|open [--format text|json|ndjson|markdown]
cloudeval projects export-diagram <id> --layout architecture|dependency --format png|jpeg|svg --labels all|viewport --output <file> [--headers-output <file>] [--public] [--frontend-url <url>]
cloudeval connections list|get|open [--format text|json|ndjson|markdown]
cloudeval reports list|show|cost|waf|rules|run|download [--project <id>] [--format text|json|ndjson|markdown]
cloudeval credentials templates [--format text|json|ndjson|markdown]
cloudeval credentials create --template <id> --name <name> --project <id> [--expires 90d] [--idempotency-key <key>] [--format text|json|ndjson|markdown|github-actions]
cloudeval credentials list [--project <id>] [--format text|json|ndjson|markdown]
cloudeval credentials inspect <credential-id> [--format text|json|ndjson|markdown]
cloudeval credentials revoke <credential-id> [--reason <text>] [--idempotency-key <key>] [--format text|json|ndjson|markdown]
cloudeval credits [--format text|json|ndjson|markdown]
cloudeval billing summary|usage|ledger|invoices|plans|notifications|topups [--format text|json|ndjson|markdown]
cloudeval billing topup <pack-id> [--currency <code>] [--country-code <code>] [--print-url|--open] [--format text|json|ndjson|markdown]
cloudeval billing topups buy <pack-id> [--currency <code>] [--country-code <code>] [--print-url|--open] [--format text|json|ndjson|markdown]
cloudeval open overview|chat|projects|project|connections|connection|reports|billing [--print-url] [--no-open]
cloudeval mcp status [--format text|json|ndjson|markdown]
cloudeval mcp setup codex|claude|cursor|generic [--dry-run] [--command <path>] [--toolset all|readonly|projects|reports|billing]
cloudeval mcp serve [--toolset all|readonly|projects|reports|billing] [--base-url <url>] [--frontend-url <url>] [--access-key <key>] [--profile <name>]
cloudeval login [--headless]
cloudeval logout [--all-devices]
cloudeval auth status [--show-sensitive-ids]
cloudeval identity [--format text|json|ndjson|markdown]
cloudeval update [--check|-c] [--yes|-y] [--format|-f text|json|ndjson|markdown] [--output|-o <file>]
cloudeval capabilities [--live] --format json
cloudeval help agents
cloudeval completion bash|zsh|fish|powershell
cloudeval completion install --shell bash|zsh|fish|powershell
cloudeval completion uninstall --shell bash|zsh|fish|powershell
cloudeval banner
```

</details>

Shell completion is generated from the same engine the CLI uses for ghost suggestions. Use `cloudeval completion <shell>` to print a script, or `cloudeval completion install --shell <shell>` for a standard per-user install path.

---

## Projects from templates

```bash
curl -L -o template.json \
  https://raw.githubusercontent.com/Azure/azure-quickstart-templates/master/quickstarts/microsoft.compute/1vm-2nics-2subnets-1vnet/azuredeploy.json

cloudeval projects create \
  --name "Azure VM network review" \
  --provider azure \
  --template-file ./template.json \
  --format json
```

Or pass `--template-url` with a raw GitHub URL. Then `reports run`, `reports download`, and `projects export-diagram` as needed.

---

## MCP server for agents

```bash
cloudeval login
cloudeval mcp serve
cloudeval mcp serve --toolset readonly
```

```bash
codex mcp add cloudeval -- cloudeval mcp serve --toolset readonly
cloudeval mcp setup cursor --dry-run --toolset reports --format json
```

Tools use underscore names (`projects_list`, `ask`, `billing_summary`, …); dotted legacy names still work. Stdout is JSON-RPC only; `[cloudeval-mcp]` diagnostics go to stderr. Run `cloudeval login` first, or set `CLOUDEVAL_ACCESS_KEY` / `--access-key` with a scoped credential. `mcp serve` does not support `--access-key-stdin` (stdin is reserved for the protocol).

---

## Access keys and credentials

Scoped automation keys (CLI name: **credentials**, secret type: **access keys**):

```bash
cloudeval credentials templates --format json
cloudeval credentials create \
  --template ci \
  --name github-actions-prod \
  --project <project-id> \
  --expires 90d \
  --idempotency-key "$(uuidgen)" \
  --format github-actions
```

Use `--access-key` or `--access-key-stdin` for non-interactive commands. Deprecated `--api-key`, `CLOUDEVAL_API_KEY`, etc. fail with a migration message instead of silent fallback.

---

## Authentication and privacy

```bash
cloudeval login
cloudeval login --headless
cloudeval auth status
cloudeval auth status --show-sensitive-ids
```

`--show-sensitive-ids` is for trusted shells only; tokens and auth headers stay redacted. Local chat history lives in SQLite under the CloudEval config directory; legacy JSON sessions migrate automatically.

---

## Ask and agent modes

`ask` and `agent` share the same pipeable contract; runtime mode differs on the server. Quotes are optional for simple multi-word prompts; use quotes for shell metacharacters, leading dashes, or preserved spacing.

Use `--progress none`, `--quiet`, or `--format ndjson --progress ndjson` to control live progress vs NDJSON streams.

---

## Contributing and development

PRs welcome—keep public docs in sync with CLI behavior and run targeted tests for the surface you change. Read [`AGENTS.md`](AGENTS.md) before handling local secrets or smoke artifacts.

```bash
git clone https://github.com/ganakailabs/cloudeval-cli.git
cd cloudeval-cli
pnpm install
pnpm build
pnpm -C packages/cli dev --help
```

Standalone executable (current platform):

```bash
pnpm --filter cloudeval-cli build:executable:current
./packages/cli/dist/bin/cloudeval --help
```

**Checks:**

```bash
pnpm lint
pnpm test
pnpm -C packages/cli test:cli:noninteractive
pnpm -C packages/cli test:cli:noninteractive:packaged
pnpm security:scan
```

---

## Community

- [![Discord](https://img.shields.io/badge/Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/tk5dcU2a7T) CloudEval community (support & updates)
- [![GitHub Issues](https://img.shields.io/badge/issues-181717?style=flat-square&logo=github&logoColor=white)](https://github.com/ganakailabs/cloudeval-cli/issues)
- [![GitHub Releases](https://img.shields.io/badge/releases-181717?style=flat-square&logo=github&logoColor=white)](https://github.com/ganakailabs/cloudeval-cli/releases)
- [![Documentation](https://img.shields.io/badge/docs-2d6cdf?style=flat-square&logo=readthedocs&logoColor=white)](https://docs.cloudeval.ai/index.md)
- [![CloudEval](https://img.shields.io/badge/CloudEval-cloudeval.ai-b6f23c?style=flat-square&labelColor=0b0f0a)](https://cloudeval.ai)

---

## License

See [LICENSE](LICENSE).

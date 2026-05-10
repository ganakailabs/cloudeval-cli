# CloudEval CLI

**Your cloud, in the terminal: evaluated, reported, and agent-ready.**

[![Latest release](https://img.shields.io/github/v/release/ganakailabs/cloudeval-cli?sort=semver&style=flat-square&label=release)](https://github.com/ganakailabs/cloudeval-cli/releases/latest)
[![CloudEval](https://img.shields.io/badge/product-CloudEval-b6f23c?style=flat-square&labelColor=0b0f0a)](https://cloudeval.ai)
[![Docs](https://img.shields.io/badge/docs-docs.cloudeval.ai-2d6cdf?style=flat-square&logo=readthedocs&logoColor=white)](https://docs.cloudeval.ai/quickstart/use-the-cli.md)
[![Discord](https://img.shields.io/badge/Discord-community-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/tk5dcU2a7T)
[![Issues](https://img.shields.io/github/issues/ganakailabs/cloudeval-cli?style=flat-square&logo=github&label=issues)](https://github.com/ganakailabs/cloudeval-cli/issues)
[![AGENTS.md](https://img.shields.io/badge/contributors-AGENTS.md-555?style=flat-square)](https://github.com/ganakailabs/cloudeval-cli/blob/main/AGENTS.md)

---

Turn **ARM templates**, **GitHub-hosted IaC**, and **live Azure context** into cost, architecture, and Well-Architected signals. Then drive the same workflows from **chat**, **one-shot commands**, or **MCP** (Codex, Cursor, Claude, VS Code, or any client that speaks stdio JSON-RPC).

| If you are a... | CloudEval CLI gives you... |
| --- | --- |
| **Engineer in the terminal** | A full TUI: multiline chat, workspace tabs, slash commands, ghost suggestions, streaming reasoning, SQLite session history. |
| **Agent or script author** | Stable `--format` values (`json`, `ndjson`, `markdown`, text), stderr for progress, stdout for payloads, predictable exit codes (`6` = `HITL_REQUIRED` when automation cannot approve alone). |
| **Platform / DevEx** | Checksum-verified installs, shell completion (bash, zsh, fish, PowerShell), scoped access keys, and MCP toolsets that gate billing and mutation. |

---

## Highlights

| | |
| ---: | --- |
| **Machine-readable first** | JSON / NDJSON / Markdown where supported; redacted IDs by default (`--show-sensitive-ids` when you really mean it). |
| **MCP without scraping** | `cloudeval mcp serve` with underscore tool names, legacy dotted aliases, newline-delimited JSON-RPC plus optional `Content-Length` frames. |
| **Completion everywhere** | One engine powers tab completion and TUI ghost text. Run `completion install` after the curl installer (or set `CLOUDEVAL_INSTALL_COMPLETION=0` to skip). |

---

## Install

**macOS, Linux, WSL2, Git Bash (Windows)**

```bash
curl -fsSL https://cli.cloudeval.ai/install.sh | bash
```

<details>
<summary><strong>What the installer does</strong> (and fallbacks)</summary>

- Pulls GitHub release assets, verifies `.sha256`, installs `cloudeval` and the `eva` alias (non-Windows), adds `~/.local/bin` to your shell profile when needed.
- On macOS/Linux, can run `cloudeval completion install` for bash/zsh/fish from `$SHELL`. Set `CLOUDEVAL_INSTALL_COMPLETION=0` to skip the prompt.
- Detects Codex, Claude Desktop, Cursor, and VS Code, then offers optional MCP setup for one or more selected clients. Set `CLOUDEVAL_INSTALL_AGENT_SETUP=0` to skip, or `CLOUDEVAL_INSTALL_MCP_CLIENTS=codex,cursor` to preselect clients.
- Nudges users to run `cloudeval login` and prints scoped access-key commands for automation. It never creates credentials or changes agent/IDE config without an explicit prompt.

**Fallback URL**

```bash
curl -fsSL https://raw.githubusercontent.com/ganakailabs/cloudeval-cli/main/scripts/install.sh | bash
```

**Native Windows:** use **WSL2** or **Git Bash** plus the command above (no first-party PowerShell installer yet). If something breaks, [open an issue](https://github.com/ganakailabs/cloudeval-cli/issues) with your shell and path.

</details>

**Then**

```bash
source ~/.bashrc   # or: source ~/.zshrc
cloudeval login
cloudeval status
cloudeval chat
```

Device login goes through **cloudeval.ai**. No Azure app registration for normal use. Interactive shells get CLI onboarding when the account is new or incomplete; headless and non-TTY use the fast Playground setup. Default the TUI to Agent mode anytime: `cloudeval setup --mode agent --non-interactive`.

---

## First commands

```bash
cloudeval                         # Terminal UI
cloudeval chat                    # Interactive chat
cloudeval ask "Summarize my cloud risk" --format json
cloudeval agent "Find cost and architecture risks" --format json
cloudeval recipes list
cloudeval models list
cloudeval projects list
cloudeval reports list
cloudeval billing summary
cloudeval capabilities --format json
cloudeval help agents
cloudeval doctor --deep
cloudeval update --check
```

**Handbook:** [Use the CLI](https://docs.cloudeval.ai/quickstart/use-the-cli.md) and [CLI command reference](https://docs.cloudeval.ai/reference/cli-command-reference.md).

---

## One table: TUI vs automation vs MCP

| Goal | Interactive / TUI | Script or CI | MCP (`mcp serve`) |
| --- | --- | --- | --- |
| Grounded chat | `cloudeval` or `cloudeval chat` | n/a | Same APIs via tools |
| Single answer | Ask mode in TUI | `cloudeval ask "..." --format json` | `ask` tool |
| Deeper task | Agent mode in TUI | `cloudeval agent "..." --format json` | Planner-style tool flows |
| Reusable workflow | Prompt suggestions | `cloudeval recipes list|show|run` | `recipes_*` tools and recipe prompts |
| Continue thread | `cloudeval chat --conversation <id>` | Flags where supported | Your client owns threading |
| Projects and reports | Slash commands / panels | `projects`, `reports`, `open` | `projects_*`, `reports_*`, and related tools |
| Billing | Panels and links | `billing`, `credits` | `billing_*` (toolset-gated) |

Run `cloudeval <command> --help` for every flag.

---

## Documentation map

| Doc | Use it to... |
| --- | --- |
| [Use the CLI](https://docs.cloudeval.ai/quickstart/use-the-cli.md) | Install, login, first project, ask a grounded question |
| [Quickstart](https://docs.cloudeval.ai/quickstart/index.md) | Shortest path to a real report |
| [CLI overview](https://docs.cloudeval.ai/reference/cli-overview.md) | Choose CLI vs app, understand stdout/stderr contracts |
| [CLI command reference](https://docs.cloudeval.ai/reference/cli-command-reference.md) | Look up every command and option |
| [Terminal UI](https://docs.cloudeval.ai/reference/terminal-ui.md) | Navigate the TUI and keyboard model |
| [MCP client setup](https://docs.cloudeval.ai/reference/mcp-client-setup.md) | Wire Codex, Cursor, Claude, VS Code, generic hosts |
| [Agent and automation rules](https://docs.cloudeval.ai/reference/agent-and-automation-rules.md) | Build reliable integrations |
| [Automate with the CLI](https://docs.cloudeval.ai/workflows/automate-evaluations-with-the-cli.md) | CI-style import, eval, download, deeplinks |
| [Headless diagram downloads](https://docs.cloudeval.ai/reference/headless-diagram-image-downloads.md) | PNG/SVG from CLI or agents |
| [llms.txt and agent context](https://docs.cloudeval.ai/reference/llms-and-agent-context.md) | Point agents at `llms.txt` / `llms-full.txt` |
| [Troubleshooting](https://docs.cloudeval.ai/troubleshooting/sign-in-and-onboarding.md) | Fix sign-in, onboarding, reports, billing |

**Binary releases:** [github.com/ganakailabs/cloudeval-cli/releases/latest](https://github.com/ganakailabs/cloudeval-cli/releases/latest)

---

## Command cheat sheet

<details>
<summary><strong>Expand</strong> full one-liner command list</summary>

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
cloudeval recipes list|show|run [--project <id>] [--format table|text|json|ndjson|markdown]
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
cloudeval mcp setup codex|claude|cursor|vscode|generic [--dry-run] [--command <path>] [--toolset all|readonly|projects|reports|billing]
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

`cloudeval completion <shell>` prints a script; `completion install --shell <shell>` writes a standard per-user path.

---

## Example: project from a template

```bash
curl -L -o template.json \
  https://raw.githubusercontent.com/Azure/azure-quickstart-templates/master/quickstarts/microsoft.compute/1vm-2nics-2subnets-1vnet/azuredeploy.json

cloudeval projects create \
  --name "Azure VM network review" \
  --provider azure \
  --template-file ./template.json \
  --format json
```

Use `--template-url` with a raw GitHub URL when you do not want a local file. Follow with `reports run`, `reports download`, and `projects export-diagram` as needed.

---

## Recipes and public skills

CloudEval recipes are reusable, implemented workflows for agents and humans. They are intentionally limited to current CLI/MCP capabilities: cost review, WAF triage, architecture review, template project review, report summary, billing review, diagram export, and MCP setup.

```bash
cloudeval recipes list
cloudeval recipes show cost-review
cloudeval recipes run cost-review --project <project-id> --format json --non-interactive
```

Ask/agent-backed recipes may consume model credits. Recipes that would create projects, write diagrams, change MCP config, open browsers, or start checkout flows print explicit commands instead of performing those side effects implicitly. Portable agent instructions live under [`skills/`](skills/); MCP remains the preferred execution path for Codex, Cursor, Claude, and other agents.

---

## MCP for coding agents

```bash
cloudeval login
cloudeval mcp serve
cloudeval mcp serve --toolset readonly
```

```bash
codex mcp add cloudeval -- cloudeval mcp serve --toolset readonly
cloudeval mcp setup cursor --dry-run --toolset reports --format json
cloudeval mcp setup vscode --dry-run --toolset readonly --format json
```

Underscore tool names (`projects_list`, `ask`, `recipes_list`, `billing_summary`, and similar); dotted names remain aliases. MCP exposes recipe discovery (`cloudeval://recipes`), recipe prompts, read-only parity tools such as `connections_list`, `models_list`, `auth_status`, `status`, and `doctor`, plus non-read-only tools for report runs, diagram exports, recipe runs, browser links, and other explicit actions. **Stdout** is JSON-RPC only; **`[cloudeval-mcp]`** diagnostics go to stderr. Authenticate with `cloudeval login` or `CLOUDEVAL_ACCESS_KEY` / `--access-key`. **`mcp serve`** does not support `--access-key-stdin` (stdin is the protocol stream). Developer setup details are published at [cli.cloudeval.ai/developer/](https://cli.cloudeval.ai/developer/).

---

## Access keys (CI and automation)

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

Use `--access-key` or `--access-key-stdin` for non-interactive runs. Deprecated `--api-key` / `CLOUDEVAL_API_KEY` paths fail loudly with a migration message; there is no silent fallback.

---

## Auth and privacy (short)

```bash
cloudeval login
cloudeval login --headless
cloudeval auth status
cloudeval auth status --show-sensitive-ids
```

`--show-sensitive-ids` only on trusted machines. Tokens stay redacted. Chat history lives in **SQLite** under the CloudEval config dir; legacy JSON migrates automatically.

---

## Ask vs agent

Same pipeable contract; server runtime differs. Optional quotes for simple phrases; **required** when the shell would eat metacharacters, leading `-`, or odd spacing. Tune progress with `--progress none`, `--quiet`, or `--format ndjson --progress ndjson`.

---

## Build from source

Contributions welcome: keep user-facing docs aligned with behavior, and read [`AGENTS.md`](AGENTS.md) before touching secrets or smoke artifacts.

```bash
git clone https://github.com/ganakailabs/cloudeval-cli.git
cd cloudeval-cli
pnpm install
pnpm build
pnpm -C packages/cli dev --help
```

**Standalone binary (current OS)**

```bash
pnpm --filter cloudeval-cli build:executable:current
./packages/cli/dist/bin/cloudeval --help
```

**Repo checks**

```bash
pnpm lint
pnpm test
pnpm -C packages/cli test:cli:noninteractive
pnpm -C packages/cli test:cli:noninteractive:packaged
pnpm security:scan
```

---

## Community

Where to find people and releases (badges above also link here):

- **Discord:** [CloudEval community](https://discord.gg/tk5dcU2a7T) (support and updates)
- **Issues:** [github.com/ganakailabs/cloudeval-cli/issues](https://github.com/ganakailabs/cloudeval-cli/issues)
- **Releases:** [github.com/ganakailabs/cloudeval-cli/releases](https://github.com/ganakailabs/cloudeval-cli/releases)
- **Docs:** [docs.cloudeval.ai](https://docs.cloudeval.ai/index.md)
- **Web app:** [cloudeval.ai](https://cloudeval.ai)

---

## License

See [LICENSE](LICENSE).

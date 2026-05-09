# CloudEval CLI

CloudEval CLI is an agent-ready command line interface for CloudEval. It gives
humans and AI coding agents a terminal-native way to create cloud evaluation
projects, ask project-aware questions, generate architecture and cost reports,
inspect billing usage, and expose CloudEval tools through the Model Context
Protocol.

The CLI is designed for both interactive use and pipeable automation:

- Terminal UI and chat for long-running cloud review sessions.
- One-shot `ask` for direct answers and `agent` for deeper non-interactive
  planner/tool execution.
- Project creation from local template files or GitHub-hosted templates.
- Cost and Well-Architected Framework report commands.
- Local SQLite session history with search, resume, export, prune, and delete.
- MCP server support for Codex, Claude Desktop, Cursor, and other MCP clients.
- JSON, NDJSON, Markdown, and readable text output for commands that support
  structured output.
- Default redaction for account, session, tenant, checkout, and sensitive URL
  identifiers.

## Quick Install

Install the latest checksum-verified release binary:

```bash
curl -fsSL https://cli.cloudeval.ai/install.sh | bash
```

The installer downloads release assets from GitHub Releases, verifies the
matching `.sha256` checksum, installs `cloudeval`, installs the `eva` alias on
non-Windows platforms, and adds `~/.local/bin` to your shell profile when
needed. On macOS and Linux it also offers to run `cloudeval completion install`
for your login shell (`$SHELL`: bash, zsh, or fish). Set
`CLOUDEVAL_INSTALL_COMPLETION=0` to skip that prompt.

Fallback installer URL:

```bash
curl -fsSL https://raw.githubusercontent.com/ganakailabs/cloudeval-cli/main/scripts/install.sh | bash
```

After install:

```bash
cloudeval login
cloudeval status
cloudeval chat
```

`cloudeval login` uses CloudEval device login through `cloudeval.ai`; no local
Azure client ID, tenant ID, or app registration is needed for normal CLI use. It
also checks onboarding state after authentication. Interactive terminals show the
CLI onboarding steps for new, incomplete, or deleted-and-recreated accounts;
headless and non-TTY sessions run the fast Playground setup path instead.
Run `cloudeval setup --mode agent --non-interactive` if you want `cloudeval`
and `cloudeval chat` to open the TUI in Agent mode by default.

## First Commands

```bash
cloudeval                         # open the Terminal UI
cloudeval chat                    # start an interactive chat session
cloudeval ask "Summarize my cloud risk" --format json
cloudeval agent "Find cost and architecture risks" --format json
cloudeval models list
cloudeval projects list
cloudeval reports list
cloudeval billing summary
cloudeval capabilities --format json
cloudeval help agents
```

Use `--format json` for agents and scripts. Machine-readable commands write
data to stdout; prompts, warnings, auth flow text, and browser-open messages go
to stderr.

## Core Workflows

| Goal | Command |
| --- | --- |
| Open the full terminal experience | `cloudeval` or `cloudeval tui` |
| Ask one non-interactive question | `cloudeval ask "What changed?" --format json` |
| Run a non-interactive agent task | `cloudeval agent "Find cost and WAF risks" --format json` |
| Continue an interactive thread | `cloudeval chat --conversation <id>` |
| Start TUI in Agent mode | `cloudeval chat --mode agent` |
| Save Agent mode as default | `cloudeval setup --mode agent --non-interactive` |
| Create a project from a template | `cloudeval projects create --template-file ./template.json --name "Review"` |
| List and inspect projects | `cloudeval projects list`, `cloudeval projects get <id>` |
| Run reports | `cloudeval reports run --project <id> --type all` |
| Download reports | `cloudeval reports download --project <id> --type all --output ./reports` |
| Open frontend deep links | `cloudeval open project <id> --print-url --no-open` |
| Manage billing and credits | `cloudeval credits`, `cloudeval billing usage` |
| Buy more credits | `cloudeval billing topups`, `cloudeval billing topups buy <pack-id>` |
| Search local session history | `cloudeval sessions search "cost spike"` |
| Diagnose local setup | `cloudeval doctor --deep` |
| Update the binary | `cloudeval update --check`, `cloudeval update --yes` |

## Projects From Templates

Create projects from a local Azure Resource Manager template:

```bash
curl -L \
  -o template.json \
  https://raw.githubusercontent.com/Azure/azure-quickstart-templates/master/quickstarts/microsoft.compute/1vm-2nics-2subnets-1vnet/azuredeploy.json

cloudeval projects create \
  --name "Azure VM network review" \
  --provider azure \
  --template-file ./template.json \
  --format json
```

Create the same project directly from a GitHub-hosted template URL:

```bash
cloudeval projects create \
  --name "Azure VM network review" \
  --provider azure \
  --template-url https://raw.githubusercontent.com/Azure/azure-quickstart-templates/master/quickstarts/microsoft.compute/1vm-2nics-2subnets-1vnet/azuredeploy.json \
  --format json
```

Then generate and inspect reports:

```bash
cloudeval reports run --project <project-id> --type all --format json
cloudeval reports cost --project <project-id>
cloudeval reports waf --project <project-id>
cloudeval reports download --project <project-id> --type all --output ./reports
```

Export a project diagram for local review or another agent:

```bash
cloudeval projects export-diagram <project-id> \
  --layout architecture \
  --format png \
  --labels all \
  --output ./architecture.png
```

## MCP Server For Agents

CloudEval can run as a local stdio MCP server. This lets agents call CloudEval
tools without scraping terminal output.

```bash
cloudeval login
cloudeval mcp serve
cloudeval mcp serve --toolset readonly
```

Codex CLI:

```bash
codex mcp add cloudeval -- cloudeval mcp serve --toolset readonly
codex mcp list
```

Claude Desktop and Cursor setup helpers:

```bash
cloudeval mcp setup claude --dry-run --toolset reports --format json
cloudeval mcp setup cursor --dry-run --toolset billing --format json
```

Generic MCP clients:

```bash
cloudeval mcp setup generic --dry-run --toolset readonly --format json
```

MCP tools use Cursor-safe underscore names:

```text
capabilities_get
projects_list
projects_get
projects_export_diagram
ask
reports_list
reports_run
reports_download
billing_summary
billing_usage
billing_ledger
open_url
```

Older dotted tool names remain accepted as compatibility aliases. The server
starts without probing stored auth, writes protocol messages only to stdout,
writes `[cloudeval-mcp]` lifecycle diagnostics to stderr, supports
newline-delimited JSON-RPC over stdio, and accepts legacy `Content-Length`
stdio frames.

Run `cloudeval login` before starting `mcp serve`, or provide
`CLOUDEVAL_ACCESS_KEY` / `--access-key` from a scoped credential. Stdin is
reserved for MCP JSON-RPC messages, so `--access-key-stdin` is intentionally not
available for `mcp serve`.

## Authentication And Privacy

CloudEval CLI stores user auth locally after `cloudeval login`. Interactive and
agent commands reuse that stored session.

```bash
cloudeval login
cloudeval login --headless
cloudeval login --headless --verbose
cloudeval auth status
```

Verbose login enables redacted CLI debug logs for auth, onboarding, and
Playground repair requests. Normal CLI login uses CloudEval's device-code
backend and opens a `cloudeval.ai/device/login?...` approval URL; it does not
fall back to Microsoft Entra tenant auth for Google or GitHub users. After
authentication, interactive login shows the CLI onboarding steps when onboarding
is incomplete. `cloudeval login --headless`, CI, SSH, and non-TTY sessions use
`/onboard/quick` directly so the Playground project is ready before the next CLI
command. Template sync and report generation may continue asynchronously in the
backend.

Sensitive identifiers are redacted by default in text and machine-readable
output. This includes account IDs, session IDs, tenant IDs, checkout session
IDs, and sensitive URL query parameters such as `session_id`.

```bash
cloudeval auth status
cloudeval auth status --show-sensitive-ids
cloudeval status --format json
cloudeval status --format json --show-sensitive-ids
```

Use `--show-sensitive-ids` only in trusted local workflows. Tokens and
authorization headers remain redacted.

Local conversation history is stored in SQLite under the CloudEval config
directory. Legacy JSON session files are migrated into SQLite automatically.

## Ask And Agent Modes

`ask` and `agent` share the same pipeable output contract, but send different
runtime modes to CloudEval:

```bash
cloudeval ask Summarize this project --project <id> --format json
cloudeval agent Find cost and architecture risks --project <id> --format json
```

Quotes are optional for simple multi-word prompts because the CLI joins the
remaining words. Use quotes when the question contains shell metacharacters,
leading dashes, newlines, or spacing you need to preserve.

For text, JSON, and markdown output, terminal progress stays on stderr so stdout
remains pipeable. In an interactive terminal the CLI keeps one live status line
with a loader, reasoning progress bar, completed/total step count, and current
thinking step; in captured logs it falls back to append-only stderr events. Use
`--progress none` or `--quiet` to suppress progress, or `--format ndjson
--progress ndjson` to stream progress and answer chunks as newline-delimited
JSON.

If CloudEval asks for human approval, interactive `ask`/`agent` prompts on
stderr and then resumes the same thread. With `--non-interactive`, the command
exits with code `6` and returns `HITL_REQUIRED` in JSON/NDJSON output. If the
backend completes without final answer content, `ask` and `agent` exit non-zero
with a clear "No final response returned" message instead of returning an empty
result.

The TUI also has Ask and Agent modes. Choose per launch:

```bash
cloudeval chat --mode ask
cloudeval chat --mode agent
cloudeval tui --mode agent
```

Save a default mode in the active profile:

```bash
cloudeval setup --mode agent --non-interactive
cloudeval config set mode agent
cloudeval config get mode
```

After saving the default, `cloudeval`, `cloudeval tui`, and `cloudeval chat`
open with that mode selected so you can start typing immediately.

## Command Reference

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

Run `<command> --help` for exact options.

Shell completion scripts are generated from the same internal completion engine used by the CLI. Use `cloudeval completion <shell>` to print a script or `cloudeval completion install --shell <shell>` to install it in a standard per-user path.

## Access Keys and Credentials

CloudEval uses **credentials** as the CLI/API resource name and **Access Keys**
as the v1 secret type for CI, MCP, and other automation. Create scoped keys with
explicit project scope, expiry, and backend-enforced capabilities:

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

`--format github-actions` prints only the one-time secret handoff:

```yaml
CLOUDEVAL_ACCESS_KEY: cev_test_ak_...
CLOUDEVAL_PROJECT_ID: project-main
```

Use `--access-key` or `--access-key-stdin` for non-interactive commands. The
beta `--api-key`, `--api-key-stdin`, and `CLOUDEVAL_API_KEY` names now fail
with a migration error instead of silently falling back.

Access keys require project scope and cannot be granted `credentials:manage`.

Backend and frontend implementers should use
[`docs/credentials-api-contract.md`](docs/credentials-api-contract.md) for the
Key Vault storage model, RBAC rules, canonical endpoints, and Auth Keys UI
requirements.

## Local Development

```bash
pnpm install
pnpm build
pnpm -C packages/cli dev --help
```

Build the current-platform standalone executable:

```bash
pnpm --filter cloudeval-cli build:executable:current
./packages/cli/dist/bin/cloudeval --help
```

Use a development build as an MCP server:

```bash
pnpm --filter cloudeval-cli build
codex mcp add cloudeval -- node /absolute/path/to/cloudeval-cli/packages/cli/dist/cli.js mcp serve
```

## Tests And Smoke Checks

Source-level checks:

```bash
pnpm lint
pnpm test
pnpm -C packages/cli test:cli:noninteractive
```

Packaged executable non-interactive suite:

```bash
pnpm -C packages/cli test:cli:noninteractive:packaged
```

Authenticated live backend suite:

```bash
pnpm -C packages/cli test:cli:noninteractive:live
```

The live suite uses the currently stored CLI session. It skips real project
creation by default; include mutation with:

```bash
CLOUDEVAL_LIVE_ALLOW_MUTATION=1 pnpm -C packages/cli test:cli:noninteractive:live
```

Public release installer smoke:

```bash
pnpm smoke:release:real
```

Broad read-only real backend smoke:

```bash
pnpm smoke:readonly:real
CLOUDEVAL_SMOKE_RUN_ASK=1 pnpm smoke:readonly:real
CLOUDEVAL_SMOKE_RUN_AGENT=1 pnpm smoke:readonly:real
CLOUDEVAL_SMOKE_REQUIRE_AUTH=1 pnpm smoke:readonly:real
```

The smoke scripts use the public `cloudeval.ai` FQDN and write artifacts under
the OS temporary directory by default. See
[docs/release-smoke-tests.md](docs/release-smoke-tests.md) for coverage,
controls, and expected output.

## Security

Run the local guardrail scan before publishing:

```bash
pnpm security:scan
```

The scan runs Gitleaks across full Git history, scans current tracked and
untracked candidate files using Git excludes, and performs targeted regex
checks for common API keys and accidental Azure app auth identifiers.

See [SECURITY.md](SECURITY.md) for responsible disclosure, sensitive-data
handling, leaked credential response, and real-backend smoke artifact guidance.

## Documentation

- [Release smoke tests](docs/release-smoke-tests.md)
- [Security policy](SECURITY.md)
- [Latest release](https://github.com/ganakailabs/cloudeval-cli/releases/latest)
- [CloudEval docs site](https://cloudeval.ai)

## Contributing

Use focused pull requests, keep public docs in sync with CLI behavior, and run
the targeted tests for the command surface you change. Agent contributors should
also read [AGENTS.md](AGENTS.md) before inspecting local artifacts or security
data.

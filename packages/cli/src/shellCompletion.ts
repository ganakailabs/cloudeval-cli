export type CompletionShell = "bash" | "zsh" | "fish";

type CliCommand = {
  name: string;
  description: string;
  options: string[];
};

const commands: CliCommand[] = [
  {
    name: "tui",
    description: "Open the CloudEval Terminal UI",
    options: [
      "--base-url",
      "--tab",
      "--project",
      "--frontend-url",
      "--api-key",
      "--api-key-stdin",
      "--machine",
      "--model",
      "--debug",
      "--health-check",
      "--no-banner",
      "--no-anim",
      "--verbose",
      "--help",
    ],
  },
  {
    name: "chat",
    description: "Start an interactive chat session",
    options: [
      "--base-url",
      "--api-key",
      "--api-key-stdin",
      "--machine",
      "--conversation",
      "--model",
      "--debug",
      "--health-check",
      "--no-banner",
      "--no-anim",
      "--verbose",
      "--help",
    ],
  },
  {
    name: "ask",
    description: "Ask a single question",
    options: [
      "--base-url",
      "--api-key",
      "--api-key-stdin",
      "--machine",
      "--project",
      "--model",
      "--output",
      "--format",
      "--json",
      "--open",
      "--print-url",
      "--no-open",
      "--frontend-url",
      "--non-interactive",
      "--debug",
      "--verbose",
      "--help",
    ],
  },
  {
    name: "reports",
    description: "Access cost and Well-Architected Framework reports",
    options: [
      "list",
      "show",
      "cost",
      "waf",
      "download",
      "rules",
      "--base-url",
      "--api-key",
      "--api-key-stdin",
      "--machine",
      "--project",
      "--format",
      "--raw",
      "--parsed",
      "--formatted",
      "--kind",
      "--period",
      "--view",
      "--report",
      "--severity",
      "--type",
      "--timestamp",
      "--output",
      "--open",
      "--print-url",
      "--no-open",
      "--frontend-url",
      "--non-interactive",
      "--help",
    ],
  },
  {
    name: "projects",
    description: "Project utilities",
    options: [
      "list",
      "get",
      "open",
      "create",
      "--template-url",
      "--template-file",
      "--parameters-file",
      "--parameters-url",
      "--name",
      "--description",
      "--provider",
      "--format",
      "--output",
      "--open",
      "--print-url",
      "--no-open",
      "--frontend-url",
      "--base-url",
      "--non-interactive",
      "--help",
    ],
  },
  {
    name: "connections",
    description: "Connection utilities",
    options: [
      "list",
      "get",
      "open",
      "--format",
      "--output",
      "--open",
      "--print-url",
      "--no-open",
      "--frontend-url",
      "--base-url",
      "--non-interactive",
      "--help",
    ],
  },
  {
    name: "billing",
    description: "Billing and usage utilities",
    options: [
      "summary",
      "usage",
      "ledger",
      "invoices",
      "topups",
      "plans",
      "notifications",
      "--range",
      "--start-at",
      "--end-at",
      "--granularity",
      "--action-type",
      "--model",
      "--outcome",
      "--charge-status",
      "--limit",
      "--cursor",
      "--format",
      "--output",
      "--open",
      "--print-url",
      "--no-open",
      "--frontend-url",
      "--base-url",
      "--non-interactive",
      "--help",
    ],
  },
  {
    name: "credits",
    description: "Show current credit stats",
    options: [
      "--format",
      "--output",
      "--open",
      "--print-url",
      "--no-open",
      "--frontend-url",
      "--base-url",
      "--non-interactive",
      "--help",
    ],
  },
  {
    name: "open",
    description: "Open CloudEval frontend deeplinks",
    options: [
      "overview",
      "chat",
      "projects",
      "project",
      "connections",
      "connection",
      "reports",
      "billing",
      "--thread",
      "--quick",
      "--template-url",
      "--name",
      "--description",
      "--provider",
      "--auto-submit",
      "--view",
      "--layout",
      "--node",
      "--resource",
      "--tab",
      "--file",
      "--files",
      "--cursor",
      "--selection",
      "--workspace-focus",
      "--presentation",
      "--dialog",
      "--project",
      "--report-type",
      "--time-range",
      "--persona",
      "--cadence",
      "--issues-query",
      "--issues-fullscreen",
      "--issues-view",
      "--download-pdf",
      "--frontend-url",
      "--base-url",
      "--print-url",
      "--no-open",
      "--help",
    ],
  },
  {
    name: "capabilities",
    description: "Show machine-readable CLI capabilities",
    options: ["--format", "--help"],
  },
  {
    name: "login",
    description: "Authenticate with Cloudeval",
    options: ["--base-url", "--headless", "--verbose", "--help"],
  },
  {
    name: "logout",
    description: "Log out and clear stored authentication state",
    options: ["--base-url", "--all-devices", "--help"],
  },
  {
    name: "auth",
    description: "Authentication utilities",
    options: ["status", "--help"],
  },
  {
    name: "banner",
    description: "Preview the startup banner",
    options: ["--help"],
  },
  {
    name: "completion",
    description: "Print shell completion script",
    options: ["bash", "zsh", "fish", "--bin", "--help"],
  },
  {
    name: "help",
    description: "Display help",
    options: commandsForWords(),
  },
];

function commandsForWords(): string[] {
  return [
    "tui",
    "chat",
    "ask",
    "reports",
    "projects",
    "connections",
    "billing",
    "credits",
    "open",
    "capabilities",
    "login",
    "logout",
    "auth",
    "banner",
    "completion",
  ];
}

const optionCaseBlock = (indent: string): string =>
  commands
    .map(
      (command) =>
        `${indent}${command.name}) opts="${command.options.join(" ")}" ;;`
    )
    .join("\n");

const escapedSingleQuote = (value: string): string =>
  value.replace(/'/g, "'\\''");

export const normalizeCompletionShell = (
  shell?: string
): CompletionShell | undefined => {
  const normalized = shell?.toLowerCase();
  if (normalized === "bash" || normalized === "zsh" || normalized === "fish") {
    return normalized;
  }
  return undefined;
};

const buildBashCompletion = (binaryName: string): string => `# ${binaryName} completion for bash
_cloudeval_completion() {
  local cur command opts
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  command="\${COMP_WORDS[1]}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${commands.map((command) => command.name).join(" ")}" -- "$cur") )
    return 0
  fi

  case "$command" in
${optionCaseBlock("    ")}
    *) opts="" ;;
  esac

  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
}
complete -F _cloudeval_completion cloudeval eva
`;

const buildZshCompletion = (binaryName: string): string => `#compdef ${binaryName} eva

_cloudeval() {
  local -a commands
  commands=(
${commands
  .map(
    (command) =>
      `    '${escapedSingleQuote(command.name)}:${escapedSingleQuote(command.description)}'`
  )
  .join("\n")}
  )

  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi

  case "$words[2]" in
${commands
  .map(
    (command) =>
      `    ${command.name}) _arguments ${command.options
        .map((option) => `'${escapedSingleQuote(option)}'`)
        .join(" ")} ;;`
  )
  .join("\n")}
    *) _describe 'command' commands ;;
  esac
}

_cloudeval "$@"
`;

const buildFishCompletion = (binaryName: string): string => {
  const binaries = [binaryName, "eva"];
  return binaries
    .flatMap((binary) => [
      `complete -c ${binary} -f`,
      ...commands.map(
        (command) =>
          `complete -c ${binary} -f -n "__fish_use_subcommand" -a "${command.name}" -d "${command.description}"`
      ),
      ...commands.flatMap((command) =>
        command.options.map((option) =>
          option.startsWith("--")
            ? `complete -c ${binary} -f -n "__fish_seen_subcommand_from ${command.name}" --long ${option.slice(
                2
              )}`
            : `complete -c ${binary} -f -n "__fish_seen_subcommand_from ${command.name}" -a "${option}"`
        )
      ),
    ])
    .join("\n")
    .concat("\n");
};

export const buildCompletionScript = (
  shell: CompletionShell,
  binaryName = "cloudeval"
): string => {
  if (shell === "bash") {
    return buildBashCompletion(binaryName);
  }
  if (shell === "zsh") {
    return buildZshCompletion(binaryName);
  }
  return buildFishCompletion(binaryName);
};

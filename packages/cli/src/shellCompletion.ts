import { cliCommands as commands } from "./cliCommandRegistry.js";

export type CompletionShell = "bash" | "zsh" | "fish";

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

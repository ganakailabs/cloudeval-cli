export type CompletionShell = "bash" | "zsh" | "fish" | "powershell";

export const normalizeCompletionShell = (
  shell?: string
): CompletionShell | undefined => {
  const normalized = shell?.toLowerCase();
  if (
    normalized === "bash" ||
    normalized === "zsh" ||
    normalized === "fish" ||
    normalized === "powershell" ||
    normalized === "pwsh" ||
    normalized === "powershell.exe"
  ) {
    if (normalized === "pwsh" || normalized === "powershell.exe") {
      return "powershell";
    }
    return normalized;
  }
  return undefined;
};

const buildBashCompletion = (binaryName: string): string => `# ${binaryName} completion for bash
_cloudeval_completion() {
  local cur
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  while IFS=$'\t' read -r value kind description; do
    COMPREPLY+=("$value")
  done < <(${binaryName} __complete "\${COMP_WORDS[@]:1}" 2>/dev/null)
}
complete -o default -F _cloudeval_completion cloudeval eva
`;

const buildZshCompletion = (binaryName: string): string => `#compdef ${binaryName} eva

_cloudeval() {
  local -a cwords subs opts vals
  local line value kind description

  if (( \${#words[@]} > 1 )); then
    cwords=("\${(@)words[2,-1]}")
  else
    cwords=()
  fi

  while IFS=$'\n' read -r line; do
    value="\${line%%$'\\t'*}"
    kind="\${line#*$'\\t'}"
    kind="\${kind%%$'\\t'*}"
    description="\${line#*$'\\t'$'\\t'}"
    if [[ "$description" == "$line" ]]; then
      description="$kind"
    fi
    case "$kind" in
      command|subcommand) subs+=("$value:$description") ;;
      option) opts+=("$value:$description") ;;
      *) vals+=("$value:$description") ;;
    esac
  done < <(${binaryName} __complete "\${cwords[@]}" 2>/dev/null)

  if (( \${#subs[@]} )); then
    _describe -t cloudeval-commands commands subs
  fi
  if (( \${#opts[@]} )); then
    _describe -t cloudeval-options options opts
  fi
  if (( \${#vals[@]} )); then
    _describe -t cloudeval-values values vals
  fi
}

_cloudeval "$@"
`;

const buildFishCompletion = (binaryName: string): string => {
  const binaries = [binaryName, "eva"];
  const completionFn = `function __${binaryName}_complete
  set -l words (commandline -opc)
  if test (count \$words) -ge 1
    set -l base (basename \$words[1])
    if test "\$base" = ${binaryName} -o "\$base" = eva
      set words \$words[2..-1]
    end
  end
  command ${binaryName} __complete \$words 2>/dev/null
end`;
  return binaries
    .flatMap((binary) => [
      completionFn,
      `complete -c ${binary} -f`,
      `complete -c ${binary} -f -a "(__${binaryName}_complete)"`,
    ])
    .join("\n")
    .concat("\n");
};

const buildPowerShellCompletion = (binaryName: string): string => `# ${binaryName} completion for PowerShell
Register-ArgumentCompleter -Native -CommandName '${binaryName}','eva' -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tokens = @()
  if ($commandAst -and $commandAst.CommandElements) {
    $tokens = $commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.ToString() }
  }
  & ${binaryName} __complete @tokens 2>$null | ForEach-Object {
    $parts = $_ -split "\`t"
    $value = $parts[0]
    $kind = if ($parts.Length -ge 2) { $parts[1] } else { "value" }
    $description = if ($parts.Length -ge 3) { $parts[2] } else { $kind }
    [System.Management.Automation.CompletionResult]::new($value, $value, $kind, $description)
  }
}
`;

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
  if (shell === "fish") {
    return buildFishCompletion(binaryName);
  }
  return buildPowerShellCompletion(binaryName);
};

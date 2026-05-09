import { cliCommands } from "./cliCommandRegistry.js";

export type CompletionKind = "command" | "subcommand" | "option" | "value";

export type CompletionCandidate = {
  value: string;
  kind: CompletionKind;
  description?: string;
};

type CommandMeta = {
  name: string;
  description: string;
  options: string[];
};

const commandMetaByName = new Map<string, CommandMeta>(
  cliCommands.map((command) => [
    command.name,
    {
      name: command.name,
      description: command.description,
      options: command.options,
    },
  ])
);

const uniq = <T>(values: T[]): T[] => Array.from(new Set(values));

const isOptionToken = (token: string): boolean =>
  token.startsWith("-") && token.length > 1;

/** Drop argv prefix when shells pass the program name (or path) before subcommands. */
export const stripCompletionInvocation = (words: string[]): string[] => {
  const out = [...words];
  while (out.length > 0) {
    const w = out[0];
    const base = w.includes("/") || w.includes("\\") ? w.split(/[/\\]/).pop() ?? w : w;
    if (base === "cloudeval" || base === "eva") {
      out.shift();
      continue;
    }
    break;
  }
  return out;
};

const valueProviders: Record<string, string[]> = {
  "--mode": ["ask", "agent"],
  "--format": ["text", "json", "ndjson", "markdown"],
  "--tab": [
    "chat",
    "overview",
    "reports",
    "projects",
    "connections",
    "billing",
    "options",
    "help",
  ],
  "--shell": ["bash", "zsh", "fish", "powershell"],
};

const commandValueProviders: Record<string, Record<string, string[]>> = {
  completion: {
    shell: ["bash", "zsh", "fish", "powershell"],
    "--shell": ["bash", "zsh", "fish", "powershell"],
  },
};

/** Required subcommand tokens after a parent literal (e.g. billing topups → buy). */
const SUBCOMMAND_CHAIN: Record<string, Record<string, string[]>> = {
  billing: { topups: ["buy"] },
};

const chainNextLiterals = (
  commandName: string,
  committed: string[]
): string[] | null => {
  const chain = SUBCOMMAND_CHAIN[commandName];
  if (!chain) {
    return null;
  }
  for (let index = committed.length - 1; index >= 0; index -= 1) {
    const token = committed[index];
    const required = chain[token];
    if (required) {
      const pending = required.filter((literal) => !committed.includes(literal));
      if (pending.length) {
        return pending;
      }
    }
  }
  return null;
};

const stillInSubcommandChain = (commandName: string, committed: string[]): boolean =>
  chainNextLiterals(commandName, committed) !== null;

const optionExpectsValue = (option: string): boolean =>
  option in valueProviders ||
  option.endsWith("url") ||
  option.endsWith("file") ||
  option.endsWith("path") ||
  option.endsWith("name") ||
  option.endsWith("id") ||
  option.endsWith("model") ||
  option.endsWith("profile") ||
  option.endsWith("output") ||
  option.endsWith("period") ||
  option.endsWith("region") ||
  option.endsWith("currency") ||
  option.endsWith("provider") ||
  option.endsWith("layout") ||
  option.endsWith("labels") ||
  option.endsWith("type") ||
  option.endsWith("timestamp") ||
  option.endsWith("view") ||
  option.endsWith("report") ||
  option.endsWith("severity") ||
  option.endsWith("toolset") ||
  option.endsWith("command");

const normalizeToken = (token?: string): string => token ?? "";

const filterByPrefix = (
  candidates: CompletionCandidate[],
  prefix: string
): CompletionCandidate[] => {
  const normalizedPrefix = normalizeToken(prefix);
  return candidates.filter((candidate) =>
    candidate.value.startsWith(normalizedPrefix)
  );
};

const parseUsedOptions = (tokens: string[]): Set<string> => {
  const used = new Set<string>();
  for (const token of tokens) {
    if (isOptionToken(token)) {
      used.add(token);
    }
  }
  return used;
};

const getCommandSubcommands = (command: CommandMeta): string[] =>
  uniq(command.options.filter((option) => !isOptionToken(option)));

const getCommandOptions = (command: CommandMeta): string[] =>
  uniq(command.options.filter((option) => isOptionToken(option)));

const valueCandidatesForOption = (
  commandName: string,
  option: string
): string[] => {
  const byCommand = commandValueProviders[commandName];
  if (byCommand?.[option]) {
    return byCommand[option];
  }
  return valueProviders[option] ?? [];
};

const completionForCommandWord = (current: string): CompletionCandidate[] =>
  filterByPrefix(
    cliCommands.map((command) => ({
      value: command.name,
      kind: "command" as const,
      description: command.description,
    })),
    current
  );

const subcommandResolved = (
  command: CommandMeta,
  committedTokens: string[]
): boolean => {
  const subs = getCommandSubcommands(command);
  return committedTokens.some((token) => subs.includes(token));
};

export const completeCliWords = (words: string[]): CompletionCandidate[] => {
  const tokens = stripCompletionInvocation(words);
  const current = normalizeToken(tokens[tokens.length - 1]);
  const beforeCurrent = tokens.slice(0, -1);

  if (!beforeCurrent.length && !current) {
    return completionForCommandWord("");
  }

  const commandName = normalizeToken(beforeCurrent[0] ?? current);
  const command = commandMetaByName.get(commandName);

  if (!command || (!beforeCurrent.length && !commandMetaByName.has(current))) {
    return completionForCommandWord(current);
  }

  const commandTokens = beforeCurrent[0] === command.name
    ? [...beforeCurrent.slice(1), current]
    : beforeCurrent.slice(1);
  const usedOptions = parseUsedOptions(commandTokens);
  const committedAfterCommand = beforeCurrent.slice(1).filter(Boolean);
  const subs = getCommandSubcommands(command);
  const hasSubcommandGrammar = subs.length > 0;
  const chainPending = chainNextLiterals(command.name, committedAfterCommand);
  const resolved =
    subcommandResolved(command, committedAfterCommand) &&
    !stillInSubcommandChain(command.name, committedAfterCommand);

  const previous = beforeCurrent[beforeCurrent.length - 1];
  if (previous && isOptionToken(previous) && optionExpectsValue(previous)) {
    return filterByPrefix(
      valueCandidatesForOption(command.name, previous).map((value) => ({
        value,
        kind: "value" as const,
      })),
      current
    );
  }

  if (!isOptionToken(current) && current) {
    const literalValues = valueCandidatesForOption(command.name, previous ?? "");
    if (literalValues.length) {
      return filterByPrefix(
        literalValues.map((value) => ({ value, kind: "value" as const })),
        current
      );
    }
  }

  const optionCandidates = getCommandOptions(command)
    .filter((option) => !usedOptions.has(option))
    .map((option) => ({ value: option, kind: "option" as const }));
  const subcommandCandidates = subs.map((subcommand) => ({
    value: subcommand,
    kind: "subcommand" as const,
  }));

  if (isOptionToken(current)) {
    return filterByPrefix(optionCandidates, current);
  }

  if (chainPending) {
    return filterByPrefix(
      chainPending.map((value) => ({ value, kind: "subcommand" as const })),
      current
    );
  }

  if (hasSubcommandGrammar && !resolved) {
    return filterByPrefix(subcommandCandidates, current);
  }

  const candidates = resolved
    ? optionCandidates
    : [...subcommandCandidates, ...optionCandidates];
  return filterByPrefix(candidates, current);
};

import type { SelectPanelItem } from "./components/SelectPanel.js";

export type CompletionCycleState = {
  source: string;
  index: number;
};

export type CompletionContext<ProjectLike = { id: string; name: string }> = {
  projects: ProjectLike[];
  models: Array<SelectPanelItem<string>>;
  modes: Array<SelectPanelItem<string>>;
  profiles?: Array<SelectPanelItem<string>>;
  threads?: Array<SelectPanelItem<string>>;
};

export type PromptCommand<ProjectLike = { id: string; name: string }> =
  | { type: "openSelector"; selector: "thread" | "project" | "model" | "mode" | "profile" }
  | { type: "toggleThinking" }
  | { type: "stopChat" }
  | { type: "openFrontend" }
  | { type: "showHelp" }
  | { type: "showStarters" }
  | { type: "setModel"; model: string; label: string }
  | { type: "setMode"; mode: "ask" | "agent"; label: string }
  | { type: "setProfile"; profileId: string; label: string }
  | { type: "setProject"; project: ProjectLike }
  | { type: "setThread"; threadId: string; label: string }
  | { type: "unknown"; message: string };

export type PromptCompletion = {
  value: string;
  candidates: string[];
  source: string;
  index: number;
  ghostSuffix?: string;
};

type SlashCommand = {
  name: string;
  aliases: string[];
  description: string;
};

export const slashCommands: SlashCommand[] = [
  {
    name: "/thread",
    aliases: ["/threads"],
    description: "Open thread selector or use /thread <title-or-id>.",
  },
  {
    name: "/project",
    aliases: ["/projects"],
    description: "Open project selector or use /project <name-or-id>.",
  },
  {
    name: "/model",
    aliases: ["/models"],
    description: "Open model selector or use /model <model>.",
  },
  {
    name: "/mode",
    aliases: [],
    description: "Open mode selector or use /mode ask|agent.",
  },
  {
    name: "/profile",
    aliases: ["/profiles"],
    description: "Open Agent Profile selector or use /profile architecture|cost|triage|remediation.",
  },
  {
    name: "/starter",
    aliases: ["/starters"],
    description: "Show starter prompt selections.",
  },
  {
    name: "/thinking",
    aliases: ["/think"],
    description: "Expand or collapse the latest thinking steps.",
  },
  {
    name: "/stop",
    aliases: ["/cancel", "/abort"],
    description: "Cancel the running response.",
  },
  {
    name: "/open",
    aliases: ["/frontend"],
    description: "Open the current thread in the frontend.",
  },
  {
    name: "/help",
    aliases: ["/?"],
    description: "Show command help.",
  },
];

const normalize = (value: string): string => value.trim().toLowerCase();

const firstTokenAndRest = (input: string): { command: string; rest: string } => {
  const trimmed = input.trim();
  const match = /^(\S+)(?:\s+(.*))?$/.exec(trimmed);
  return {
    command: normalize(match?.[1] ?? ""),
    rest: match?.[2]?.trim() ?? "",
  };
};

const allCommandNames = (): string[] =>
  slashCommands.flatMap((command) => [command.name, ...command.aliases]);

const completeFromCandidates = (
  input: string,
  values: string[],
  previous?: CompletionCycleState
): PromptCompletion | null => {
  const candidates = [...new Set(values)].filter(Boolean);
  if (!candidates.length) {
    return null;
  }
  const source = `${input}\0${candidates.join("\0")}`;
  const index =
    previous?.source === source ? (previous.index + 1) % candidates.length : 0;

  return {
    value: candidates[index],
    candidates,
    source,
    index,
  };
};

const toGhostSuffix = (input: string, suggestion: string): string | undefined => {
  if (!suggestion.startsWith(input) || suggestion === input) {
    return undefined;
  }
  return suggestion.slice(input.length);
};

const modelValue = (item: SelectPanelItem<string>): string =>
  item.value || "auto";

const projectName = (project: { id: string; name: string }): string =>
  project.name || project.id;

export const completePromptInput = <ProjectLike extends { id: string; name: string }>(
  input: string,
  context: CompletionContext<ProjectLike>,
  previous?: CompletionCycleState
): PromptCompletion | null => {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const hasTrailingSpace = /\s$/.test(trimmed);
  const { command, rest } = firstTokenAndRest(trimmed);

  // A lone "/" matches every slash command via startsWith("/"); don't guess one.
  if (command === "/" && !hasTrailingSpace && !rest) {
    return null;
  }

  if (!hasTrailingSpace && !rest) {
    const commandMatches = allCommandNames()
      .filter((name) => name.startsWith(command));
    const completion = completeFromCandidates(trimmed, commandMatches, previous);
    return completion
      ? { ...completion, ghostSuffix: toGhostSuffix(trimmed, completion.value) }
      : null;
  }

  if (command === "/model" || command === "/models") {
    const query = normalize(rest);
    const modelMatches = context.models
      .map(modelValue)
      .filter((value) => value.startsWith(query));
    const completion = completeFromCandidates(trimmed, modelMatches, previous);
    return completion
      ? {
          ...completion,
          value: `/model ${completion.value}`,
          ghostSuffix: toGhostSuffix(trimmed, `/model ${completion.candidates[0] ?? ""}`),
        }
      : null;
  }

  if (command === "/mode") {
    const query = normalize(rest);
    const modeMatches = context.modes
      .map((item) => item.value)
      .filter((value) => value.startsWith(query));
    const completion = completeFromCandidates(trimmed, modeMatches, previous);
    return completion
      ? {
          ...completion,
          value: `/mode ${completion.value}`,
          ghostSuffix: toGhostSuffix(trimmed, `/mode ${completion.candidates[0] ?? ""}`),
        }
      : null;
  }

  if (command === "/profile" || command === "/profiles") {
    const query = normalize(rest);
    const profileMatches = (context.profiles ?? [])
      .flatMap((item) => (item.value ? [item.value] : ["default", "profile"]))
      .filter((value) => normalize(value).startsWith(query));
    const completion = completeFromCandidates(trimmed, profileMatches, previous);
    return completion
      ? {
          ...completion,
          value: `/profile ${completion.value}`,
          ghostSuffix: toGhostSuffix(trimmed, `/profile ${completion.candidates[0] ?? ""}`),
        }
      : null;
  }

  if (command === "/project" || command === "/projects") {
    const query = normalize(rest);
    const projectMatches = context.projects
      .map(projectName)
      .filter((value) => normalize(value).startsWith(query));
    const completion = completeFromCandidates(trimmed, projectMatches, previous);
    return completion
      ? {
          ...completion,
          value: `/project ${completion.value}`,
          ghostSuffix: toGhostSuffix(trimmed, `/project ${completion.candidates[0] ?? ""}`),
        }
      : null;
  }

  if (command === "/thread" || command === "/threads") {
    const query = normalize(rest);
    const threadMatches = (context.threads ?? [])
      .flatMap((item) => [item.value, item.label])
      .filter((value) => normalize(value).startsWith(query));
    const completion = completeFromCandidates(trimmed, threadMatches, previous);
    return completion
      ? {
          ...completion,
          value: `/thread ${completion.value}`,
          ghostSuffix: toGhostSuffix(trimmed, `/thread ${completion.candidates[0] ?? ""}`),
        }
      : null;
  }

  return null;
};

const matchOne = <T>(
  items: T[],
  query: string,
  getValues: (item: T) => string[]
): T | undefined => {
  const normalized = normalize(query);
  if (!normalized) {
    return undefined;
  }

  const exact = items.find((item) =>
    getValues(item).some((value) => normalize(value) === normalized)
  );
  if (exact) {
    return exact;
  }

  const prefixMatches = items.filter((item) =>
    getValues(item).some((value) => normalize(value).startsWith(normalized))
  );
  return prefixMatches.length === 1 ? prefixMatches[0] : undefined;
};

export const commandHelpText = (): string =>
  slashCommands
    .map((command) => `${command.name.padEnd(10)} ${command.description}`)
    .join(" | ");

export const resolvePromptCommand = <
  ProjectLike extends { id: string; name: string },
>(
  input: string,
  context: CompletionContext<ProjectLike>
): PromptCommand<ProjectLike> | null => {
  const { command, rest } = firstTokenAndRest(input);
  if (!command.startsWith("/")) {
    return null;
  }

  if (command === "/project" || command === "/projects") {
    if (!rest) {
      return { type: "openSelector", selector: "project" };
    }
    const project = matchOne(context.projects, rest, (item) => [
      item.id,
      item.name,
    ]);
    return project
      ? { type: "setProject", project }
      : { type: "unknown", message: `No unique project match for '${rest}'.` };
  }

  if (command === "/thread" || command === "/threads") {
    if (!rest) {
      return { type: "openSelector", selector: "thread" };
    }
    const thread = matchOne(context.threads ?? [], rest, (item) => [
      item.value,
      item.label,
    ]);
    return thread
      ? {
          type: "setThread",
          threadId: thread.value,
          label: thread.label,
        }
      : { type: "unknown", message: `No unique thread match for '${rest}'.` };
  }

  if (command === "/model" || command === "/models") {
    if (!rest) {
      return { type: "openSelector", selector: "model" };
    }
    const model = matchOne(context.models, rest, (item) => [
      item.value || "auto",
      item.label,
    ]);
    return model
      ? {
          type: "setModel",
          model: model.value,
          label: model.label,
        }
      : { type: "unknown", message: `No unique model match for '${rest}'.` };
  }

  if (command === "/mode") {
    if (!rest) {
      return { type: "openSelector", selector: "mode" };
    }
    const mode = matchOne(context.modes, rest, (item) => [
      item.value,
      item.label,
    ]);
    return mode && (mode.value === "ask" || mode.value === "agent")
      ? { type: "setMode", mode: mode.value, label: mode.label }
      : { type: "unknown", message: `No unique mode match for '${rest}'.` };
  }

  if (command === "/profile" || command === "/profiles") {
    if (!rest) {
      return { type: "openSelector", selector: "profile" };
    }
    const profile = matchOne(context.profiles ?? [], rest, (item) => [
      item.value || "default",
      item.value ? item.label : "profile",
    ]);
    return profile
      ? {
          type: "setProfile",
          profileId: profile.value,
          label: profile.label,
        }
      : { type: "unknown", message: `No unique profile match for '${rest}'.` };
  }

  if (command === "/starter" || command === "/starters") {
    return { type: "showStarters" };
  }

  if (command === "/thinking" || command === "/think") {
    return { type: "toggleThinking" };
  }

  if (command === "/stop" || command === "/cancel" || command === "/abort") {
    return { type: "stopChat" };
  }

  if (command === "/open" || command === "/frontend") {
    return { type: "openFrontend" };
  }

  if (command === "/help" || command === "/?") {
    return { type: "showHelp" };
  }

  return { type: "unknown", message: `Unknown command '${command}'.` };
};

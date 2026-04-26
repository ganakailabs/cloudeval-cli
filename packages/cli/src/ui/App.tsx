import React, { useEffect, useMemo, useState, startTransition } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Banner } from "./components/Banner.js";
import { Loader } from "./components/Loader.js";
import { Transcript } from "./components/Transcript.js";
import { InputBox } from "./components/InputBox.js";
import { Spinner } from "./components/Spinner.js";
import { Scrollbar } from "./components/Scrollbar.js";
import { ProjectSelector } from "./components/ProjectSelector.js";
import { SelectPanel, type SelectPanelItem } from "./components/SelectPanel.js";
import {
  commandHelpText,
  completePromptInput,
  resolvePromptCommand,
  type CompletionCycleState,
} from "./commandCompletion.js";
import { sanitizeTerminalInput } from "./inputSanitizer.js";
import {
  buildControlFocusOrder,
  focusFollowUpIndex,
  getSelectorControlHitAreas,
  isSelectorControlFocus,
  nextControlFocus,
  selectorControlFromMousePosition,
  type SelectorControlKind,
  type TuiControlFocus,
} from "./interactionModel.js";
import { getResponsiveTuiLayout, truncateForTerminal, type TerminalSize } from "./layout.js";
import { shouldAutoScrollToBottom } from "./scrollBehavior.js";
import { getPromptSuggestions } from "./promptSuggestions.js";
import { terminalTheme } from "./theme.js";
import { CLI_VERSION } from "../version.js";
import { buildFrontendUrl, resolveFrontendBaseUrl as resolveSharedFrontendBaseUrl } from "../frontendLinks.js";
import {
  WorkspacePanel,
  WorkspaceTabBar,
  type WorkspacePanelState,
} from "./workspacePanel.js";
import {
  getWorkspaceTabHitAreas,
  nextWorkspaceTab,
  normalizeWorkspaceTab,
  workspaceTabFromColumn,
  workspaceTabFromShortcut,
  type WorkspaceTab,
} from "./workspaceTabs.js";
import {
  completeActiveAssistantMessage,
  initialChatState,
  reduceChunk,
  streamChat,
  getAuthToken,
  checkUserStatus,
  getProjects,
  ensurePlaygroundProject,
  normalizeApiBase,
  fetchReportResource,
  getCostReportFull,
  getWafReportFull,
  getBillingEntitlement,
  getBillingUsageSummary,
  getBillingUsageLedger,
  getSubscriptionBillingInfo,
  getTopUpPacks,
  getBillingNotifications,
  getCreditStatus,
  listConnections,
  type Project,
} from "@cloudeval/core";
import {
  ChatMessage,
  ChatState,
  Chunk,
  HitlQuestion,
  HitlResponse,
  HitlState,
} from "@cloudeval/shared";
import { Onboarding } from "./components/Onboarding";
import { getFirstNameForDisplay } from "./userDisplayName.js";

export interface AppProps {
  baseUrl: string;
  apiKey?: string;
  allowMachineAuth?: boolean;
  conversationId?: string;
  model?: string;
  initialTab?: string;
  initialProjectId?: string;
  frontendUrl?: string;
  debug?: boolean;
  disableBanner?: boolean;
  disableAnim?: boolean;
  skipHealthCheck?: boolean;
}

const bootSteps = [
  "Loading config",
  "Validating auth",
  "Checking backend health",
  "Ready",
];

const defaultUser = { id: "cli-user", name: "CLI User" };

const getUserNameFromToken = async (token?: string): Promise<string> => {
  if (!token) return "You";
  try {
    const { extractEmailFromToken } = await import("@cloudeval/core");
    const email = extractEmailFromToken(token);
    return getFirstNameForDisplay({ email: email ?? undefined });
  } catch {
    return "You";
  }
};
const defaultProject: ProjectInfo = {
  id: "cli-project",
  name: "Playground",
  user_id: "cli-user",
  cloud_provider: "azure",
};

// Use Project type from core (matches frontend)
type ProjectInfo = Project;
type ChatMode = "ask" | "agent";
type SelectorKind = "project" | "model" | "mode" | null;
type QueuedMessage = { id: string; text: string };
type SendMessageOptions = {
  queuedMessageId?: string;
  hitlResume?: {
    checkpointId: string;
    responses: HitlResponse[];
    runId?: string;
    langsmithTraceId?: string;
  };
  resumeMessageId?: string;
  hitlQuestions?: HitlQuestion[];
};

const selectorOrder: SelectorControlKind[] = ["project", "model", "mode"];
const dropdownIndicator = "⌄";

const fallbackModels = [
  { label: "Auto", value: "", description: "Let the backend choose the best available model." },
  { label: "GPT-5 Nano", value: "gpt-5-nano", description: "Fast default for ask mode." },
  { label: "GPT-5 Mini", value: "gpt-5-mini", description: "Balanced latency and quality." },
  { label: "GPT-5", value: "gpt-5", description: "Higher quality for harder tasks." },
];

const modeItems: Array<SelectPanelItem<ChatMode>> = [
  {
    label: "Ask",
    value: "ask",
    description: "Fast answers and explanations.",
  },
  {
    label: "Agent",
    value: "agent",
    description: "Planner/tool-oriented mode for deeper execution.",
  },
];

const commandNotice = (candidates: string[]): string =>
  candidates.length > 1
    ? `Completions: ${candidates.join(" | ")}`
    : `Completed: ${candidates[0]}`;

const modelNameFromRaw = (raw: any): string | undefined => {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return undefined;
  return raw.id || raw.name || raw.model || raw.slug || raw.deployment_name;
};

const normalizeModelItems = (rawModels: unknown): Array<SelectPanelItem<string>> => {
  const list = Array.isArray(rawModels)
    ? rawModels
    : Array.isArray((rawModels as any)?.models)
      ? (rawModels as any).models
      : Array.isArray((rawModels as any)?.data)
        ? (rawModels as any).data
        : [];

  return list
    .map((raw: any) => {
      const value = modelNameFromRaw(raw);
      if (!value) return null;
      const label = raw?.display_name || raw?.displayName || raw?.name || value;
      const description =
        raw?.description ||
        raw?.provider ||
        raw?.family ||
        (raw?.restricted ? "Restricted by current plan." : undefined);
      return { label, value, description } satisfies SelectPanelItem<string>;
    })
    .filter((item: SelectPanelItem<string> | null): item is SelectPanelItem<string> =>
      Boolean(item)
    );
};

const mergeModelItems = (
  fetchedItems: Array<SelectPanelItem<string>>,
  cliModel?: string
): Array<SelectPanelItem<string>> => {
  const merged = new Map<string, SelectPanelItem<string>>();
  merged.set("", fallbackModels[0]);
  for (const item of fetchedItems) {
    merged.set(item.value, item);
  }
  for (const item of fallbackModels.slice(1)) {
    if (!merged.has(item.value)) {
      merged.set(item.value, item);
    }
  }
  if (cliModel && !merged.has(cliModel)) {
    merged.set(cliModel, {
      label: cliModel,
      value: cliModel,
      description: "Model provided by --model.",
    });
  }
  return Array.from(merged.values());
};

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

const isBusyStatus = (status: ChatState["status"]): boolean =>
  status === "connecting" ||
  status === "thinking" ||
  status === "streaming" ||
  status === "tool_running" ||
  status === "hitl_waiting";

const resolveFrontendBaseUrl = (apiBase: string, frontendUrl?: string): string =>
  resolveSharedFrontendBaseUrl({
    frontendUrl,
    apiBaseUrl: apiBase,
  });

const buildFrontendThreadUrl = (frontendBaseUrl: string, threadId?: string): string => {
  return buildFrontendUrl({
    baseUrl: frontendBaseUrl,
    target: "chat",
    threadId,
  });
};

const createWorkspacePanelState = (
  tab: WorkspaceTab,
  status: WorkspacePanelState["status"] = "idle"
): WorkspacePanelState => ({
  tab,
  status,
  data: {},
  warnings: [],
});

const thirtyDayUsageRange = (): { startAt: string; endAt: string } => {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - 29);
  start.setHours(0, 0, 0, 0);
  return {
    startAt: start.toISOString(),
    endAt: end.toISOString(),
  };
};

const buildWorkspaceFrontendUrl = ({
  tab,
  frontendBaseUrl,
  threadId,
  projectId,
}: {
  tab: WorkspaceTab;
  frontendBaseUrl: string;
  threadId?: string;
  projectId?: string;
}): string => {
  if (tab === "chat") {
    return buildFrontendUrl({ baseUrl: frontendBaseUrl, target: "chat", threadId });
  }
  if (tab === "overview") {
    return buildFrontendUrl({ baseUrl: frontendBaseUrl, target: "overview" });
  }
  if (tab === "reports") {
    return buildFrontendUrl({
      baseUrl: frontendBaseUrl,
      target: "reports",
      projectId,
      tab: "overview",
    });
  }
  if (tab === "projects") {
    return projectId
      ? buildFrontendUrl({
          baseUrl: frontendBaseUrl,
          target: "project",
          projectId,
          view: "both",
          layout: "architecture",
        })
      : buildFrontendUrl({ baseUrl: frontendBaseUrl, target: "projects" });
  }
  if (tab === "connections") {
    return buildFrontendUrl({ baseUrl: frontendBaseUrl, target: "connections" });
  }
  if (tab === "billing") {
    return buildFrontendUrl({ baseUrl: frontendBaseUrl, target: "billing", tab: "usage" });
  }
  return buildFrontendUrl({ baseUrl: frontendBaseUrl, target: "overview" });
};

const openExternalUrl = (url: string): void => {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
};

const readTerminalSize = (): TerminalSize => ({
  columns: process.stdout.columns || 100,
  rows: process.stdout.rows || 32,
});

const useTerminalSize = (): TerminalSize => {
  const [size, setSize] = useState<TerminalSize>(() => readTerminalSize());

  useEffect(() => {
    const handleResize = () => setSize(readTerminalSize());
    process.stdout.on("resize", handleResize);
    return () => {
      process.stdout.off("resize", handleResize);
    };
  }, []);

  return size;
};

const isMouseTrackingEnabled = (): boolean => {
  const value = process.env.CLOUDEVAL_TUI_MOUSE?.toLowerCase();
  return value !== "0" && value !== "false" && value !== "no";
};

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

const enableTerminalMouse = (): (() => void) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return () => {};
  }
  const enable = "\x1b[?1000h\x1b[?1006h";
  const disable = "\x1b[?1000l\x1b[?1002l\x1b[?1006l";
  process.stdout.write(enable);
  return () => {
    process.stdout.write(disable);
  };
};

type TerminalMouseEvent = {
  code: number;
  x: number;
  y: number;
  released: boolean;
};

const parseTerminalMouseEvent = (input: string): TerminalMouseEvent | null => {
  const match = /\x1b?\[<(\d+);(\d+);(\d+)([mM])/.exec(input);
  if (!match) {
    return null;
  }

  return {
    code: Number(match[1]),
    x: Number(match[2]),
    y: Number(match[3]),
    released: match[4] === "m",
  };
};

const parseMouseWheelDelta = (input: string): number | null => {
  const mouseEvent = parseTerminalMouseEvent(input);
  if (!mouseEvent) {
    return null;
  }
  const code = mouseEvent.code;
  if (code === 64) {
    return -3;
  }
  if (code === 65) {
    return 3;
  }
  return null;
};

const isTerminalMouseInput = (input: string): boolean =>
  /\x1b?\[<\d+;\d+;\d+[mM]/.test(input);

const summarizeThinkingSteps = (message?: ChatMessage): string => {
  const steps = message?.thinkingSteps ?? [];
  if (!steps.length) {
    return "none";
  }
  const completed = steps.filter((step) => step.status === "completed").length;
  const running = steps.filter((step) => step.status === "streaming").length;
  const failed = steps.filter((step) =>
    step.status === "error" || step.status === "aborted" || step.status === "cancelled"
  ).length;
  if (failed) {
    return `${failed} failed`;
  }
  if (running) {
    return `${running} running`;
  }
  return `${completed}/${steps.length}`;
};

const selectorValueText = ({
  kind,
  selectedProject,
  selectedModel,
  selectedMode,
}: {
  kind: SelectorControlKind;
  selectedProject: ProjectInfo | null;
  selectedModel: string;
  selectedMode: ChatMode;
}) => {
  if (kind === "project") {
    return selectedProject?.name ?? defaultProject.name;
  }
  if (kind === "model") {
    return selectedModel || "auto";
  }
  return selectedMode;
};

const SelectorBar: React.FC<{
  focused: TuiControlFocus;
  selectedProject: ProjectInfo | null;
  selectedModel: string;
  selectedMode: ChatMode;
  hasThinkingSteps: boolean;
  thinkingExpanded: boolean;
  thinkingSummary: string;
  compact: boolean;
  terminalColumns: number;
  apiBase: string;
  statusText: string;
  statusColor?: string;
  busy: boolean;
}> = ({
  focused,
  selectedProject,
  selectedModel,
  selectedMode,
  hasThinkingSteps,
  thinkingExpanded,
  thinkingSummary,
  compact,
  terminalColumns,
  apiBase,
  statusText,
  statusColor,
  busy,
}) => {
  const controlGap = compact ? 0 : 1;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused === "thinking" ? terminalTheme.brand : terminalTheme.muted}
      paddingX={1}
    >
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" gap={1}>
          <Text bold color={terminalTheme.brand}>CloudEval</Text>
          <Text dimColor>workspace</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          {busy ? <Spinner type="line" /> : null}
          <Text color={statusColor}>{statusText}</Text>
        </Box>
      </Box>
      <Box flexDirection={compact ? "column" : "row"} gap={controlGap} flexWrap="wrap" marginTop={1}>
        {selectorOrder.map((kind) => {
          const isFocused = focused === kind;
          const label = kind.charAt(0).toUpperCase() + kind.slice(1);
          const rawValue = selectorValueText({
            kind,
            selectedProject,
            selectedModel,
            selectedMode,
          });
          const valueLimit = compact
            ? Math.max(18, terminalColumns - label.length - 8)
            : kind === "project"
              ? 30
              : 20;
          const value = truncateForTerminal(rawValue, valueLimit);
          return (
            <Box
              key={kind}
              borderStyle="round"
              borderColor={isFocused ? terminalTheme.brand : terminalTheme.muted}
              paddingX={1}
            >
              <Text color={isFocused ? terminalTheme.brand : undefined}>
                {label}: {value} {dropdownIndicator}
              </Text>
            </Box>
          );
        })}
        {hasThinkingSteps ? (
          <Box
            borderStyle="round"
            borderColor={focused === "thinking" ? terminalTheme.brand : terminalTheme.muted}
            paddingX={1}
          >
            <Text color={focused === "thinking" ? terminalTheme.brand : undefined}>
              Reasoning: {thinkingExpanded ? "open" : thinkingSummary}
            </Text>
          </Box>
        ) : null}
      </Box>
      <Text dimColor wrap="truncate">
        {apiBase} | Tab/left/right focus | Enter open | /project /model /mode /thinking
      </Text>
    </Box>
  );
};

const QueuePanel: React.FC<{
  messages: QueuedMessage[];
  compact: boolean;
  terminalColumns: number;
}> = ({ messages, compact, terminalColumns }) => {
  const previewLimit = compact
    ? Math.max(28, terminalColumns - 18)
    : Math.min(120, Math.max(60, terminalColumns - 28));
  const visibleMessages = messages.slice(0, compact ? 2 : 3);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={terminalTheme.warning}
      paddingX={1}
      marginTop={1}
    >
      <Text bold color={terminalTheme.warning}>
        Queue ({messages.length} pending)
      </Text>
      {visibleMessages.map((message, index) => (
        <Text
          key={message.id}
          color={index === 0 ? terminalTheme.warning : undefined}
          dimColor={index > 0}
          wrap="truncate"
        >
          {index === 0 ? "Next" : `#${index + 1}`}:{" "}
          {truncateForTerminal(oneLine(message.text), previewLimit)}
        </Text>
      ))}
      {messages.length > visibleMessages.length ? (
        <Text dimColor>+{messages.length - visibleMessages.length} more queued</Text>
      ) : null}
    </Box>
  );
};

const recommendedOptionIndex = (question?: HitlQuestion): number => {
  if (!question?.options?.length) {
    return 0;
  }
  const recommendedId =
    question.recommended_option_id ??
    question.options.find((option) => option.recommended)?.id;
  const index = recommendedId
    ? question.options.findIndex((option) => option.id === recommendedId)
    : -1;
  return index >= 0 ? index : 0;
};

const isSpecifyOption = (option?: { id: string; label: string }) =>
  option?.id === "specify" || option?.label === "I'll specify";

const HitlPanel: React.FC<{
  hitl: HitlState;
  questionIndex: number;
  optionIndex: number;
  answers: Record<string, string>;
  frontendUrl: string;
}> = ({ hitl, questionIndex, optionIndex, answers, frontendUrl }) => {
  const question = hitl.questions[questionIndex] ?? hitl.questions[0];
  const options = question?.options ?? [];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={terminalTheme.warning} padding={1}>
      <Text bold color={terminalTheme.warning}>Human approval required</Text>
      <Text wrap="wrap">
        {questionIndex + 1}/{hitl.questions.length}: {question?.text ?? "Action required"}
      </Text>
      {options.length ? (
        <Box flexDirection="column" marginTop={1}>
          {options.map((option, index) => {
            const highlighted = index === optionIndex;
            const selected = answers[question.id] === option.id;
            const marker = highlighted ? "▸" : selected ? "•" : " ";
            return (
              <Text
                key={option.id}
                color={highlighted ? terminalTheme.brand : undefined}
                dimColor={!highlighted && !selected}
              >
                {marker}{" "}
                {selected ? "selected " : ""}
                {index + 1}. {option.label}
                {option.recommended ? " (recommended)" : ""}
              </Text>
            );
          })}
        </Box>
      ) : (
        <Text dimColor>Type the answer in the prompt and press Enter, or open the frontend.</Text>
      )}
      <Text dimColor>
        Up/Down choose | Enter answer | Left/Right switch question | O or /open opens frontend
      </Text>
      <Text dimColor wrap="wrap">Frontend: {frontendUrl}</Text>
    </Box>
  );
};

export const App: React.FC<AppProps> = ({
  baseUrl,
  apiKey,
  allowMachineAuth = false,
  conversationId,
  model,
  initialTab,
  initialProjectId,
  frontendUrl,
  debug = false,
  disableBanner = false,
  disableAnim = false,
  skipHealthCheck = true, // Disable health check by default
}) => {
  const { exit } = useApp();
  const [phase, setPhase] = useState<"boot" | "ready" | "error">("boot");
  const [loaderStep, setLoaderStep] = useState(0);
  const [bootError, setBootError] = useState<string | undefined>();
  const [input, setInput] = useState("");
  const [authToken, setAuthToken] = useState<string | undefined>(apiKey);
  const [chatState, setChatState] = useState<ChatState>({
    ...initialChatState,
    status: "booting",
    threadId: conversationId,
    debug,
  });
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selectedProject, setSelectedProject] = useState<ProjectInfo | null>(null);
  const [selectedModel, setSelectedModel] = useState(model ?? "");
  const [selectedMode, setSelectedMode] = useState<ChatMode>("ask");
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<WorkspaceTab>(() =>
    normalizeWorkspaceTab(initialTab)
  );
  const [workspacePanelState, setWorkspacePanelState] = useState<WorkspacePanelState>(() =>
    createWorkspacePanelState(normalizeWorkspaceTab(initialTab))
  );
  const [workspaceRefreshKey, setWorkspaceRefreshKey] = useState(0);
  const [modelItems, setModelItems] = useState<Array<SelectPanelItem<string>>>(() => {
    if (model && !fallbackModels.some((item) => item.value === model)) {
      return [{ label: model, value: model, description: "Model provided by --model." }, ...fallbackModels];
    }
    return fallbackModels;
  });
  const [activeSelector, setActiveSelector] = useState<SelectorKind>(null);
  const [selectingProject, setSelectingProject] = useState(false);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [checkingOnboarding, setCheckingOnboarding] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | undefined>();
  const [userName, setUserName] = useState<string>("You");
  const [focusedControl, setFocusedControl] = useState<TuiControlFocus>("project");
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [hitlQuestionIndex, setHitlQuestionIndex] = useState(0);
  const [hitlOptionIndex, setHitlOptionIndex] = useState(0);
  const [hitlAnswers, setHitlAnswers] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | undefined>();
  const [scrollOffset, setScrollOffset] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(20);
  const apiBase = useMemo(() => normalizeApiBase(baseUrl), [baseUrl]);
  const frontendBaseUrl = useMemo(
    () => resolveFrontendBaseUrl(apiBase, frontendUrl),
    [apiBase, frontendUrl]
  );
  const frontendThreadUrl = useMemo(
    () => buildFrontendThreadUrl(frontendBaseUrl, chatState.threadId),
    [frontendBaseUrl, chatState.threadId]
  );
  const activeProjectId = initialProjectId ?? selectedProject?.id;
  const workspaceFrontendUrl = useMemo(
    () =>
      buildWorkspaceFrontendUrl({
        tab: activeWorkspaceTab,
        frontendBaseUrl,
        threadId: chatState.threadId,
        projectId: activeProjectId,
      }),
    [activeWorkspaceTab, activeProjectId, chatState.threadId, frontendBaseUrl]
  );
  const scrollViewRef = React.useRef<ScrollViewRef>(null);
  const controllerRef = React.useRef<AbortController | null>(null);
  const queueRef = React.useRef<QueuedMessage[]>([]);
  const completionCycleRef = React.useRef<CompletionCycleState | undefined>();
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [expandedThinkingMessageIds, setExpandedThinkingMessageIds] = useState<Set<string>>(
    () => new Set()
  );
  const autoExpandedThinkingMessageIdsRef = React.useRef<Set<string>>(new Set());
  const suppressNextAutoScrollRef = React.useRef(false);

  // New Search State
  const [isSearching, setIsSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const terminalSize = useTerminalSize();
  const mouseTrackingEnabled = isMouseTrackingEnabled();

  const checkHealth = useMemo(() => {
    return async (token?: string) => {
      try {
        const headers: Record<string, string> = {
          "X-Client-Type": "cloudeval-cli",
          "X-Client-Version": CLI_VERSION,
        };
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }
        const healthUrl = `${apiBase}/chat/health`;
        const res = await fetch(healthUrl, {
          method: "GET",
          headers,
        });

        if (!res.ok) {
          console.warn(`Health check failed: ${res.status} ${res.statusText} at ${healthUrl}`);
          return false;
        }

        const json = await res.json();
        return json?.status === "healthy" || json?.status === "ok";
      } catch (error: any) {
        console.warn(`Health check error: ${error.message || error} at ${apiBase}/chat/health`);
        return false;
      }
    };
  }, [apiBase]);

  const promptCompletionContext = useMemo(
    () => ({
      projects: projects.length
        ? projects
        : selectedProject
          ? [selectedProject]
          : [defaultProject],
      models: modelItems,
      modes: modeItems,
    }),
    [modelItems, projects, selectedProject]
  );

  const selectProjectForUser = async (
    token: string,
    user: { id: string; email?: string; full_name?: string; name?: string }
  ) => {
    setLoadingProjects(true);
    try {
      const fetchedProjects = await getProjects(baseUrl, token, user.id);
      const requestedProject = initialProjectId
        ? fetchedProjects.find((project: ProjectInfo) => project.id === initialProjectId)
        : undefined;
      const playgroundProject = fetchedProjects.find(
        (project: ProjectInfo) => project.name === "Playground"
      );
      const preferredProject =
        requestedProject ??
        playgroundProject ??
        (user.email
          ? await ensurePlaygroundProject(baseUrl, token, user)
          : fetchedProjects[0]);

      if (!preferredProject) {
        throw new Error("No project is available for this account.");
      }

      const nextProjects = fetchedProjects.some(
        (project: ProjectInfo) => project.id === preferredProject.id
      )
        ? fetchedProjects
        : [preferredProject, ...fetchedProjects];

      setProjects(nextProjects);
      setSelectedProject(preferredProject);
      setSelectingProject(false);
      return preferredProject;
    } finally {
      setLoadingProjects(false);
    }
  };

  const refreshAuthenticatedWorkspace = async (token: string) => {
    const userStatus = await checkUserStatus(baseUrl, token);
    if (userStatus.user) {
      setUserName(getFirstNameForDisplay(userStatus.user));
    }
    if (userStatus.user?.id) {
      setCurrentUserId(userStatus.user.id);
      await selectProjectForUser(token, userStatus.user);
    }
    return userStatus;
  };

  useEffect(() => {
    return () => {
      controllerRef.current?.abort("App unmounted");
    };
  }, []);

  useEffect(() => {
    if (phase !== "ready") {
      return;
    }
    if (!mouseTrackingEnabled) {
      return;
    }
    return enableTerminalMouse();
  }, [mouseTrackingEnabled, phase]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setChatState((prev) => ({ ...prev, status: "booting" }));
      // Step 0: load config
      setLoaderStep(0);
      await delay(150);
      if (cancelled) return;

      // Step 1: validate auth / fetch token
      setLoaderStep(1);
      let token: string | undefined = authToken ?? apiKey;
      if (!token) {
        try {
          token = await getAuthToken({ apiKey, baseUrl, allowMachineAuth });
          if (cancelled) return;
          setAuthToken(token);
        } catch (error: any) {
          // If no API key and no stored token, automatically trigger login
          if (
            !apiKey &&
            !allowMachineAuth &&
            error?.message?.includes("No authentication available")
          ) {
            setIsLoggingIn(true);
            setLoaderStep(1);
            try {
              const { login } = await import("@cloudeval/core");
              const newToken = await login(baseUrl, {
                headless: Boolean(process.env.SSH_TTY || process.env.CI),
              });
              if (cancelled) return;
              setAuthToken(newToken);
              setIsLoggingIn(false);
              token = newToken;
            } catch (loginError: any) {
              setIsLoggingIn(false);
              setBootError(loginError?.message ?? "Login failed");
              setPhase("error");
              return;
            }
          } else {
            setBootError(error?.message ?? "Authentication failed");
            setPhase("error");
            return;
          }
        }
      }

      if (token && token !== authToken) {
        setAuthToken(token);
      }

      // Extract userName from token
      if (token && !apiKey && !allowMachineAuth) {
        getUserNameFromToken(token).then(setUserName).catch(() => {
          // Fallback to default if extraction fails
          setUserName("You");
        });
      }

      // Step 1.5: Check onboarding status and fetch projects (only if not using API key)
      if (!apiKey && !allowMachineAuth && token) {
        setCheckingOnboarding(true);
        try {
          const userStatus = await refreshAuthenticatedWorkspace(token);
          if (!userStatus.onboardingCompleted) {
            setNeedsOnboarding(true);
            setPhase("ready"); // Show onboarding UI
            setCheckingOnboarding(false);
            return;
          }
          try {
            const modelsResponse = await fetch(`${apiBase}/models`, {
              method: "GET",
              headers: {
                "X-Client-Type": "cloudeval-cli",
                "X-Client-Version": CLI_VERSION,
                Authorization: `Bearer ${token}`,
              },
            });
            if (modelsResponse.ok) {
              const rawModels = await modelsResponse.json();
              const items = normalizeModelItems(rawModels);
              if (items.length > 0) {
                setModelItems(mergeModelItems(items, model));
                if (!model && items.some((item) => item.value === "gpt-5-nano")) {
                  setSelectedModel("gpt-5-nano");
                }
              }
            }
          } catch {
            // Model catalog is optional; fallback list remains usable.
          }
        } catch (error) {
          // If check fails, continue anyway (backward compat)
          console.warn("Onboarding/projects check failed, continuing:", error);
          setSelectedProject(defaultProject);
          setSelectingProject(false);
        }
        setCheckingOnboarding(false);
        setLoadingProjects(false);
      } else {
        // Using API key, use default project
        setSelectedProject(defaultProject);
        setSelectingProject(false);
      }

      // Step 2: health check with token (unless skipped)
      setLoaderStep(2);
      if (!skipHealthCheck) {
        const healthy = await checkHealth(token);
        if (!healthy) {
          setBootError(
            `Backend health check failed. Is the backend running at ${apiBase}?`
          );
          setPhase("error");
          return;
        }
      }

      // Step 3: ready
      setLoaderStep(3);
      await delay(100);
      if (cancelled) return;
      setPhase("ready");
      setChatState((prev) => ({ ...prev, status: "idle" }));
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [
    checkHealth,
    baseUrl,
    apiKey,
    allowMachineAuth,
    skipHealthCheck,
    apiBase,
  ]);

  useEffect(() => {
    let cancelled = false;
    const tab = activeWorkspaceTab;

    if (phase !== "ready") {
      return;
    }

    if (tab === "chat") {
      setWorkspacePanelState(createWorkspacePanelState(tab, "ready"));
      return;
    }

    const load = async () => {
      if (tab === "projects" || tab === "options") {
        setWorkspacePanelState({
          ...createWorkspacePanelState(tab, "ready"),
          loadedAt: Date.now(),
        });
        return;
      }

      if (!authToken) {
        setWorkspacePanelState({
          ...createWorkspacePanelState(tab, "error"),
          error: "Authentication is required to load this tab.",
        });
        return;
      }

      setWorkspacePanelState(createWorkspacePanelState(tab, "loading"));

      const data: Record<string, unknown> = {};
      const warnings: string[] = [];
      const client = { baseUrl: apiBase, authToken };
      const capture = async <T,>(
        key: string,
        label: string,
        loader: () => Promise<T>
      ) => {
        try {
          data[key] = await loader();
        } catch (error: any) {
          warnings.push(`${label}: ${error?.message ?? "request failed"}`);
        }
      };

      if (tab === "overview" || tab === "connections") {
        if (currentUserId) {
          await capture("connections", "Connections", () =>
            listConnections({ ...client, userId: currentUserId })
          );
        } else {
          warnings.push("Connections: user id was not returned by auth status.");
        }
      }

      if (tab === "overview") {
        if (currentUserId) {
          await capture("dashboard", "Dashboard overview", () =>
            fetchReportResource(client, `/dashboard/user/${encodeURIComponent(currentUserId)}`, {
              include_historical: "true",
              days: "30",
            })
          );
        } else {
          warnings.push("Dashboard overview: user id was not returned by auth status.");
        }
      }

      if (tab === "overview" || tab === "reports") {
        if (currentUserId) {
          await capture("reportsSummary", "Reports summary", () =>
            fetchReportResource(client, "/reports/summary", {
              user_id: currentUserId,
            })
          );
        } else {
          warnings.push("Reports summary: user id was not returned by auth status.");
        }
      }

      if (tab === "reports") {
        if (activeProjectId) {
          await capture("costReport", "Cost report", () =>
            getCostReportFull({ ...client, projectId: activeProjectId, userId: currentUserId })
          );
          await capture("wafReport", "Well-Architected report", () =>
            getWafReportFull({ ...client, projectId: activeProjectId, userId: currentUserId })
          );
        } else {
          warnings.push("Reports: select a project before loading full report payloads.");
        }
      }

      if (tab === "overview" || tab === "billing") {
        await capture("entitlement", "Billing entitlement", () => getBillingEntitlement(client));
        if (data.entitlement) {
          data.creditStatus = getCreditStatus(data.entitlement as any);
        }
      }

      if (tab === "billing") {
        const range = thirtyDayUsageRange();
        await capture("usageSummary", "Billing usage summary", () =>
          getBillingUsageSummary({
            ...client,
            startAt: range.startAt,
            endAt: range.endAt,
            granularity: "day",
          })
        );
        await capture("ledger", "Billing ledger", () =>
          getBillingUsageLedger({
            ...client,
            startAt: range.startAt,
            endAt: range.endAt,
            limit: 12,
          })
        );
        await capture("billingInfo", "Billing info", () =>
          getSubscriptionBillingInfo({ ...client, limit: 12 })
        );
        await capture("topups", "Top-ups", () => getTopUpPacks(client));
        await capture("notifications", "Billing notifications", () =>
          getBillingNotifications({ ...client, limit: 8 })
        );
      }

      if (!cancelled) {
        setWorkspacePanelState({
          tab,
          status: warnings.length && !Object.keys(data).length ? "error" : "ready",
          data,
          warnings,
          error:
            warnings.length && !Object.keys(data).length
              ? "No dashboard data could be loaded from the backend."
              : undefined,
          loadedAt: Date.now(),
        });
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [
    activeProjectId,
    activeWorkspaceTab,
    apiBase,
    authToken,
    currentUserId,
    phase,
    workspaceRefreshKey,
  ]);

  const displayedMessages = useMemo(() => {
    if (!isSearching || !searchQuery) return chatState.messages;
    return chatState.messages.filter(m => {
        const content = m.content || "";
        return content.toLowerCase().includes(searchQuery.toLowerCase());
    });
  }, [chatState.messages, isSearching, searchQuery]);

  useEffect(() => {
    const messagesWithThinking = chatState.messages.filter(
      (message) => message.role === "assistant" && message.thinkingSteps?.length
    );
    if (!messagesWithThinking.length) {
      return;
    }

    setExpandedThinkingMessageIds((current) => {
      let changed = false;
      const next = new Set(current);
      for (const message of messagesWithThinking) {
        if (message.pending && !autoExpandedThinkingMessageIdsRef.current.has(message.id)) {
          autoExpandedThinkingMessageIdsRef.current.add(message.id);
          next.add(message.id);
          changed = true;
        }
        if (!message.pending && autoExpandedThinkingMessageIdsRef.current.has(message.id)) {
          autoExpandedThinkingMessageIdsRef.current.delete(message.id);
          if (next.delete(message.id)) {
            changed = true;
          }
        }
      }
      return changed ? next : current;
    });
  }, [chatState.messages]);

  useEffect(() => {
    if (!chatState.hitl?.waiting) {
      setHitlAnswers({});
      setHitlQuestionIndex(0);
      setHitlOptionIndex(0);
      return;
    }
    setHitlQuestionIndex(0);
    setHitlOptionIndex(recommendedOptionIndex(chatState.hitl.questions[0]));
  }, [chatState.hitl?.messageId]);

  useEffect(() => {
    if (!chatState.hitl?.waiting) {
      return;
    }
    setHitlOptionIndex(
      recommendedOptionIndex(chatState.hitl.questions[hitlQuestionIndex])
    );
  }, [chatState.hitl?.messageId, hitlQuestionIndex]);

  const syncQueueState = () => {
    setQueuedMessages([...queueRef.current]);
  };

  const appendUserMessage = (
    content: string,
    options?: { id?: string; queued?: boolean }
  ): ChatMessage => {
    const message: ChatMessage = {
      id: options?.id ?? randomUUID(),
      role: "user",
      content,
      queued: options?.queued,
      createdAt: Date.now(),
    };
    setChatState((prev) => ({
      ...prev,
      messages: [...prev.messages, message],
    }));
    return message;
  };

  const handleOpenFrontend = () => {
    try {
      openExternalUrl(frontendThreadUrl);
      setNotice(`Frontend link: ${frontendThreadUrl}`);
    } catch (error: any) {
      setNotice(`Open frontend manually: ${frontendThreadUrl}`);
    }
  };

  const handleOpenWorkspaceFrontend = () => {
    try {
      openExternalUrl(workspaceFrontendUrl);
      setNotice(`Frontend link: ${workspaceFrontendUrl}`);
    } catch (error: any) {
      setNotice(`Open frontend manually: ${workspaceFrontendUrl}`);
    }
  };

  const toggleLatestThinking = () => {
    const latestWithSteps = [...chatState.messages]
      .reverse()
      .find((message) => message.role === "assistant" && message.thinkingSteps?.length);
    if (!latestWithSteps) {
      return;
    }
    suppressNextAutoScrollRef.current = true;
    setExpandedThinkingMessageIds((current) => {
      const next = new Set(current);
      if (next.has(latestWithSteps.id)) {
        next.delete(latestWithSteps.id);
      } else {
        next.add(latestWithSteps.id);
      }
      return next;
    });
  };

  const enqueueMessage = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const queued: QueuedMessage = { id: randomUUID(), text: trimmed };
    queueRef.current.push(queued);
    syncQueueState();
    appendUserMessage(trimmed, { id: queued.id, queued: true });
    setNotice(undefined);
  };

  const submitHitlAnswer = (answer: string) => {
    const hitl = chatState.hitl;
    if (!hitl?.waiting || !hitl.questions.length) {
      return;
    }

    const currentQuestion =
      hitl.questions[hitlQuestionIndex] ?? hitl.questions[0];
    if (!currentQuestion) {
      return;
    }

    const nextAnswers = {
      ...hitlAnswers,
      [currentQuestion.id]: answer,
    };
    const nextUnansweredIndex = hitl.questions.findIndex(
      (question) => !nextAnswers[question.id]
    );

    if (nextUnansweredIndex >= 0) {
      setHitlAnswers(nextAnswers);
      setHitlQuestionIndex(nextUnansweredIndex);
      return;
    }

    const responses: HitlResponse[] = hitl.questions
      .map((question) => ({
        question_id: question.id,
        answer: nextAnswers[question.id],
      }))
      .filter((response) => response.answer.trim().length > 0);

    const checkpointId = hitl.checkpointId ?? chatState.threadId;
    if (!checkpointId || responses.length === 0) {
      setNotice(`Cannot resume from CLI yet. Open frontend: ${frontendThreadUrl}`);
      return;
    }

    setHitlAnswers({});
    setInput("");
    setNotice(undefined);
    void sendMessage("", {
      hitlResume: {
        checkpointId,
        responses,
        runId: hitl.runId,
        langsmithTraceId: hitl.langsmithTraceId,
      },
      resumeMessageId: hitl.messageId,
      hitlQuestions: hitl.questions,
    });
  };

  const submitHighlightedHitlOption = () => {
    const hitl = chatState.hitl;
    const question = hitl?.questions[hitlQuestionIndex] ?? hitl?.questions[0];
    if (!hitl?.waiting || !question) {
      return;
    }

    const option = question.options?.[hitlOptionIndex];
    if (!option) {
      return;
    }

    const customText = input.trim();
    const answer = isSpecifyOption(option) && customText ? customText : option.id;
    submitHitlAnswer(answer);
  };

  const handlePromptSubmit = (value: string) => {
    const cleanedValue = sanitizeTerminalInput(value);
    const promptCommand = resolvePromptCommand(cleanedValue, promptCompletionContext);
    if (promptCommand) {
      setInput("");
      completionCycleRef.current = undefined;
      switch (promptCommand.type) {
        case "openSelector":
          setActiveSelector(promptCommand.selector);
          return;
        case "setProject":
          setSelectedProject(promptCommand.project);
          setNotice(`Project selected: ${promptCommand.project.name}`);
          return;
        case "setModel":
          setSelectedModel(promptCommand.model);
          setNotice(`Model selected: ${promptCommand.label}`);
          return;
        case "setMode":
          setSelectedMode(promptCommand.mode);
          setNotice(`Mode selected: ${promptCommand.label}`);
          return;
        case "toggleThinking":
          toggleLatestThinking();
          return;
        case "openFrontend":
          handleOpenFrontend();
          return;
        case "showHelp":
          setNotice(commandHelpText());
          return;
        case "unknown":
          setNotice(promptCommand.message);
          return;
      }
    }

    if (chatState.status === "hitl_waiting" && chatState.hitl?.waiting) {
      setInput("");
      if (cleanedValue.trim()) {
        submitHitlAnswer(cleanedValue.trim());
      } else {
        submitHighlightedHitlOption();
      }
      return;
    }

    setInput("");
    setActiveSelector(null);
    if (isBusyStatus(chatState.status) || controllerRef.current) {
      enqueueMessage(cleanedValue);
      return;
    }
    void sendMessage(cleanedValue);
  };

  const handlePromptChange = (value: string) => {
    const cleanedValue = sanitizeTerminalInput(value);
    completionCycleRef.current = undefined;
    setInput(cleanedValue);
  };

  const dequeueAndSend = () => {
    const next = queueRef.current.shift();
    syncQueueState();
    if (!next) {
      return;
    }
    setNotice(`Sending queued message: ${truncateForTerminal(oneLine(next.text), 90)}`);
    void sendMessage(next.text, { queuedMessageId: next.id });
  };

  const sendMessage = async (text: string, options: SendMessageOptions = {}) => {
    const trimmed = text.trim();
    if (!trimmed && !options.hitlResume) return;

    let token = authToken ?? apiKey;
    if (!token) {
      try {
        token = await getAuthToken({ apiKey, baseUrl, allowMachineAuth });
        setAuthToken(token);
      } catch (error: any) {
        setChatState((prev) => ({
          ...prev,
          status: "error",
          error: error?.message ?? "Authentication failed",
        }));
        return;
      }
    }

    const threadId = chatState.threadId ?? randomUUID();
    const now = Date.now();
    const userMessage: ChatMessage | undefined =
      options.hitlResume || options.queuedMessageId
        ? undefined
        : {
            id: randomUUID(),
            role: "user",
            content: trimmed,
            createdAt: now,
          };

    setChatState((prev) => ({
      ...prev,
      threadId,
      status: "connecting",
      activeMessageId: options.resumeMessageId,
      followUpScratch: undefined,
      hitl: options.hitlResume ? undefined : prev.hitl,
      error: undefined,
      messages: prev.messages.map((m) =>
        m.id === options.queuedMessageId
          ? { ...m, queued: false, updatedAt: now }
          : m.id === options.resumeMessageId
            ? {
                ...m,
                pending: true,
                error: undefined,
                hitlQuestionsAnswered: options.hitlQuestions
                  ? {
                      questions: options.hitlQuestions,
                      answers: options.hitlResume?.responses ?? [],
                    }
                  : m.hitlQuestionsAnswered,
                updatedAt: now,
              }
            : m.role === "assistant" && m.pending && !options.hitlResume
              ? { ...m, pending: false, updatedAt: now }
              : m
      ).concat(userMessage ? [userMessage] : []),
    }));

    const ctrl = new AbortController();
    controllerRef.current = ctrl;
    let shouldDrainQueue = false;

    try {
      // Use requestAnimationFrame to batch updates and prevent line breaks
      let pendingChunks: Chunk[] = [];
      let rafId: number | null = null;
      let lastUpdateTime = Date.now();
      let sawHitlRequest = false;

      const flushChunks = (immediate = false) => {
        if (pendingChunks.length === 0) {
          rafId = null;
          return;
        }

        const chunksToProcess = [...pendingChunks];
        pendingChunks = [];
        rafId = null;
        lastUpdateTime = Date.now();

        const applyChunks = () => {
          setChatState((prev) => {
            let state = prev;
            for (const chunk of chunksToProcess) {
              state = reduceChunk(state, chunk);
            }
            return state;
          });
        };

        if (immediate) {
          applyChunks();
        } else {
          // Use startTransition to defer state updates and prevent blocking renders
          startTransition(applyChunks);
        }
      };

      const scheduleFlush = () => {
        if (rafId !== null) return;

        // CRITICAL: Batch updates very aggressively to prevent line breaks
        // Update every 500ms or when we have 20+ chunks, whichever comes first
        // Much longer interval = much fewer re-renders = no new lines in terminal
        const timeSinceLastUpdate = Date.now() - lastUpdateTime;
        const minInterval = 500; // 500ms = 2fps - minimizes re-renders

        if (timeSinceLastUpdate >= minInterval || pendingChunks.length >= 20) {
          flushChunks();
        } else {
          rafId = setTimeout(flushChunks, minInterval - timeSinceLastUpdate) as unknown as number;
        }
      };

      for await (const chunk of streamChat({
        baseUrl,
        authToken: token,
        message: options.hitlResume ? "" : trimmed,
        threadId,
        user: {
          id: selectedProject?.user_id ?? currentUserId ?? defaultUser.id,
          name: userName,
        },
        project:
          selectedProject ??
          (currentUserId ? { ...defaultProject, user_id: currentUserId } : defaultProject),
        settings: {
          ...(selectedModel ? { model: selectedModel } : {}),
          mode: selectedMode,
        },
        streamingMode: debug ? "DEBUG" : "USER",
        signal: ctrl.signal,
        debug,
        hitlResume: options.hitlResume,
        completeAfterResponse: true,
        responseCompletionGraceMs: 5000,
      })) {
        if (chunk.type === "hitl_request") {
          sawHitlRequest = true;
          pendingChunks.push(chunk);
          if (rafId !== null) {
            clearTimeout(rafId);
            rafId = null;
          }
          flushChunks(true);
          break;
        }
        pendingChunks.push(chunk);
        scheduleFlush();
      }

      // Flush any remaining chunks immediately
      if (rafId !== null) {
        clearTimeout(rafId);
      }
      flushChunks();

      if (sawHitlRequest) {
        setNotice(`Action required. Answer in CLI or open frontend: ${frontendThreadUrl}`);
      } else {
        shouldDrainQueue = true;
        setChatState((prev) => completeActiveAssistantMessage(prev));
      }
    } catch (error: any) {
      const isAbort =
        ctrl.signal.aborted ||
        error?.name === "AbortError" ||
        error?.message === "This operation was aborted";

      if (isAbort) {
        if (controllerRef.current === ctrl || controllerRef.current === null) {
          setChatState((prev) => ({
            ...prev,
            status: "canceled",
            hitl: undefined,
            messages: prev.messages.map((message) =>
              message.role === "assistant" && message.pending
                ? { ...message, pending: false, updatedAt: Date.now() }
                : message
            ),
          }));
        }
        return;
      }

      setChatState((prev) => ({
        ...prev,
        status: "error",
        error: error?.message ?? "Streaming failed",
        messages: prev.messages.map((message) =>
          message.role === "assistant" && message.pending
            ? { ...message, pending: false, updatedAt: Date.now() }
            : message
        ),
      }));
    } finally {
      if (controllerRef.current === ctrl) {
        controllerRef.current = null;
      }
      if (shouldDrainQueue && queueRef.current.length > 0) {
        setTimeout(dequeueAndSend, 0);
      }
    }
  };

  const latestAssistant = [...chatState.messages]
    .reverse()
    .find((m) => m.role === "assistant");
  const streamingSteps =
    latestAssistant?.thinkingSteps?.filter(
      (s) => (s.status ?? "streaming") === "streaming"
    ) ?? [];
  const latestErroredMessage = [...chatState.messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.error);
  const errorText = chatState.error ?? latestErroredMessage?.error;
  const latestThinkingMessage = [...chatState.messages]
    .reverse()
    .find((m) => m.role === "assistant" && Boolean(m.thinkingSteps?.length));
  const hasThinkingSteps = Boolean(latestThinkingMessage);
  const latestFollowUps = latestAssistant?.followUpQuestions?.filter(Boolean) ?? [];
  const promptSuggestions = getPromptSuggestions({
    latestFollowUps,
    messages: chatState.messages,
    mode: selectedMode,
    project: selectedProject,
  });
  const visiblePromptSuggestions = promptSuggestions.prompts;
  const focusedFollowUpIndex = focusFollowUpIndex(focusedControl);
  const controlFocusOrder = buildControlFocusOrder({
    hasThinkingSteps,
    followUpCount: visiblePromptSuggestions.length,
  });
  const thinkingExpanded = latestThinkingMessage
    ? expandedThinkingMessageIds.has(latestThinkingMessage.id)
    : false;
  const thinkingSummary = summarizeThinkingSteps(latestThinkingMessage);
  const bannerDisabledByConfig = disableBanner || Boolean(process.env.CLOUDEVAL_NO_BANNER);
  const tuiLayout = getResponsiveTuiLayout(terminalSize, {
    disableBanner: bannerDisabledByConfig,
    hasQueue: queuedMessages.length > 0,
    hasError: Boolean(errorText),
    hasHitl: chatState.status === "hitl_waiting" && Boolean(chatState.hitl?.waiting),
    hasSelector: Boolean(activeSelector),
    isSearching,
  });
  const bannerDisabled = bannerDisabledByConfig || !tuiLayout.showBanner;
  const bannerVariant = terminalSize.columns >= 96 ? "full" : "compact";
  const scrollHelp = mouseTrackingEnabled
    ? "Mouse: click tabs/toolbar/follow-ups | wheel scroll | Ctrl+up/down"
    : "Scroll: Ctrl+up/down";
  const threadContentWidth = Math.max(
    24,
    terminalSize.columns - tuiLayout.paddingX * 2 - 8
  );
  const activeWorkspacePanelState =
    workspacePanelState.tab === activeWorkspaceTab
      ? workspacePanelState
      : createWorkspacePanelState(activeWorkspaceTab, "loading");
  const workspaceTabHitAreas = useMemo(
    () => getWorkspaceTabHitAreas({ startColumn: tuiLayout.paddingX + 1, gap: 1 }),
    [tuiLayout.paddingX]
  );
  const workspaceTabRowCount = useMemo(() => {
    const first = workspaceTabHitAreas[0];
    const last = workspaceTabHitAreas[workspaceTabHitAreas.length - 1];
    if (!first || !last) {
      return 1;
    }
    const projectedWidth = last.endColumn - first.startColumn + 1;
    const visibleWidth = Math.max(1, terminalSize.columns - tuiLayout.paddingX * 2);
    return Math.max(1, Math.ceil(projectedWidth / visibleWidth));
  }, [terminalSize.columns, tuiLayout.paddingX, workspaceTabHitAreas]);
  const selectorControlStartRow = useMemo(() => {
    const contentStartRow = 2;
    const bannerRows = bannerDisabled ? 0 : bannerVariant === "full" ? 9 : 8;
    const gapAfterBanner = bannerDisabled ? 0 : 1;
    const tabBarRows = workspaceTabRowCount * 3 + 1;
    const gapAfterTabs = 1;
    const selectorRowsBeforeControls = 3;
    return (
      contentStartRow +
      bannerRows +
      gapAfterBanner +
      tabBarRows +
      gapAfterTabs +
      selectorRowsBeforeControls
    );
  }, [bannerDisabled, bannerVariant, workspaceTabRowCount]);
  const selectorControlHitAreas = useMemo(
    () =>
      getSelectorControlHitAreas({
        compact: tuiLayout.compact,
        hasThinkingSteps,
        startColumn: tuiLayout.paddingX + 1,
        startRow: selectorControlStartRow,
        terminalColumns: terminalSize.columns,
      }),
    [
      hasThinkingSteps,
      selectorControlStartRow,
      terminalSize.columns,
      tuiLayout.compact,
      tuiLayout.paddingX,
    ]
  );

  useEffect(() => {
    setFocusedControl((current) =>
      controlFocusOrder.includes(current)
        ? current
        : controlFocusOrder[0] ?? "project"
    );
  }, [controlFocusOrder.join("|")]);

  const submitFollowUp = (index: number) => {
    const question = visiblePromptSuggestions[index];
    if (!question) {
      return;
    }
    setInput("");
    completionCycleRef.current = undefined;
    const noticePrefix = promptSuggestions.kind === "starter" ? "Starter" : "Follow-up";
    setNotice(`${noticePrefix} queued: ${truncateForTerminal(oneLine(question), 90)}`);
    if (isBusyStatus(chatState.status) || controllerRef.current) {
      enqueueMessage(question);
      return;
    }
    void sendMessage(question);
  };

  const handleFocusedControlEnter = () => {
    if (isSelectorControlFocus(focusedControl)) {
      setActiveSelector(focusedControl);
      return;
    }
    if (focusedControl === "thinking") {
      toggleLatestThinking();
      return;
    }
    const followUpIndex = focusFollowUpIndex(focusedControl);
    if (followUpIndex !== undefined) {
      submitFollowUp(followUpIndex);
    }
  };

  const handleMouseClick = (mouseEvent: TerminalMouseEvent) => {
    if (mouseEvent.released || mouseEvent.code !== 0) {
      return;
    }

    const tabClickMaxY = Math.max(1, selectorControlStartRow - 5);
    const clickedTab =
      mouseEvent.y <= tabClickMaxY
        ? workspaceTabFromColumn(mouseEvent.x, workspaceTabHitAreas)
        : undefined;
    if (clickedTab) {
      setActiveWorkspaceTab(clickedTab);
      setActiveSelector(null);
      setNotice(undefined);
      return;
    }

    if (activeWorkspaceTab === "chat" && !isSearching) {
      const clickedSelector = selectorControlFromMousePosition(
        { x: mouseEvent.x, y: mouseEvent.y },
        selectorControlHitAreas
      );
      if (clickedSelector === "thinking") {
        setFocusedControl("thinking");
        toggleLatestThinking();
        return;
      }
      if (clickedSelector) {
        setFocusedControl(clickedSelector);
        setActiveSelector(clickedSelector);
        setNotice(undefined);
        return;
      }
    }

    if (!visiblePromptSuggestions.length) {
      return;
    }
    const promptAreaTop = Math.max(1, terminalSize.rows - (visiblePromptSuggestions.length ? 8 : 5));
    if (mouseEvent.y < promptAreaTop) {
      return;
    }
    const buttonWidth = Math.max(16, Math.floor(terminalSize.columns / visiblePromptSuggestions.length));
    const index = Math.min(
      visiblePromptSuggestions.length - 1,
      Math.max(0, Math.floor((mouseEvent.x - 1) / buttonWidth))
    );
    setFocusedControl(`followup:${index}`);
    submitFollowUp(index);
  };

  useInput(
    (inputKey, key) => {
       // Global keys
       if (key.ctrl && inputKey.toLowerCase() === "c") {
          if (chatState.status === "streaming" || chatState.status === "thinking" || chatState.status === "connecting") {
              if (controllerRef.current) {
                  controllerRef.current.abort("Cancelled by user");
                  setChatState((prev) => ({ ...prev, status: "canceled", hitl: undefined }));
                  return; // Don't exit
              }
          }
          // Otherwise exit (handled by default process behavior, but ink captures it sometimes)
          exit();
          return;
       }

       if (isTerminalMouseInput(inputKey)) {
         const mouseWheelDelta = parseMouseWheelDelta(inputKey);
         if (mouseWheelDelta !== null) {
           scrollViewRef.current?.scrollBy(mouseWheelDelta);
         } else {
           const mouseEvent = parseTerminalMouseEvent(inputKey);
           if (mouseEvent) {
             handleMouseClick(mouseEvent);
           }
         }
         setInput((current) => sanitizeTerminalInput(current));
         return;
       }

       const lowerInput = inputKey.toLowerCase();

       if (phase === "ready" && !input.trim()) {
         const shortcutTab = workspaceTabFromShortcut(inputKey);
         if (shortcutTab) {
           setActiveWorkspaceTab(shortcutTab);
           setActiveSelector(null);
           setNotice(undefined);
           return;
         }
       }

       if (phase === "ready" && key.ctrl && lowerInput === "t") {
         setActiveWorkspaceTab((current) => nextWorkspaceTab(current));
         setActiveSelector(null);
         setNotice(undefined);
         return;
       }

       if (phase === "ready" && activeWorkspaceTab !== "chat") {
         if (key.ctrl && lowerInput === "q") {
           exit();
           return;
         }
         if (key.leftArrow && !key.ctrl && !key.meta) {
           setActiveWorkspaceTab((current) => nextWorkspaceTab(current, -1));
           setNotice(undefined);
           return;
         }
         if ((key.rightArrow || key.tab || inputKey === "\t") && !key.ctrl && !key.meta) {
           setActiveWorkspaceTab((current) => nextWorkspaceTab(current));
           setNotice(undefined);
           return;
         }
         if (lowerInput === "r") {
           setWorkspaceRefreshKey((current) => current + 1);
           setNotice(`Refreshing ${activeWorkspaceTab} data`);
           return;
         }
         if (lowerInput === "o") {
           handleOpenWorkspaceFrontend();
           return;
         }
         if (lowerInput === "c") {
           setActiveWorkspaceTab("chat");
           setNotice(undefined);
           return;
         }
         return;
       }

       // Toggle search
       if (key.ctrl && lowerInput === "r") {
           setIsSearching(prev => !prev);
           setSearchQuery("");
           return;
       }

       if (isSearching) {
           if (key.escape) {
               setIsSearching(false);
               setSearchQuery("");
           }
           return;
       }

       if (activeSelector) {
         return;
       }

       if ((key.tab || inputKey === "\t") && input.trimStart().startsWith("/")) {
         const completion = completePromptInput(
           input,
           promptCompletionContext,
           completionCycleRef.current
         );
         if (completion) {
           completionCycleRef.current = {
             source: completion.source,
             index: completion.index,
           };
           setInput(completion.value);
           setNotice(commandNotice(completion.candidates));
         } else {
           completionCycleRef.current = undefined;
           setNotice("No completions available for current input.");
         }
         return;
       }

       if (chatState.status === "hitl_waiting" && chatState.hitl?.waiting) {
         const hitl = chatState.hitl;
         const question = hitl.questions[hitlQuestionIndex] ?? hitl.questions[0];
         const optionCount = question?.options?.length ?? 0;

         if (inputKey.toLowerCase() === "o") {
           handleOpenFrontend();
           return;
         }
         if (key.leftArrow && hitl.questions.length > 1) {
           setHitlQuestionIndex((current) =>
             current === 0 ? hitl.questions.length - 1 : current - 1
           );
           return;
         }
         if (key.rightArrow && hitl.questions.length > 1) {
           setHitlQuestionIndex((current) => (current + 1) % hitl.questions.length);
           return;
         }
         if (key.upArrow && optionCount > 0) {
           setHitlOptionIndex((current) =>
             current === 0 ? optionCount - 1 : current - 1
           );
           return;
         }
         if (key.downArrow && optionCount > 0) {
           setHitlOptionIndex((current) => (current + 1) % optionCount);
           return;
         }
         if (key.return && !input.trim()) {
           submitHighlightedHitlOption();
           return;
         }
       }

       if (phase === "ready" && !input.trim()) {
         if (key.tab || inputKey === "\t") {
           setFocusedControl((current) => nextControlFocus(current, controlFocusOrder));
           return;
         }
         if (key.leftArrow && !key.ctrl && !key.meta) {
           setFocusedControl((current) => nextControlFocus(current, controlFocusOrder, -1));
           return;
         }
         if (key.rightArrow && !key.ctrl && !key.meta) {
           setFocusedControl((current) => nextControlFocus(current, controlFocusOrder));
           return;
         }
         if (key.return) {
           handleFocusedControlEnter();
           return;
         }
       }

       // Scroll controls - use Ctrl+Arrow to work even when input is focused
       // Also support Page Up/Down and Ctrl+H/E for top/bottom
       if (phase === "ready") {
         // Ctrl+Arrow keys work even when input is focused
         if (key.ctrl && key.upArrow) {
           scrollViewRef.current?.scrollBy(-1);
           return;
         }
         if (key.ctrl && key.downArrow) {
           scrollViewRef.current?.scrollBy(1);
           return;
         }
         // Plain arrows scroll only when the prompt is empty, so text editing stays predictable.
         if (!input.trim() && key.upArrow && !key.ctrl && !key.meta && !key.shift) {
           scrollViewRef.current?.scrollBy(-1);
           return;
         }
         if (!input.trim() && key.downArrow && !key.ctrl && !key.meta && !key.shift) {
           scrollViewRef.current?.scrollBy(1);
           return;
         }
         // Page Up/Down
         if (key.pageUp && !key.ctrl && !key.meta) {
           scrollViewRef.current?.scrollBy(-Math.max(1, Math.floor(viewportHeight * 0.8)));
           return;
         }
         if (key.pageDown && !key.ctrl && !key.meta) {
           scrollViewRef.current?.scrollBy(Math.max(1, Math.floor(viewportHeight * 0.8)));
           return;
         }
         // Scroll to top/bottom with Ctrl+H (home) and Ctrl+E (end)
         if (key.ctrl && inputKey.toLowerCase() === "h" && inputKey.toLowerCase() !== "l") {
           scrollViewRef.current?.scrollToTop();
           return;
         }
         if (key.ctrl && inputKey.toLowerCase() === "e") {
           scrollViewRef.current?.scrollToBottom();
           return;
         }
       }

       // Other controls
       if (key.escape && controllerRef.current) {
         controllerRef.current.abort("Cancelled by user");
         setChatState((prev) => ({ ...prev, status: "canceled", hitl: undefined }));
       }
       if (key.ctrl && inputKey.toLowerCase() === "l") {
         setChatState((prev) => ({
           ...initialChatState,
           status: "idle",
           threadId: undefined,
           messages: [],
         }));
         autoExpandedThinkingMessageIdsRef.current.clear();
         setExpandedThinkingMessageIds(new Set());
         // Reset scroll to top when clearing
         setTimeout(() => scrollViewRef.current?.scrollToTop(), 0);
       }
       if (inputKey.toLowerCase() === "q" && key.ctrl) {
         exit();
       }
    },
    { isActive: phase === "ready" }
  );

  if (phase === "boot") {
    return (
      <Box flexDirection="column" paddingX={tuiLayout.paddingX} paddingY={1}>
        <Banner disable={bannerDisabled} variant={bannerVariant} />
        {isLoggingIn ? (
          <Box flexDirection="column" gap={1} padding={1}>
            <Text color={terminalTheme.brand} bold>Signing in...</Text>
            <Text dimColor>Please complete authentication in your browser.</Text>
          </Box>
        ) : (
          <Loader
            step={loaderStep}
            steps={bootSteps}
            animate={!disableAnim && !process.env.CLOUDEVAL_NO_ANIM}
          />
        )}
      </Box>
    );
  }

  // Show onboarding if needed
  if (needsOnboarding && phase === "ready" && authToken) {
    return (
      <Onboarding
        baseUrl={baseUrl}
        token={authToken}
        onComplete={() => {
          setNeedsOnboarding(false);
          void refreshAuthenticatedWorkspace(authToken)
            .catch(() => {
              setSelectedProject((current) =>
                current ??
                (currentUserId ? { ...defaultProject, user_id: currentUserId } : defaultProject)
              );
              setSelectingProject(false);
            })
            .finally(() => {
              setChatState((prev) => ({ ...prev, status: "idle" }));
            });
        }}
      />
    );
  }

  if (phase === "error") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={terminalTheme.danger}>Failed to start CLI.</Text>
        <Text>{bootError ?? "Unknown error"}</Text>
        <Text>
          Base URL: {apiBase} (set via CLOUDEVAL_BASE_URL or --base-url)
        </Text>
        <Text>Press Ctrl+C to quit.</Text>
      </Box>
    );
  }

  if (selectingProject) {
    const items = projects.map((p) => ({
      label: `${p.name} (${p.cloud_provider ?? "cloud"})${p.name === "Playground" ? " [Playground]" : ""}`,
      value: p,
    }));
    return (
      <Box flexDirection="column" paddingX={tuiLayout.paddingX} paddingY={1} gap={1}>
        <Banner disable={bannerDisabled} variant={bannerVariant} />
        <Text>Select a project to chat with:</Text>
        {loadingProjects ? (
          <Text>Loading projects...</Text>
        ) : (
          <ProjectSelector
            items={items}
            onSubmit={(selected) => {
              const choice = selected[0] ?? projects[0];
              setSelectedProject(choice || defaultProject);
              setSelectingProject(false);
            }}
            limit={Math.max(5, items.length)}
            multiple={false}
          />
        )}
      </Box>
    );
  }

  if (activeWorkspaceTab !== "chat") {
    return (
      <Box flexDirection="column" paddingX={tuiLayout.paddingX} paddingY={1} gap={1}>
        <WorkspaceTabBar
          activeTab={activeWorkspaceTab}
          activeStatus={activeWorkspacePanelState.status}
          showBrand
        />
        {notice ? <Text dimColor wrap="wrap">{notice}</Text> : null}
        <WorkspacePanel
          tab={activeWorkspaceTab}
          state={activeWorkspacePanelState}
          projects={projects}
          selectedProject={selectedProject}
          currentUserId={currentUserId}
          selectedModel={selectedModel}
          selectedMode={selectedMode}
          apiBase={apiBase}
          frontendUrl={workspaceFrontendUrl}
          terminalColumns={terminalSize.columns}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={tuiLayout.paddingX} paddingY={1} gap={1}>
      <Banner disable={bannerDisabled} variant={bannerVariant} />
      <WorkspaceTabBar
        activeTab={activeWorkspaceTab}
        activeStatus={chatState.status}
        showBrand={bannerDisabled}
      />
      {(() => {
        const statusText = (() => {
          if (chatState.status === "connecting") return "Connecting";
          if (chatState.status === "thinking" && streamingSteps.length) {
            return "Thinking...";
          }
          if (chatState.status === "streaming") return "Generating response";
          if (chatState.status === "tool_running") return "Running tools";
          if (chatState.status === "hitl_waiting") return "Waiting for human input";
          if (chatState.status === "complete") return "Complete";
          if (chatState.status === "error") return "Error";
          if (chatState.status === "canceled") return "Canceled";
          return "Idle";
        })();
        const statusColor =
          chatState.status === "error"
            ? terminalTheme.danger
            : chatState.status === "complete"
              ? terminalTheme.success
              : chatState.status === "canceled"
                ? terminalTheme.warning
                : isBusyStatus(chatState.status)
                  ? terminalTheme.brand
                  : undefined;

        if (isSearching) {
            return (
                <Box borderStyle="double" borderColor={terminalTheme.warning} paddingX={1}>
                    <Text bold color={terminalTheme.warning}>SEARCH MODE</Text>
                    <Text> | Found: {displayedMessages.length} matches</Text>
                </Box>
            );
        }

        return (
          <Box flexDirection="column" gap={0}>
            <SelectorBar
              focused={focusedControl}
              selectedProject={selectedProject}
              selectedModel={selectedModel}
              selectedMode={selectedMode}
              hasThinkingSteps={hasThinkingSteps}
              thinkingExpanded={thinkingExpanded}
              thinkingSummary={thinkingSummary}
              compact={tuiLayout.compact}
              terminalColumns={terminalSize.columns}
              apiBase={apiBase}
              statusText={statusText}
              statusColor={statusColor}
              busy={
                chatState.status === "connecting" ||
                chatState.status === "thinking" ||
                chatState.status === "tool_running"
              }
            />
          {queuedMessages.length > 0 ? (
            <QueuePanel
              messages={queuedMessages}
              compact={tuiLayout.compact}
              terminalColumns={terminalSize.columns}
            />
          ) : null}
          {notice ? <Text dimColor wrap="wrap">{notice}</Text> : null}
          {errorText ? (
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor={terminalTheme.danger}
              paddingX={1}
              marginTop={1}
            >
              <Text color={terminalTheme.danger} bold>Error details</Text>
              <Text color={terminalTheme.danger} wrap="wrap">{errorText}</Text>
              {!hasThinkingSteps ? (
                <Text dimColor wrap="wrap">
                  No thinking steps were received before the backend returned this error.
                </Text>
              ) : null}
            </Box>
          ) : null}
          </Box>
        );
      })()}
      <Box flexDirection="column" borderStyle="round" padding={1}>
        <Box flexDirection="row">
          <Box flexShrink={1} width={threadContentWidth}>
            <ScrollView
              ref={scrollViewRef}
              height={tuiLayout.threadHeight}
              onScroll={(offset) => setScrollOffset(offset)}
              onContentHeightChange={(height) => {
                setContentHeight((previousHeight) => {
                  const currentOffset = scrollViewRef.current?.getScrollOffset() ?? 0;
                  const suppressNextAutoScroll = suppressNextAutoScrollRef.current;
                  suppressNextAutoScrollRef.current = false;
                  if (
                    shouldAutoScrollToBottom({
                      currentOffset,
                      previousContentHeight: previousHeight,
                      viewportHeight,
                      suppressNextAutoScroll,
                    })
                  ) {
                    setTimeout(() => scrollViewRef.current?.scrollToBottom(), 0);
                  }
                  return height;
                });
              }}
              onViewportSizeChange={(size) => setViewportHeight(size.height)}
            >
              <Transcript
                messages={displayedMessages}
                userName={userName}
                excludeStreaming={false}
                expandedThinkingMessageIds={expandedThinkingMessageIds}
              />
            </ScrollView>
          </Box>
          <Scrollbar
            scrollOffset={scrollOffset}
            contentHeight={contentHeight}
            viewportHeight={viewportHeight}
          />
        </Box>
      </Box>
      {chatState.status === "hitl_waiting" && chatState.hitl?.waiting ? (
        <HitlPanel
          hitl={chatState.hitl}
          questionIndex={hitlQuestionIndex}
          optionIndex={hitlOptionIndex}
          answers={hitlAnswers}
          frontendUrl={frontendThreadUrl}
        />
      ) : null}
      <Box flexDirection="column">
        <Text dimColor>
          Commands: /project | /model | /mode | /thinking | /open | Tab completes | Ctrl+R:{" "}
          {isSearching ? "Exit search" : "History search"}
        </Text>
        {!isSearching ? (
          <Text dimColor>Keys: Esc cancel response | {scrollHelp}</Text>
        ) : null}
      </Box>
      {activeSelector === "project" ? (
        <SelectPanel
          title="Select Project"
          items={(projects.length ? projects : [defaultProject]).map((project) => ({
            label: `${project.name} (${project.cloud_provider ?? "cloud"})`,
            value: project,
            description: project.id,
          }))}
          selectedIndex={Math.max(
            0,
            (projects.length ? projects : [defaultProject]).findIndex(
              (project) => project.id === (selectedProject ?? defaultProject).id
            )
          )}
          onSubmit={(item) => {
            setSelectedProject(item.value);
            setActiveSelector(null);
          }}
          onCancel={() => setActiveSelector(null)}
          limit={tuiLayout.selectorLimit}
        />
      ) : null}
      {activeSelector === "model" ? (
        <SelectPanel
          title="Select Model"
          items={modelItems}
          selectedIndex={Math.max(
            0,
            modelItems.findIndex((item) => item.value === selectedModel)
          )}
          onSubmit={(item) => {
            setSelectedModel(item.value);
            setActiveSelector(null);
          }}
          onCancel={() => setActiveSelector(null)}
          limit={tuiLayout.selectorLimit}
        />
      ) : null}
      {activeSelector === "mode" ? (
        <SelectPanel
          title="Select Mode"
          items={modeItems}
          selectedIndex={Math.max(
            0,
            modeItems.findIndex((item) => item.value === selectedMode)
          )}
          onSubmit={(item) => {
            setSelectedMode(item.value);
            setActiveSelector(null);
          }}
          onCancel={() => setActiveSelector(null)}
          limit={tuiLayout.selectorLimit}
        />
      ) : null}

      {isSearching ? (
          <Box flexDirection="column" borderStyle="round" borderColor={terminalTheme.warning} padding={1}>
            <Text color={terminalTheme.warning}>Search History:</Text>
            <InputBox
                value={searchQuery}
                onChange={setSearchQuery}
                onSubmit={() => {}}
                placeholder="Type to filter history..."
            />
          </Box>
      ) : (
          <InputBox
            value={input}
            onChange={handlePromptChange}
            onSubmit={handlePromptSubmit}
            disabled={Boolean(activeSelector)}
            onTabShortcut={(tab) => {
              setActiveWorkspaceTab(tab);
              setActiveSelector(null);
              setNotice(undefined);
              setInput("");
            }}
            followUps={visiblePromptSuggestions}
            followUpsLabel={promptSuggestions.label}
            focusedFollowUpIndex={focusedFollowUpIndex}
            followUpsActive={focusedFollowUpIndex !== undefined}
            terminalColumns={terminalSize.columns}
            placeholder={
              chatState.status === "hitl_waiting"
                ? "Answer HITL prompt, or /open for frontend..."
                : isBusyStatus(chatState.status)
                  ? "Response in progress. Enter queues next message..."
                : "Ask Cloudeval..."
            }
          />
      )}
    </Box>
  );
};

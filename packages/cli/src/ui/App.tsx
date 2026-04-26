import React, { useEffect, useMemo, useState, startTransition } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Banner } from "./components/Banner.js";
import { Loader } from "./components/Loader.js";
import { Transcript } from "./components/Transcript.js";
import { InputBox } from "./components/InputBox.js";
import { Spinner } from "./components/Spinner.js";
import { Scrollbar } from "./components/Scrollbar.js";
import { ProjectSelector } from "./components/ProjectSelector.js";
import { SelectPanel, type SelectPanelItem } from "./components/SelectPanel.js";
import { TitledBox } from "./components/TitledBox.js";
import {
  completePromptInput,
  resolvePromptCommand,
  type CompletionCycleState,
} from "./commandCompletion.js";
import { billingSummaryText, type BillingSummaryState } from "./billingSummary.js";
import { sanitizeTerminalMultilineInput } from "./inputSanitizer.js";
import { getInputViewport, nextInputScrollOffset } from "./inputViewport.js";
import { getTuiKeyBindings } from "./keyBindings.js";
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
import {
  estimateBannerRows,
  getPromptInputRowBudget,
  getResponsiveTuiLayout,
  truncateForTerminal,
  type TerminalSize,
} from "./layout.js";
import { shouldAutoScrollToBottom } from "./scrollBehavior.js";
import { getPromptSuggestions } from "./promptSuggestions.js";
import { buildOverviewDashboardModel } from "./overviewDashboard.js";
import { buildReportsDashboardModel } from "./reportsDashboard.js";
import {
  WORKSPACE_PANEL_STALE_CHECK_MS,
  WORKSPACE_PANEL_STALE_MS,
  completeWorkspacePanelRefresh,
  getWorkspacePanelLoadReason,
  markWorkspacePanelRefreshing,
  type WorkspacePanelDataStore,
} from "./workspaceDataStore.js";
import { raisedButtonStyle, terminalTheme } from "./theme.js";
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
  workspaceTabs,
  workspaceTabFromPosition,
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
  runReports,
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
type BillingHeaderState = BillingSummaryState;
type WorkspacePanelStateMap = WorkspacePanelDataStore;
type WorkspaceRefreshKeyMap = Partial<Record<WorkspaceTab, number>>;
type WorkspacePanelStateUpdater =
  | WorkspacePanelState
  | ((previous: WorkspacePanelState) => WorkspacePanelState);
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
const dropdownIndicator = "▾";

const workspaceTabDescriptions: Record<WorkspaceTab, string> = {
  chat: "Ask questions, run agent workflows, and inspect project context.",
  overview: "Portfolio dashboard with project health, cost, WAF, and report signals.",
  reports: "Report status, downloads, heatmap-style coverage, and direct cost/WAF/test run actions.",
  projects: "Project inventory and frontend project deeplinks.",
  connections: "Cloud/template connections visible to the current account.",
  billing: "Plan, credits, usage, ledger, invoices, top-ups, and billing notifications.",
  options: "Runtime configuration, API/frontend URLs, commands, and agent help.",
  help: "Keyboard, mouse, slash commands, and agent-oriented CLI discovery.",
};

const bottomControlsRows = 1;

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

const billingHeaderFromEntitlement = (entitlement: any): BillingHeaderState | null => {
  const creditStatus = getCreditStatus(entitlement);
  if (!creditStatus) {
    return null;
  }
  return {
    plan: creditStatus.planName,
    remaining: creditStatus.remaining,
    total: creditStatus.total,
    tone: creditStatus.tone,
    status: entitlement?.effective_status,
  };
};

const isBusyStatus = (status: ChatState["status"]): boolean =>
  status === "connecting" ||
  status === "thinking" ||
  status === "streaming" ||
  status === "tool_running" ||
  status === "hitl_waiting";

const isTerminalThinkingStatus = (status?: string): boolean =>
  status === "completed" ||
  status === "error" ||
  status === "aborted" ||
  status === "cancelled";

const hasCancellableAssistantWork = (messages: ChatMessage[]): boolean =>
  messages.some(
    (message) =>
      message.role === "assistant" &&
      (message.pending ||
        message.thinkingSteps?.some((step) => !isTerminalThinkingStatus(step.status ?? "streaming")))
  );

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

const createWorkspacePanelStateMap = (): WorkspacePanelStateMap =>
  Object.fromEntries(
    workspaceTabs.map((tab) => [
      tab,
      createWorkspacePanelState(tab, tab === "chat" ? "ready" : "idle"),
    ])
  ) as WorkspacePanelStateMap;

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

const buildWorkspacePanelCacheKey = ({
  tab,
  apiBase,
  currentUserId,
  activeProjectId,
}: {
  tab: WorkspaceTab;
  apiBase: string;
  currentUserId?: string;
  activeProjectId?: string;
}): string =>
  [
    tab,
    apiBase,
    currentUserId ?? "anonymous",
    tab === "reports" ? activeProjectId ?? "no-project" : "all-projects",
  ].join("|");

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

const writeTableDownload = ({
  tab,
  data,
  projects,
  selectedProject,
  tablePage,
}: {
  tab: WorkspaceTab;
  data: Record<string, unknown>;
  projects: ProjectInfo[];
  selectedProject: ProjectInfo | null;
  tablePage: number;
}): string => {
  const directArray = (value: unknown): unknown[] => {
    if (Array.isArray(value)) {
      return value;
    }
    if (!value || typeof value !== "object") {
      return [];
    }
    const record = value as Record<string, unknown>;
    for (const key of ["data", "items", "rows", "results", "connections", "ledger", "invoices", "notifications", "topups"]) {
      const candidate = record[key];
      if (Array.isArray(candidate)) {
        return candidate;
      }
    }
    return [];
  };
  const derived =
    tab === "overview"
      ? buildOverviewDashboardModel({
          dashboard: data.dashboard,
          reportsSummary: data.reportsSummary,
          fallbackProjectCount: projects.length,
          fallbackConnectionCount: directArray(data.connections).length,
        })
      : tab === "reports"
        ? buildReportsDashboardModel({
            dashboard: data.dashboard,
            reportsSummary: data.reportsSummary,
            selectedProject,
            costReport: data.costReport,
            wafReport: data.wafReport,
          })
        : {
            rows: {
              connections: directArray(data.connections),
              ledger: directArray(data.ledger),
              invoices: directArray(data.billingInfo),
              topups: directArray(data.topups),
              notifications: directArray(data.notifications),
            },
          };
  const dir = resolve(process.cwd(), ".cloudeval-downloads");
  mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `${tab}-tables-${timestamp}.json`);
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        tab,
        tablePage,
        selectedProject,
        projects,
        derived,
        data,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return file;
};

const readTerminalSize = (): TerminalSize => ({
  columns: process.stdout.columns || 100,
  rows: process.stdout.rows || 32,
});

const estimatePromptSuggestionRows = (count: number, columns: number): number => {
  if (count <= 0) {
    return 0;
  }
  const promptsPerRow = columns < 90 ? 1 : columns < 132 ? 2 : 3;
  return Math.max(1, Math.ceil(count / promptsPerRow)) * 3;
};

const estimatePromptControlRows = ({
  compact,
  hasThinkingSteps,
}: {
  compact: boolean;
  hasThinkingSteps: boolean;
}): number => {
  const selectorCount = selectorOrder.length + (hasThinkingSteps ? 1 : 0);
  return compact ? selectorCount * 3 : 3;
};

const estimatePromptPanelRows = ({
  inputRows,
  suggestionRows,
  compact,
  hasThinkingSteps,
}: {
  inputRows: number;
  suggestionRows: number;
  compact: boolean;
  hasThinkingSteps: boolean;
}): number => {
  const outerChromeRows = 4;
  const topHelpRows = 1;
  const inputBoxRows = inputRows + 3;
  const footerRows =
    1 + 1 + estimatePromptControlRows({ compact, hasThinkingSteps }) + 1 + 2;
  return outerChromeRows + topHelpRows + suggestionRows + inputBoxRows + footerRows;
};

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
    <TitledBox
      title={`Queue (${messages.length})`}
      borderStyle="single"
      borderColor={terminalTheme.warning}
      padding={0}
      paddingX={1}
      marginTop={1}
    >
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
    </TitledBox>
  );
};

const PromptControlBar: React.FC<{
  focused: TuiControlFocus;
  selectedProject: ProjectInfo | null;
  selectedModel: string;
  selectedMode: ChatMode;
  hasThinkingSteps: boolean;
  thinkingExpanded: boolean;
  thinkingSummary: string;
  compact: boolean;
  terminalColumns: number;
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
  statusText,
  statusColor,
  busy,
}) => {
  const controlGap = compact ? 0 : 1;
  return (
    <Box flexDirection="column" gap={0}>
      <Text dimColor>Settings</Text>
      <Box flexDirection={compact ? "column" : "row"} gap={controlGap} flexWrap="wrap">
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
              borderStyle={raisedButtonStyle.border}
              borderColor={isFocused ? terminalTheme.brand : terminalTheme.muted}
              paddingX={1}
            >
              <Text color={isFocused ? terminalTheme.brand : undefined} bold={isFocused}>
                {isFocused ? raisedButtonStyle.activeMarker : raisedButtonStyle.inactiveMarker}{" "}
                {label} [{value}] {dropdownIndicator}
              </Text>
  </Box>
);

        })}
        {hasThinkingSteps ? (
          <Box
            borderStyle={raisedButtonStyle.border}
            borderColor={focused === "thinking" ? terminalTheme.brand : terminalTheme.muted}
            paddingX={1}
          >
            <Text
              color={focused === "thinking" ? terminalTheme.brand : undefined}
              bold={focused === "thinking"}
            >
              {focused === "thinking" ? raisedButtonStyle.activeMarker : raisedButtonStyle.inactiveMarker}{" "}
              Reasoning: {thinkingExpanded ? "open" : thinkingSummary}
            </Text>
          </Box>
        ) : null}
        <Box flexGrow={1} justifyContent="flex-end">
          <Box flexDirection="row" gap={1}>
            {busy ? <Spinner type="line" /> : null}
            <Text color={statusColor}>{statusText}</Text>
          </Box>
        </Box>
      </Box>
      <Text dimColor wrap="truncate">
        Tab/left/right focus | Enter open | /project /model /mode /thinking
      </Text>
    </Box>
  );
};

const BottomControls: React.FC<{ tab: WorkspaceTab }> = ({ tab }) => (
  <Box flexDirection="row" justifyContent="space-between">
    <Text dimColor>
      <Text color={terminalTheme.brand} bold>Keys</Text>
      <Text> ↑/↓ scroll | PgUp/PgDn scroll | [/] table page | </Text>
      <Text color={terminalTheme.brand} bold>D</Text>
      <Text> download | </Text>
      <Text color={terminalTheme.brand} bold>R</Text>
      <Text> refresh | </Text>
      <Text color={terminalTheme.brand} bold>O</Text>
      <Text> open | </Text>
      <Text color={terminalTheme.brand} bold>C</Text>
      <Text> chat</Text>
    </Text>
    {tab === "reports" ? (
      <Text dimColor>
        <Text color={terminalTheme.brand} bold>Reports</Text>
        <Text> W WAF | K cost | U tests | A all | P project</Text>
      </Text>
    ) : null}
  </Box>
);

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
    <TitledBox
      title="Human Approval"
      borderStyle="round"
      borderColor={terminalTheme.warning}
      padding={1}
    >
      <Text wrap="wrap">
        {questionIndex + 1}/{hitl.questions.length}: {question?.text ?? "Action required"}
      </Text>
      {options.length ? (
        <Box flexDirection="column" marginTop={1}>
          {options.map((option, index) => {
            const highlighted = index === optionIndex;
            const selected = answers[question.id] === option.id;
            return (
              <Text
                key={option.id}
                color={highlighted ? terminalTheme.brand : undefined}
                dimColor={!highlighted && !selected}
                bold={highlighted}
                inverse={highlighted}
              >
                {highlighted ? raisedButtonStyle.activeMarker : selected ? "•" : raisedButtonStyle.inactiveMarker}{" "}
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
    </TitledBox>
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
  const { write } = useStdout();
  const [phase, setPhase] = useState<"boot" | "ready" | "error">("boot");
  const [loaderStep, setLoaderStep] = useState(0);
  const [bootError, setBootError] = useState<string | undefined>();
  const [input, setInput] = useState("");
  const [promptInputScrollOffset, setPromptInputScrollOffset] = useState(0);
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
  const [workspacePanelStore, setWorkspacePanelStore] = useState<WorkspacePanelStateMap>(
    createWorkspacePanelStateMap
  );
  const [tablePageByTab, setTablePageByTab] = useState<Partial<Record<WorkspaceTab, number>>>({});
  const [workspaceRefreshKeys, setWorkspaceRefreshKeys] = useState<WorkspaceRefreshKeyMap>({});
  const [workspaceStaleTick, setWorkspaceStaleTick] = useState(0);
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
  const [billingHeader, setBillingHeader] = useState<BillingHeaderState | null>(null);
  const [billingHeaderError, setBillingHeaderError] = useState<string | undefined>();
  const [focusedControl, setFocusedControl] = useState<TuiControlFocus>("project");
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [hitlQuestionIndex, setHitlQuestionIndex] = useState(0);
  const [hitlOptionIndex, setHitlOptionIndex] = useState(0);
  const [hitlAnswers, setHitlAnswers] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | undefined>();
  const [scrollOffset, setScrollOffset] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(20);
  const [workspaceScrollOffset, setWorkspaceScrollOffset] = useState(0);
  const [workspaceContentHeight, setWorkspaceContentHeight] = useState(0);
  const [workspaceViewportHeight, setWorkspaceViewportHeight] = useState(14);
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
  const billingHeaderRefreshKey = workspaceRefreshKeys.billing ?? 0;
  const scrollViewRef = React.useRef<ScrollViewRef>(null);
  const workspaceScrollViewRef = React.useRef<ScrollViewRef>(null);
  const controllerRef = React.useRef<AbortController | null>(null);
  const queueRef = React.useRef<QueuedMessage[]>([]);
  const completionCycleRef = React.useRef<CompletionCycleState | undefined>();
  const previousWorkspaceTabRef = React.useRef<WorkspaceTab>(activeWorkspaceTab);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [expandedThinkingMessageIds, setExpandedThinkingMessageIds] = useState<Set<string>>(
    () => new Set()
  );
  const autoExpandedThinkingMessageIdsRef = React.useRef<Set<string>>(new Set());
  const suppressNextAutoScrollRef = React.useRef(false);
  const setWorkspacePanelTabState = React.useCallback(
    (tab: WorkspaceTab, stateOrUpdater: WorkspacePanelStateUpdater) => {
      setWorkspacePanelStore((current) => {
        const previous = current[tab] ?? createWorkspacePanelState(tab);
        const state =
          typeof stateOrUpdater === "function" ? stateOrUpdater(previous) : stateOrUpdater;
        return {
          ...current,
          [tab]: state,
        };
      });
    },
    []
  );

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
    if (phase !== "ready") {
      return;
    }
    const timer = setInterval(() => {
      setWorkspaceStaleTick(Date.now());
    }, WORKSPACE_PANEL_STALE_CHECK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [phase]);

  useEffect(() => {
    let cancelled = false;
    if (phase !== "ready" || !authToken) {
      return;
    }

    setBillingHeaderError(undefined);
    getBillingEntitlement({ baseUrl: apiBase, authToken })
      .then((entitlement) => {
        if (cancelled) {
          return;
        }
        setBillingHeader(billingHeaderFromEntitlement(entitlement));
      })
      .catch((error: any) => {
        if (cancelled) {
          return;
        }
        setBillingHeader(null);
        setBillingHeaderError(error?.message ?? "Billing unavailable");
      });

    return () => {
      cancelled = true;
    };
  }, [apiBase, authToken, billingHeaderRefreshKey, phase]);

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

    const cacheKey = buildWorkspacePanelCacheKey({
      tab,
      apiBase,
      currentUserId,
      activeProjectId,
    });
    const refreshToken = workspaceRefreshKeys[tab] ?? 0;
    const currentState = workspacePanelStore[tab] ?? createWorkspacePanelState(tab);
    const loadReason = getWorkspacePanelLoadReason({
      state: currentState,
      now: Date.now(),
      staleMs: WORKSPACE_PANEL_STALE_MS,
      cacheKey,
      refreshToken,
    });

    if (!loadReason) {
      return;
    }

    if (tab === "chat" || tab === "projects" || tab === "options" || tab === "help") {
      const now = Date.now();
      setWorkspacePanelTabState(tab, (previous) => ({
        ...previous,
        tab,
        status: "ready",
        warnings: [],
        error: undefined,
        loadedAt: now,
        staleAt: now + WORKSPACE_PANEL_STALE_MS,
        cacheKey,
        isRefreshing: false,
        refreshStartedAt: undefined,
        lastLoadReason: loadReason,
        lastRefreshToken: refreshToken,
      }));
      return;
    }

    if (!authToken) {
      setWorkspacePanelTabState(tab, (previous) =>
        completeWorkspacePanelRefresh({
          previous,
          tab,
          data: {},
          warnings: ["Authentication: Authentication is required to load this tab."],
          now: Date.now(),
          staleMs: WORKSPACE_PANEL_STALE_MS,
          cacheKey,
          refreshToken,
          reason: loadReason,
        })
      );
      return;
    }

    setWorkspacePanelTabState(tab, (previous) =>
      markWorkspacePanelRefreshing({
        state: previous,
        now: Date.now(),
        reason: loadReason,
        cacheKey,
        refreshToken,
      })
    );

    const load = async () => {
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

      if (tab === "overview" || tab === "reports") {
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
        setWorkspacePanelTabState(tab, (previous) =>
          completeWorkspacePanelRefresh({
            previous,
            tab,
            data,
            warnings,
            now: Date.now(),
            staleMs: WORKSPACE_PANEL_STALE_MS,
            cacheKey,
            refreshToken,
            reason: loadReason,
          })
        );
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
    setWorkspacePanelTabState,
    workspacePanelStore,
    workspaceRefreshKeys,
    workspaceStaleTick,
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

  const runReportFromReportsTab = async (kind: "cost" | "waf" | "unit-tests" | "all") => {
    const project = selectedProject ?? projects[0] ?? defaultProject;
    const labels: Record<typeof kind, string> = {
      cost: "cost",
      waf: "Well-Architected",
      "unit-tests": "unit test",
      all: "cost, Well-Architected, and unit test",
    };
    setActiveSelector(null);
    if (!authToken) {
      setNotice("Sign in before running reports.");
      return;
    }
    if (!currentUserId) {
      setNotice("Authenticated user id is not available yet. Refresh and try again.");
      return;
    }
    setWorkspacePanelTabState("reports", {
      ...activeWorkspacePanelState,
      tab: "reports",
      status: "loading",
    });
    setNotice(`Submitting ${labels[kind]} report run for ${project.name}...`);
    try {
      const submitted = await runReports({
        baseUrl: apiBase,
        authToken,
        projectId: project.id,
        userId: currentUserId,
        type: kind,
        region: "eastus",
        currency: "USD",
        includeTimeSeries: true,
        saveReport: true,
      });
      const jobIds = submitted
        .map((item: any) => item?.job?.job_id ?? item?.job_id ?? item?.id)
        .filter(Boolean);
      setWorkspaceRefreshKeys((current) => ({
        ...current,
        reports: (current.reports ?? 0) + 1,
        overview: (current.overview ?? 0) + 1,
      }));
      setNotice(
        jobIds.length
          ? `Submitted ${labels[kind]} report job${jobIds.length > 1 ? "s" : ""}: ${jobIds.join(", ")}`
          : `Submitted ${labels[kind]} report run for ${project.name}.`
      );
    } catch (error: any) {
      setWorkspacePanelTabState("reports", {
        ...activeWorkspacePanelState,
        tab: "reports",
        status: "error",
        error: error?.message ?? "Failed to submit report run",
      });
      setNotice(`Failed to submit ${labels[kind]} report run: ${error?.message ?? "Unknown error"}`);
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

  const markAssistantMessageCanceled = (message: ChatMessage, now: number): ChatMessage => {
    const thinkingSteps = message.thinkingSteps?.map((step) => {
      const status = step.status ?? "streaming";
      if (isTerminalThinkingStatus(status)) {
        return step;
      }
      return {
        ...step,
        status: "cancelled" as const,
        updatedAt: now,
        completedAt: step.completedAt ?? now,
        durationMs:
          step.durationMs ??
          (step.startedAt ? Math.max(0, now - step.startedAt) : undefined),
      };
    });
    return {
      ...message,
      pending: false,
      updatedAt: now,
      ...(thinkingSteps ? { thinkingSteps } : {}),
    };
  };

  const stopActiveChat = (reason = "Cancelled by user") => {
    const hasActiveResponse =
      Boolean(controllerRef.current) ||
      isBusyStatus(chatState.status) ||
      hasCancellableAssistantWork(chatState.messages);
    if (controllerRef.current) {
      controllerRef.current.abort(reason);
    }
    if (queueRef.current.length) {
      queueRef.current = [];
      syncQueueState();
    }
    const now = Date.now();
    setChatState((prev) => ({
      ...prev,
      status: hasActiveResponse ? "canceled" : prev.status,
      hitl: undefined,
      activeMessageId: undefined,
      messages: prev.messages.map((message) =>
        message.role === "assistant" &&
        (message.pending ||
          message.thinkingSteps?.some((step) => !isTerminalThinkingStatus(step.status ?? "streaming")))
          ? markAssistantMessageCanceled(message, now)
          : message
      ),
    }));
    setNotice(
      hasActiveResponse
        ? "Response canceled. Esc or /stop cancels running chat."
        : "No running response to cancel."
    );
  };

  const handlePromptSubmit = (value: string) => {
    const cleanedValue = sanitizeTerminalMultilineInput(value);
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
        case "stopChat":
          stopActiveChat();
          return;
        case "openFrontend":
          handleOpenFrontend();
          return;
        case "showHelp":
          setActiveWorkspaceTab("help");
          setNotice(undefined);
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
    const cleanedValue = sanitizeTerminalMultilineInput(value);
    completionCycleRef.current = undefined;
    setPromptInputScrollOffset(
      getInputViewport({
        value: cleanedValue,
        width: promptInputWidth,
        minRows: promptInputRowBudget,
        maxRows: promptInputRowBudget,
      }).maxScrollOffset
    );
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
          const now = Date.now();
          setChatState((prev) => ({
            ...prev,
            status: "canceled",
            hitl: undefined,
            activeMessageId: undefined,
            messages: prev.messages.map((message) =>
              message.role === "assistant" &&
              (message.pending ||
                message.thinkingSteps?.some((step) => !isTerminalThinkingStatus(step.status ?? "streaming")))
                ? markAssistantMessageCanceled(message, now)
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
  const hasCancellableReasoning = hasCancellableAssistantWork(chatState.messages);
  const latestFollowUps = latestAssistant?.followUpQuestions?.filter(Boolean) ?? [];
  const promptSuggestions = getPromptSuggestions({
    latestFollowUps,
    messages: chatState.messages,
    mode: selectedMode,
    project: selectedProject,
    limit: terminalSize.columns < 110 ? 3 : 4,
  });
  const visiblePromptSuggestions = promptSuggestions.prompts.slice(
    0,
    terminalSize.columns < 110 ? 3 : 4
  );
  const promptInputWidth = Math.max(20, terminalSize.columns - 14);
  const promptInputRowBudget = getPromptInputRowBudget(terminalSize);
  const promptInputViewport = getInputViewport({
    value: input,
    width: promptInputWidth,
    minRows: promptInputRowBudget,
    maxRows: promptInputRowBudget,
    scrollOffset: promptInputScrollOffset,
  });
  const promptInputRows = promptInputViewport.visibleRowCount;
  const promptSuggestionRows = estimatePromptSuggestionRows(
    visiblePromptSuggestions.length,
    terminalSize.columns
  );
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
    promptInputRows,
    promptSuggestionRows,
  });
  const bannerDisabled = bannerDisabledByConfig || !tuiLayout.showBanner;
  const bannerContentColumns = Math.max(1, terminalSize.columns - tuiLayout.paddingX * 2);
  const billingSummary = billingHeaderError
    ? `Plan: unavailable | Credits: unavailable`
    : billingSummaryText(billingHeader);
  const headerDetails = [
    `API: ${apiBase}`,
    `Frontend: ${frontendBaseUrl}`,
    billingSummary,
  ];
  const keyBindings = getTuiKeyBindings();
  const scrollHelp = mouseTrackingEnabled
    ? `${keyBindings.mouse} | wheel scroll`
    : keyBindings.scroll;
  const threadContentWidth = Math.max(
    24,
    terminalSize.columns - tuiLayout.paddingX * 2 - 8
  );
  const chatThreadHeight = Math.max(1, tuiLayout.threadHeight - bottomControlsRows);
  const activeWorkspacePanelState =
    workspacePanelStore[activeWorkspaceTab] ??
    createWorkspacePanelState(activeWorkspaceTab, "loading");
  const activeTablePage = tablePageByTab[activeWorkspaceTab] ?? 0;
  const bannerRenderedRows = bannerDisabled
    ? 0
    : estimateBannerRows({ detailsCount: headerDetails.length, columns: bannerContentColumns });
  const workspaceHeaderRows =
    bannerRenderedRows +
    3 +
    (notice ? 1 : 0);
  const workspaceFooterRows =
    bottomControlsRows + 1 + (activeSelector === "project" ? tuiLayout.selectorLimit + 4 : 0);
  const workspacePanelViewportRows = Math.max(
    3,
    terminalSize.rows - workspaceHeaderRows - workspaceFooterRows
  );
  const workspaceContentWidth = Math.max(24, terminalSize.columns - tuiLayout.paddingX * 2 - 3);
  const workspaceTabStartRow = useMemo(() => {
    const rootContentStartRow = 1;
    if (bannerDisabled) {
      const compactBrandRows = 3;
      const gapAfterBrand = 1;
      return rootContentStartRow + compactBrandRows + gapAfterBrand;
    }
    const bannerRows = estimateBannerRows({
      detailsCount: headerDetails.length,
      columns: bannerContentColumns,
    });
    const gapAfterBanner = 1;
    return rootContentStartRow + bannerRows + gapAfterBanner;
  }, [bannerDisabled, bannerContentColumns, headerDetails.length]);
  const workspaceTabHitAreas = useMemo(
    () =>
      getWorkspaceTabHitAreas({
        startColumn: tuiLayout.paddingX + 1,
        startRow: workspaceTabStartRow,
        maxColumn: Math.max(1, terminalSize.columns - tuiLayout.paddingX),
        gap: 1,
        rowGap: 0,
      }),
    [terminalSize.columns, tuiLayout.paddingX, workspaceTabStartRow]
  );
  const selectorControlStartRow = useMemo(
    () => Math.max(1, terminalSize.rows - (tuiLayout.compact ? 7 : 5)),
    [terminalSize.rows, tuiLayout.compact]
  );
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
  const promptPanelStartRow = useMemo(
    () =>
      Math.max(
        1,
        terminalSize.rows -
          estimatePromptPanelRows({
            inputRows: promptInputRows,
            suggestionRows: promptSuggestionRows,
            compact: tuiLayout.compact,
            hasThinkingSteps,
          }) +
          1
      ),
    [
      hasThinkingSteps,
      promptInputRows,
      promptSuggestionRows,
      terminalSize.rows,
      tuiLayout.compact,
    ]
  );

  useEffect(() => {
    setFocusedControl((current) =>
      controlFocusOrder.includes(current)
        ? current
        : controlFocusOrder[0] ?? "project"
    );
  }, [controlFocusOrder.join("|")]);

  useEffect(() => {
    if (previousWorkspaceTabRef.current !== activeWorkspaceTab) {
      write("\x1b[2J\x1b[H");
      previousWorkspaceTabRef.current = activeWorkspaceTab;
      setScrollOffset(0);
      setContentHeight(0);
      setWorkspaceScrollOffset(0);
      setWorkspaceContentHeight(0);
    }
    if (activeWorkspaceTab !== "chat") {
      setTimeout(() => workspaceScrollViewRef.current?.scrollToTop(), 0);
    } else {
      setTimeout(() => scrollViewRef.current?.scrollToTop(), 0);
    }
  }, [activeWorkspaceTab, write]);

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
    const isPrimaryClick = mouseEvent.code < 64 && (mouseEvent.code & 3) === 0;
    if (!isPrimaryClick) {
      return;
    }

    const clickedTab = workspaceTabFromPosition(
      mouseEvent.x,
      mouseEvent.y,
      workspaceTabHitAreas
    );
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

    if (mouseEvent.released) {
      return;
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
          if (isBusyStatus(chatState.status)) {
              stopActiveChat();
              return; // Don't exit
          }
          // Otherwise exit (handled by default process behavior, but ink captures it sometimes)
          exit();
          return;
       }

       if (isTerminalMouseInput(inputKey)) {
         const mouseWheelDelta = parseMouseWheelDelta(inputKey);
         if (mouseWheelDelta !== null) {
           const mouseEvent = parseTerminalMouseEvent(inputKey);
           const isOverPromptPanel =
             activeWorkspaceTab === "chat" &&
             !isSearching &&
             mouseEvent !== null &&
             mouseEvent.y >= promptPanelStartRow;
           if (isOverPromptPanel && promptInputViewport.maxScrollOffset > 0) {
             setPromptInputScrollOffset(
               nextInputScrollOffset({
                 currentOffset: promptInputViewport.startRow,
                 delta: mouseWheelDelta,
                 maxScrollOffset: promptInputViewport.maxScrollOffset,
               })
             );
           } else if (activeWorkspaceTab !== "chat") {
             workspaceScrollViewRef.current?.scrollBy(mouseWheelDelta);
           } else {
             scrollViewRef.current?.scrollBy(mouseWheelDelta);
           }
         } else {
           const mouseEvent = parseTerminalMouseEvent(inputKey);
           if (mouseEvent) {
             handleMouseClick(mouseEvent);
           }
         }
         setInput((current) => sanitizeTerminalMultilineInput(current));
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

       if (activeSelector) {
         return;
       }

       if (phase === "ready" && activeWorkspaceTab !== "chat") {
         if (key.ctrl && lowerInput === "q") {
           exit();
           return;
         }
         if (key.upArrow && !key.ctrl && !key.meta) {
           workspaceScrollViewRef.current?.scrollBy(-1);
           return;
         }
         if (key.downArrow && !key.ctrl && !key.meta) {
           workspaceScrollViewRef.current?.scrollBy(1);
           return;
         }
         if (key.pageUp && !key.ctrl && !key.meta) {
           workspaceScrollViewRef.current?.scrollBy(-Math.max(1, Math.floor(workspaceViewportHeight * 0.8)));
           return;
         }
         if (key.pageDown && !key.ctrl && !key.meta) {
           workspaceScrollViewRef.current?.scrollBy(Math.max(1, Math.floor(workspaceViewportHeight * 0.8)));
           return;
         }
         if (inputKey === "]") {
           setTablePageByTab((current) => ({
             ...current,
             [activeWorkspaceTab]: (current[activeWorkspaceTab] ?? 0) + 1,
           }));
           setNotice("Table page next. Use [ for previous, D to download all table data.");
           return;
         }
         if (inputKey === "[") {
           setTablePageByTab((current) => ({
             ...current,
             [activeWorkspaceTab]: Math.max(0, (current[activeWorkspaceTab] ?? 0) - 1),
           }));
           setNotice("Table page previous. Use ] for next, D to download all table data.");
           return;
         }
         if (activeWorkspaceTab === "reports" && lowerInput === "w") {
           void runReportFromReportsTab("waf");
           return;
         }
         if (activeWorkspaceTab === "reports" && lowerInput === "k") {
           void runReportFromReportsTab("cost");
           return;
         }
         if (activeWorkspaceTab === "reports" && lowerInput === "u") {
           void runReportFromReportsTab("unit-tests");
           return;
         }
         if (activeWorkspaceTab === "reports" && lowerInput === "a") {
           void runReportFromReportsTab("all");
           return;
         }
         if (
           activeWorkspaceTab === "reports" &&
           (lowerInput === "p" || key.return)
         ) {
           setActiveSelector("project");
           setNotice("Choose a project for report drilldown.");
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
           setWorkspaceRefreshKeys((current) => ({
             ...current,
             [activeWorkspaceTab]: (current[activeWorkspaceTab] ?? 0) + 1,
           }));
           setNotice(`Refreshing ${activeWorkspaceTab} data`);
           return;
         }
         if (lowerInput === "o") {
           handleOpenWorkspaceFrontend();
           return;
         }
         if (lowerInput === "d") {
           try {
             const file = writeTableDownload({
               tab: activeWorkspaceTab,
               data: activeWorkspacePanelState.data,
               projects,
               selectedProject,
               tablePage: activeTablePage,
             });
             setNotice(`Downloaded ${activeWorkspaceTab} table data: ${file}`);
           } catch (error: any) {
             setNotice(`Failed to download table data: ${error?.message ?? "Unknown error"}`);
           }
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
           setPromptInputScrollOffset(
             getInputViewport({
               value: completion.value,
               width: promptInputWidth,
               minRows: promptInputRowBudget,
               maxRows: promptInputRowBudget,
             }).maxScrollOffset
           );
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
         if (key.return && !key.meta && !key.ctrl) {
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
       if (
         key.escape &&
         (controllerRef.current ||
           isBusyStatus(chatState.status) ||
           hasCancellableAssistantWork(chatState.messages))
       ) {
         stopActiveChat();
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
      <Box flexDirection="column" paddingX={tuiLayout.paddingX} paddingY={0}>
        <Banner disable={bannerDisabled} details={headerDetails} terminalColumns={bannerContentColumns} />
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

  const chatStatusText = (() => {
    if (chatState.status === "connecting") return "Connecting";
    if (chatState.status === "thinking" && streamingSteps.length) return "Thinking...";
    if (chatState.status === "streaming") return "Generating response";
    if (chatState.status === "tool_running") return "Running tools";
    if (chatState.status === "hitl_waiting") return "Waiting for human input";
    if (chatState.status === "complete") return "Complete";
    if (chatState.status === "error") return "Error";
    if (chatState.status === "canceled") return "Canceled";
    return "Idle";
  })();
  const chatStatusColor =
    chatState.status === "error"
      ? terminalTheme.danger
      : chatState.status === "complete"
        ? terminalTheme.success
        : chatState.status === "canceled"
          ? terminalTheme.warning
          : isBusyStatus(chatState.status)
            ? terminalTheme.brand
            : undefined;
  const chatBusy =
    chatState.status === "connecting" ||
    chatState.status === "thinking" ||
    chatState.status === "streaming" ||
    chatState.status === "tool_running";
  const promptActionIsCancel =
    isBusyStatus(chatState.status) || Boolean(controllerRef.current) || hasCancellableReasoning;

  if (selectingProject) {
    const items = projects.map((p) => ({
      label: `${p.name} (${p.cloud_provider ?? "cloud"})${p.name === "Playground" ? " [Playground]" : ""}`,
      value: p,
    }));
    return (
      <Box flexDirection="column" paddingX={tuiLayout.paddingX} paddingY={0} gap={0}>
        <Banner disable={bannerDisabled} details={headerDetails} terminalColumns={bannerContentColumns} />
        <Text>Select a project to chat with:</Text>
        {loadingProjects ? (
          <Box flexDirection="row" gap={1}>
            <Spinner type="line" />
            <Text color={terminalTheme.brand}>Loading projects...</Text>
          </Box>
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
      <Box flexDirection="column" paddingX={tuiLayout.paddingX} paddingY={0} gap={0}>
        <Banner disable={bannerDisabled} details={headerDetails} terminalColumns={bannerContentColumns} />
        <WorkspaceTabBar
          activeTab={activeWorkspaceTab}
          showBrand={bannerDisabled}
          billingSummary={bannerDisabled ? billingHeader : undefined}
        />
        <Text dimColor wrap="wrap">{workspaceTabDescriptions[activeWorkspaceTab]}</Text>
        {notice ? <Text dimColor wrap="wrap">{notice}</Text> : null}
        <Box flexDirection="row">
          <Box flexShrink={1} width={workspaceContentWidth}>
            <ScrollView
              ref={workspaceScrollViewRef}
              height={workspacePanelViewportRows}
              onScroll={(offset) => setWorkspaceScrollOffset(offset)}
              onContentHeightChange={(height) => setWorkspaceContentHeight(height)}
              onViewportSizeChange={(size) => setWorkspaceViewportHeight(size.height)}
            >
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
                terminalColumns={workspaceContentWidth}
                tablePage={activeTablePage}
              />
            </ScrollView>
          </Box>
          <Scrollbar
            scrollOffset={workspaceScrollOffset}
            contentHeight={workspaceContentHeight}
            viewportHeight={workspaceViewportHeight}
          />
        </Box>
        <BottomControls tab={activeWorkspaceTab} />
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
              setNotice(`Reports project selected: ${item.value.name}`);
            }}
            onCancel={() => setActiveSelector(null)}
            limit={tuiLayout.selectorLimit}
          />
        ) : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={tuiLayout.paddingX} paddingY={0} gap={0}>
      <Banner disable={bannerDisabled} details={headerDetails} terminalColumns={bannerContentColumns} />
      <WorkspaceTabBar
        activeTab={activeWorkspaceTab}
        showBrand={bannerDisabled}
        billingSummary={bannerDisabled ? billingHeader : undefined}
      />
      {isSearching ? (
        <TitledBox
          title="Search"
          borderStyle="double"
          borderColor={terminalTheme.warning}
          padding={0}
          paddingX={1}
        >
          <Text>Found: {displayedMessages.length} matches</Text>
        </TitledBox>
      ) : null}
      {queuedMessages.length > 0 ? (
        <QueuePanel
          messages={queuedMessages}
          compact={tuiLayout.compact}
          terminalColumns={terminalSize.columns}
        />
      ) : null}
      {notice ? <Text dimColor wrap="wrap">{notice}</Text> : null}
      {errorText ? (
        <TitledBox
          title="Error Details"
          borderStyle="round"
          borderColor={terminalTheme.danger}
          padding={0}
          paddingX={1}
          marginTop={1}
        >
          <Text color={terminalTheme.danger} wrap="wrap">{errorText}</Text>
          {!hasThinkingSteps ? (
            <Text dimColor wrap="wrap">
              No thinking steps were received before the backend returned this error.
            </Text>
          ) : null}
        </TitledBox>
      ) : null}
      <TitledBox title="Thread" borderStyle="round" borderColor={terminalTheme.muted} padding={1}>
        <Box flexDirection="row">
          <Box flexShrink={1} width={threadContentWidth}>
            <ScrollView
              ref={scrollViewRef}
              height={chatThreadHeight}
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
                emptyLabel={isSearching ? "No matching messages." : "Thread is empty."}
              />
            </ScrollView>
          </Box>
          <Scrollbar
            scrollOffset={scrollOffset}
            contentHeight={contentHeight}
            viewportHeight={viewportHeight}
          />
        </Box>
      </TitledBox>
      {chatState.status === "hitl_waiting" && chatState.hitl?.waiting ? (
        <HitlPanel
          hitl={chatState.hitl}
          questionIndex={hitlQuestionIndex}
          optionIndex={hitlOptionIndex}
          answers={hitlAnswers}
          frontendUrl={frontendThreadUrl}
        />
      ) : null}
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
          <TitledBox
            title="Search History"
            borderStyle="round"
            borderColor={terminalTheme.warning}
            padding={1}
          >
            <InputBox
                value={searchQuery}
                onChange={setSearchQuery}
                onSubmit={() => {}}
                placeholder="Type to filter history..."
            />
          </TitledBox>
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
            scrollOffset={promptInputViewport.startRow}
            minInputRows={promptInputRowBudget}
            maxInputRows={promptInputRowBudget}
            footerControls={
              <Box flexDirection="column" gap={0}>
                <PromptControlBar
                  focused={focusedControl}
                  selectedProject={selectedProject}
                  selectedModel={selectedModel}
                  selectedMode={selectedMode}
                  hasThinkingSteps={hasThinkingSteps}
                  thinkingExpanded={thinkingExpanded}
                  thinkingSummary={thinkingSummary}
                  compact={tuiLayout.compact}
                  terminalColumns={terminalSize.columns}
                  statusText={chatStatusText}
                  statusColor={chatStatusColor}
                  busy={chatBusy}
                />
                <Text dimColor wrap="wrap">
                  /project | /model | /mode | /thinking | /stop | /open | /help
                </Text>
                <Text dimColor wrap="wrap">
                  {keyBindings.commandComplete} | {keyBindings.historySearch} | Esc cancel response | {scrollHelp}
                </Text>
              </Box>
            }
            helpText={`${keyBindings.submit} | ${keyBindings.newline} | ${keyBindings.quit}`}
            actionLabel={promptActionIsCancel ? "ESC to cancel" : "ENTER to send"}
            actionHint={
              promptActionIsCancel
                ? "Esc, Ctrl+C, or /stop cancels the running response."
                : "Enter sends. Use Option+Enter or Ctrl+J for a newline."
            }
            actionTone={promptActionIsCancel ? terminalTheme.warning : terminalTheme.brand}
            onAction={() => {
              if (promptActionIsCancel) {
                stopActiveChat();
                return;
              }
              handlePromptSubmit(input);
            }}
            actionDisabled={!promptActionIsCancel && !input.trim()}
            placeholder={
              chatState.status === "hitl_waiting"
                ? "Answer HITL prompt, or /open for frontend..."
                : isBusyStatus(chatState.status)
                  ? "Response in progress. Enter queues next message..."
                : "Ask Cloudeval..."
            }
          />
      )}
      <BottomControls tab={activeWorkspaceTab} />
    </Box>
  );
};

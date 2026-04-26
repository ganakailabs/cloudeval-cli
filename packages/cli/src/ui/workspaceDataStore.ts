import type { WorkspacePanelState } from "./workspacePanel.js";
import type { WorkspaceTab } from "./workspaceTabs.js";

export const WORKSPACE_PANEL_STALE_MS = 5 * 60 * 1000;
export const WORKSPACE_PANEL_STALE_CHECK_MS = 30 * 1000;

export type WorkspacePanelLoadReason = "initial" | "manual" | "stale";
export type WorkspacePanelDataStore = Record<WorkspaceTab, WorkspacePanelState>;

const hasStoredPayload = (state: WorkspacePanelState): boolean =>
  Boolean(state.loadedAt) || Object.keys(state.data).length > 0;

export const getWorkspacePanelLoadReason = ({
  state,
  now,
  staleMs = WORKSPACE_PANEL_STALE_MS,
  cacheKey,
  refreshToken = 0,
}: {
  state: WorkspacePanelState;
  now: number;
  staleMs?: number;
  cacheKey?: string;
  refreshToken?: number;
}): WorkspacePanelLoadReason | undefined => {
  if (state.isRefreshing) {
    return undefined;
  }

  if (refreshToken > (state.lastRefreshToken ?? 0)) {
    return "manual";
  }

  if (!hasStoredPayload(state)) {
    return "initial";
  }

  if (cacheKey && state.cacheKey !== cacheKey) {
    return "initial";
  }

  const staleAt = state.staleAt ?? ((state.loadedAt ?? now) + staleMs);
  return staleAt <= now ? "stale" : undefined;
};

export const markWorkspacePanelRefreshing = ({
  state,
  now,
  reason,
  cacheKey,
  refreshToken = 0,
}: {
  state: WorkspacePanelState;
  now: number;
  reason: WorkspacePanelLoadReason;
  cacheKey?: string;
  refreshToken?: number;
}): WorkspacePanelState => {
  const keepCachedPayload =
    reason !== "initial" && hasStoredPayload(state) && (!cacheKey || state.cacheKey === cacheKey);
  return {
    ...state,
    status: keepCachedPayload ? (state.status === "idle" ? "ready" : state.status) : "loading",
    data: keepCachedPayload ? state.data : {},
    warnings: keepCachedPayload ? state.warnings : [],
    error: keepCachedPayload ? state.error : undefined,
    isRefreshing: true,
    refreshStartedAt: now,
    lastLoadReason: reason,
    cacheKey,
    lastRefreshToken: state.lastRefreshToken ?? 0,
  };
};

export const completeWorkspacePanelRefresh = ({
  previous,
  tab,
  data,
  warnings,
  now,
  staleMs = WORKSPACE_PANEL_STALE_MS,
  cacheKey,
  refreshToken = 0,
  reason,
}: {
  previous: WorkspacePanelState;
  tab: WorkspaceTab;
  data: Record<string, unknown>;
  warnings: string[];
  now: number;
  staleMs?: number;
  cacheKey?: string;
  refreshToken?: number;
  reason: WorkspacePanelLoadReason;
}): WorkspacePanelState => {
  const hasNewPayload = Object.keys(data).length > 0;
  const hasMatchingCachedPayload =
    hasStoredPayload(previous) && (!cacheKey || previous.cacheKey === cacheKey);
  const failedWithoutPayload = warnings.length > 0 && !hasNewPayload;
  const showingCachedPayload = failedWithoutPayload && hasMatchingCachedPayload;

  return {
    tab,
    status: failedWithoutPayload && !hasMatchingCachedPayload ? "error" : "ready",
    data: showingCachedPayload ? previous.data : data,
    warnings,
    error:
      failedWithoutPayload && !hasMatchingCachedPayload
        ? "No dashboard data could be loaded from the backend."
        : undefined,
    loadedAt: showingCachedPayload ? previous.loadedAt : now,
    staleAt: now + staleMs,
    isRefreshing: false,
    refreshStartedAt: undefined,
    lastLoadReason: reason,
    cacheKey,
    lastRefreshToken: refreshToken,
  };
};

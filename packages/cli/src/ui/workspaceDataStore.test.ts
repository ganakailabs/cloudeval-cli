import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKSPACE_PANEL_STALE_MS,
  completeWorkspacePanelRefresh,
  getWorkspacePanelLoadReason,
  markWorkspacePanelRefreshing,
} from "./workspaceDataStore.js";
import type { WorkspacePanelState } from "./workspacePanel.js";

const readyState = (overrides: Partial<WorkspacePanelState> = {}): WorkspacePanelState => ({
  tab: "reports",
  status: "ready",
  data: { reportsSummary: { total_reports: 4 } },
  warnings: [],
  loadedAt: 1_000,
  staleAt: 1_000 + WORKSPACE_PANEL_STALE_MS,
  cacheKey: "reports:user-1:project-1",
  lastRefreshToken: 0,
  ...overrides,
});

test("does not reload a fresh tab from the workspace data store", () => {
  const reason = getWorkspacePanelLoadReason({
    state: readyState(),
    now: 2_000,
    staleMs: WORKSPACE_PANEL_STALE_MS,
    cacheKey: "reports:user-1:project-1",
    refreshToken: 0,
  });

  assert.equal(reason, undefined);
});

test("loads a tab the first time it has no stored data", () => {
  const reason = getWorkspacePanelLoadReason({
    state: {
      tab: "reports",
      status: "idle",
      data: {},
      warnings: [],
    },
    now: 2_000,
    staleMs: WORKSPACE_PANEL_STALE_MS,
    cacheKey: "reports:user-1:project-1",
    refreshToken: 0,
  });

  assert.equal(reason, "initial");
});

test("refreshes a tab after the fixed staleness window", () => {
  const reason = getWorkspacePanelLoadReason({
    state: readyState(),
    now: 1_000 + WORKSPACE_PANEL_STALE_MS + 1,
    staleMs: WORKSPACE_PANEL_STALE_MS,
    cacheKey: "reports:user-1:project-1",
    refreshToken: 0,
  });

  assert.equal(reason, "stale");
});

test("refreshes a tab when a manual refresh token is newer than the stored token", () => {
  const reason = getWorkspacePanelLoadReason({
    state: readyState({ lastRefreshToken: 2 }),
    now: 2_000,
    staleMs: WORKSPACE_PANEL_STALE_MS,
    cacheKey: "reports:user-1:project-1",
    refreshToken: 3,
  });

  assert.equal(reason, "manual");
});

test("keeps existing data visible while a background refresh runs", () => {
  const current = readyState();
  const refreshing = markWorkspacePanelRefreshing({
    state: current,
    now: 2_000,
    reason: "stale",
    cacheKey: "reports:user-1:project-1",
    refreshToken: 0,
  });

  assert.equal(refreshing.status, "ready");
  assert.deepEqual(refreshing.data, current.data);
  assert.equal(refreshing.isRefreshing, true);
  assert.equal(refreshing.refreshStartedAt, 2_000);
});

test("shows loading only for an initial refresh with no stored data", () => {
  const refreshing = markWorkspacePanelRefreshing({
    state: {
      tab: "reports",
      status: "idle",
      data: {},
      warnings: [],
    },
    now: 2_000,
    reason: "initial",
    cacheKey: "reports:user-1:project-1",
    refreshToken: 0,
  });

  assert.equal(refreshing.status, "loading");
  assert.deepEqual(refreshing.data, {});
  assert.equal(refreshing.isRefreshing, true);
});

test("does not show cached payload from a different cache key during an initial refresh", () => {
  const refreshing = markWorkspacePanelRefreshing({
    state: readyState({ cacheKey: "reports:user-1:project-1" }),
    now: 2_000,
    reason: "initial",
    cacheKey: "reports:user-1:project-2",
    refreshToken: 0,
  });

  assert.equal(refreshing.status, "loading");
  assert.deepEqual(refreshing.data, {});
  assert.equal(refreshing.isRefreshing, true);
});

test("does not show cached payload from a different cache key during a manual refresh", () => {
  const refreshing = markWorkspacePanelRefreshing({
    state: readyState({ cacheKey: "reports:user-1:project-1" }),
    now: 2_000,
    reason: "manual",
    cacheKey: "reports:user-1:project-2",
    refreshToken: 1,
  });

  assert.equal(refreshing.status, "loading");
  assert.deepEqual(refreshing.data, {});
  assert.equal(refreshing.isRefreshing, true);
});

test("preserves cached data when a background refresh returns only warnings", () => {
  const current = readyState();
  const refreshed = completeWorkspacePanelRefresh({
    previous: current,
    tab: "reports",
    data: {},
    warnings: ["Reports summary: timeout"],
    now: 3_000,
    staleMs: WORKSPACE_PANEL_STALE_MS,
    cacheKey: "reports:user-1:project-1",
    refreshToken: 0,
    reason: "stale",
  });

  assert.equal(refreshed.status, "ready");
  assert.deepEqual(refreshed.data, current.data);
  assert.equal(refreshed.isRefreshing, false);
  assert.equal(refreshed.error, undefined);
  assert.deepEqual(refreshed.warnings, ["Reports summary: timeout"]);
  assert.equal(refreshed.staleAt, 3_000 + WORKSPACE_PANEL_STALE_MS);
});

test("does not preserve cached payload after a failed refresh for a different cache key", () => {
  const refreshed = completeWorkspacePanelRefresh({
    previous: readyState({ cacheKey: "reports:user-1:project-1" }),
    tab: "reports",
    data: {},
    warnings: ["Reports summary: timeout"],
    now: 3_000,
    staleMs: WORKSPACE_PANEL_STALE_MS,
    cacheKey: "reports:user-1:project-2",
    refreshToken: 0,
    reason: "initial",
  });

  assert.equal(refreshed.status, "error");
  assert.deepEqual(refreshed.data, {});
  assert.equal(refreshed.error, "No dashboard data could be loaded from the backend.");
});

import { fetchCloudEvalJson } from "./apiClient.js";

export type GraphInsightFocus =
  | "overview"
  | "impact"
  | "blast_radius"
  | "critical-paths"
  | "critical_paths"
  | "security"
  | "cost"
  | "changes";

export const normalizeGraphInsightFocus = (
  focus?: string,
): "overview" | "blast_radius" | "critical_paths" | "security" | "cost" | "changes" => {
  const normalized = String(focus ?? "overview").trim().toLowerCase();
  if (normalized === "impact" || normalized === "blast-radius") {
    return "blast_radius";
  }
  if (normalized === "critical-paths" || normalized === "critical_paths") {
    return "critical_paths";
  }
  if (
    normalized === "overview" ||
    normalized === "blast_radius" ||
    normalized === "security" ||
    normalized === "cost" ||
    normalized === "changes"
  ) {
    return normalized;
  }
  throw new Error(
    "Unsupported graph insight focus. Use overview, impact, critical-paths, security, cost, or changes.",
  );
};

type ProjectGraphRequest = {
  baseUrl: string;
  authToken: string;
  userId: string;
  projectId: string;
};

export const getProjectGraph = async (
  input: ProjectGraphRequest & {
    syncVersion?: string;
    asOf?: string;
    includeDiff?: boolean;
  },
): Promise<unknown> =>
  fetchCloudEvalJson({
    baseUrl: input.baseUrl,
    authToken: input.authToken,
    path: `/projects/${encodeURIComponent(input.projectId)}/graph`,
    query: {
      user_id: input.userId,
      sync_version: input.syncVersion,
      as_of: input.asOf,
      include_diff: input.includeDiff,
    },
  });

export const getProjectGraphTimeline = async (
  input: ProjectGraphRequest & { limit?: number },
): Promise<unknown> =>
  fetchCloudEvalJson({
    baseUrl: input.baseUrl,
    authToken: input.authToken,
    path: `/projects/${encodeURIComponent(input.projectId)}/graph/timeline`,
    query: { user_id: input.userId, limit: input.limit },
  });

export const getProjectGraphDiff = async (
  input: ProjectGraphRequest & {
    fromSyncVersion?: string;
    toSyncVersion?: string;
  },
): Promise<unknown> =>
  fetchCloudEvalJson({
    baseUrl: input.baseUrl,
    authToken: input.authToken,
    path: `/projects/${encodeURIComponent(input.projectId)}/graph/diff`,
    query: {
      user_id: input.userId,
      from: input.fromSyncVersion,
      to: input.toSyncVersion,
    },
  });

export const getProjectGraphInsights = async (
  input: ProjectGraphRequest & {
    focus?: string;
    resourceId?: string;
    syncVersion?: string;
    limit?: number;
  },
): Promise<unknown> =>
  fetchCloudEvalJson({
    baseUrl: input.baseUrl,
    authToken: input.authToken,
    path: `/projects/${encodeURIComponent(input.projectId)}/graph/insights`,
    query: {
      user_id: input.userId,
      focus: normalizeGraphInsightFocus(input.focus),
      resource_id: input.resourceId,
      sync_version: input.syncVersion,
      limit: input.limit,
    },
  });

export const listProjectSyncRuns = async (
  input: ProjectGraphRequest & { limit?: number },
): Promise<unknown> =>
  fetchCloudEvalJson({
    baseUrl: input.baseUrl,
    authToken: input.authToken,
    path: `/projects/${encodeURIComponent(input.projectId)}/sync-runs`,
    query: { user_id: input.userId, limit: input.limit },
  });

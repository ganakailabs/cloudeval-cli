import { getCLIHeaders, normalizeApiBase } from "./auth";

export interface IssuesClientOptions {
  baseUrl: string;
  authToken?: string;
  userId: string;
}

export interface ListIssuesItemsOptions extends IssuesClientOptions {
  projectIds?: string[];
  excludeProjectIds?: string[];
  types?: string[];
  severities?: string[];
  pillars?: string[];
  categories?: string[];
  resourceTypes?: string[];
  q?: string;
  minMonthlySavings?: number;
  sort?: "priority" | "severity" | "savings" | "project";
  limit?: number;
  offset?: number;
  allowFullScan?: boolean;
}

export interface GetIssuesItemOptions extends IssuesClientOptions {
  itemId: string;
  projectIds?: string[];
  allowFullScan?: boolean;
}

const appendQuery = (
  url: URL,
  values: Record<string, string | string[] | undefined>
): URL => {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry) {
          url.searchParams.append(key, entry);
        }
      }
      continue;
    }
    if (value) {
      url.searchParams.set(key, value);
    }
  }
  return url;
};

const compactErrorBody = async (response: Response): Promise<string | undefined> => {
  const body = await response.text().catch(() => "");
  const trimmed = body.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > 1000 ? `${trimmed.slice(0, 1000)}...` : trimmed;
};

const fetchJson = async (
  options: IssuesClientOptions,
  path: string,
  query: Record<string, string | string[] | undefined> = {}
): Promise<unknown> => {
  const url = appendQuery(new URL(`${normalizeApiBase(options.baseUrl)}${path}`), {
    user_id: options.userId,
    ...query,
  });
  const response = await fetch(url, {
    headers: getCLIHeaders(options.authToken),
  });
  if (!response.ok) {
    const detail = await compactErrorBody(response);
    throw new Error(
      detail
        ? `Issues request failed (${response.status}): ${detail}`
        : `Issues request failed (${response.status}).`
    );
  }
  return response.json();
};

export const listIssuesItems = async (
  options: ListIssuesItemsOptions
): Promise<unknown> =>
  fetchJson(options, "/issues/items", {
    project_ids: options.projectIds,
    exclude_project_ids: options.excludeProjectIds,
    type: options.types,
    severity: options.severities,
    pillar: options.pillars,
    category: options.categories,
    resource_type: options.resourceTypes,
    q: options.q,
    min_monthly_savings:
      options.minMonthlySavings !== undefined
        ? String(options.minMonthlySavings)
        : undefined,
    sort: options.sort || "priority",
    limit: String(options.limit ?? 50),
    offset: String(options.offset ?? 0),
    allow_full_scan: options.allowFullScan === false ? "false" : "true",
  });

export const getIssuesItem = async (
  options: GetIssuesItemOptions
): Promise<unknown> =>
  fetchJson(options, `/issues/items/${encodeURIComponent(options.itemId)}`, {
    project_ids: options.projectIds,
    allow_full_scan: options.allowFullScan === false ? "false" : "true",
  });

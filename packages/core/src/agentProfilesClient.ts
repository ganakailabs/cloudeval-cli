import type {
  AgentProfileResponse,
  AgentProfilesListResponse,
} from "@cloudeval/shared";
import { getCLIHeaders, normalizeApiBase } from "./auth";

export interface AgentProfileClientOptions {
  baseUrl: string;
  authToken?: string;
}

export interface GetAgentProfileOptions extends AgentProfileClientOptions {
  profileId: string;
}

export class AgentProfileRequestError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body: string;
  readonly code?: string;
  readonly requiresAuth?: boolean;

  constructor(input: {
    status: number;
    statusText: string;
    body: string;
    code?: string;
    requiresAuth?: boolean;
  }) {
    super(
      `Agent Profile request failed with status ${input.status} ${input.statusText}${
        input.body.trim() ? `: ${input.body.trim().slice(0, 1000)}` : ""
      }`
    );
    this.name = "AgentProfileRequestError";
    this.status = input.status;
    this.statusText = input.statusText;
    this.body = input.body;
    this.code = input.code;
    this.requiresAuth = input.requiresAuth;
  }
}

const parseErrorBody = (
  body: string
): { code?: string; requiresAuth?: boolean } => {
  try {
    const parsed = JSON.parse(body) as {
      code?: unknown;
      requiresAuth?: unknown;
    };
    return {
      code: typeof parsed.code === "string" ? parsed.code : undefined,
      requiresAuth:
        typeof parsed.requiresAuth === "boolean"
          ? parsed.requiresAuth
          : undefined,
    };
  } catch {
    return {};
  }
};

export const isAgentProfileAuthRequiredError = (error: unknown): boolean => {
  if (!(error instanceof AgentProfileRequestError)) {
    return false;
  }
  return (
    error.requiresAuth === true ||
    error.code === "AUTH_REQUIRED_PUBLIC" ||
    error.status === 401 ||
    error.status === 403
  );
};

export const isAgentProfileDiscoveryFallbackError = (
  error: unknown
): boolean => {
  if (isAgentProfileAuthRequiredError(error)) {
    return true;
  }
  return error instanceof AgentProfileRequestError && error.status === 404;
};

const fetchAgentProfileJson = async <T>(
  options: AgentProfileClientOptions,
  path: string
): Promise<T> => {
  const response = await fetch(`${normalizeApiBase(options.baseUrl)}${path}`, {
    headers: getCLIHeaders(options.authToken),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const parsed = parseErrorBody(body);
    throw new AgentProfileRequestError({
      status: response.status,
      statusText: response.statusText,
      body,
      code: parsed.code,
      requiresAuth: parsed.requiresAuth,
    });
  }
  return (await response.json()) as T;
};

export const listAgentProfiles = (
  options: AgentProfileClientOptions
): Promise<AgentProfilesListResponse> =>
  fetchAgentProfileJson(options, "/agent-profiles");

export const getAgentProfile = (
  options: GetAgentProfileOptions
): Promise<AgentProfileResponse> =>
  fetchAgentProfileJson(
    options,
    `/agent-profiles/${encodeURIComponent(options.profileId)}`
  );

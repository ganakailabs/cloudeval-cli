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

const fetchAgentProfileJson = async <T>(
  options: AgentProfileClientOptions,
  path: string
): Promise<T> => {
  const response = await fetch(`${normalizeApiBase(options.baseUrl)}${path}`, {
    headers: getCLIHeaders(options.authToken),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Agent Profile request failed with status ${response.status} ${response.statusText}${
        body.trim() ? `: ${body.trim().slice(0, 1000)}` : ""
      }`
    );
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

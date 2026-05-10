import { redactSensitiveText } from "@cloudeval/shared";
import { getCLIHeaders, normalizeApiBase } from "./auth";
import { withIdempotencyHeader } from "./idempotency";

export interface CredentialClientOptions {
  baseUrl: string;
  authToken?: string;
}

export interface CreateCredentialOptions extends CredentialClientOptions {
  template: string;
  name: string;
  projectId: string;
  expires?: string;
  capabilities?: string[];
  idempotencyKey?: string;
}

export interface ListCredentialsOptions extends CredentialClientOptions {
  projectId?: string;
}

export interface GetCredentialOptions extends CredentialClientOptions {
  credentialId: string;
}

export interface RevokeCredentialOptions extends GetCredentialOptions {
  reason?: string;
  idempotencyKey?: string;
}

const compactErrorBody = async (response: Response): Promise<string | undefined> => {
  const body = await response.text().catch(() => "");
  const trimmed = body.trim();
  return trimmed ? redactSensitiveText(trimmed).slice(0, 1000) : undefined;
};

const fetchCredentialJson = async <T>(
  options: CredentialClientOptions,
  path: string,
  request: {
    method?: "GET" | "POST";
    query?: Record<string, string | undefined>;
    body?: Record<string, unknown>;
    idempotencyKey?: string;
  } = {}
): Promise<T> => {
  const url = new URL(`${normalizeApiBase(options.baseUrl)}${path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }
  const headers =
    request.method === "POST"
      ? withIdempotencyHeader(getCLIHeaders(options.authToken), request.idempotencyKey)
      : getCLIHeaders(options.authToken);
  const response = await fetch(url, {
    method: request.method ?? "GET",
    headers,
    ...(request.body ? { body: JSON.stringify(request.body) } : {}),
  });
  if (!response.ok) {
    const body = await compactErrorBody(response);
    throw new Error(
      `Credential request failed with status ${response.status} ${response.statusText}${
        body ? `: ${body}` : ""
      }`
    );
  }
  return (await response.json()) as T;
};

export const getCredentialTemplates = (
  options: CredentialClientOptions
): Promise<unknown> => fetchCredentialJson(options, "/credential-templates");

export const listCredentials = (
  options: ListCredentialsOptions
): Promise<unknown> =>
  fetchCredentialJson(options, "/credentials", {
    query: { project_id: options.projectId },
  });

export const createCredential = (
  options: CreateCredentialOptions
): Promise<unknown> =>
  fetchCredentialJson(options, "/credentials", {
    method: "POST",
    idempotencyKey: options.idempotencyKey,
    body: {
      template: options.template,
      name: options.name,
      ...(options.projectId ? { project_id: options.projectId } : {}),
      ...(options.expires ? { expires: options.expires } : {}),
      ...(options.capabilities?.length ? { capabilities: options.capabilities } : {}),
    },
  });

export const getCredential = (
  options: GetCredentialOptions
): Promise<unknown> =>
  fetchCredentialJson(
    options,
    `/credentials/${encodeURIComponent(options.credentialId)}`
  );

export const revokeCredential = (
  options: RevokeCredentialOptions
): Promise<unknown> =>
  fetchCredentialJson(
    options,
    `/credentials/${encodeURIComponent(options.credentialId)}/revoke`,
    {
      method: "POST",
      idempotencyKey: options.idempotencyKey,
      body: options.reason ? { reason: options.reason } : {},
    }
  );

export const getIdentity = (
  options: CredentialClientOptions
): Promise<unknown> => fetchCredentialJson(options, "/identity");

export const getCapabilities = (
  options: CredentialClientOptions
): Promise<unknown> => fetchCredentialJson(options, "/capabilities");

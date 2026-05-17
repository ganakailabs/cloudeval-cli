import { getCLIHeaders, normalizeApiBase } from "@cloudeval/core";

type QueryValue = string | number | boolean | null | undefined;

export type CloudEvalRequestOptions = {
  baseUrl: string;
  authToken?: string;
  path: string;
  method?: "GET" | "POST";
  query?: Record<string, QueryValue>;
  body?: unknown;
};

const responseErrorMessage = async (response: Response): Promise<string> => {
  const text = await response.text();
  if (!text) {
    return `request failed with status ${response.status}`;
  }
  try {
    const payload = JSON.parse(text);
    const detail = payload?.detail ?? payload?.message ?? payload?.error;
    if (typeof detail === "string") {
      return detail;
    }
    if (detail) {
      return JSON.stringify(detail);
    }
  } catch {
    // Keep the original response text below.
  }
  return text;
};

export const fetchCloudEvalJson = async <T = unknown>({
  baseUrl,
  authToken,
  path,
  method = "GET",
  query = {},
  body,
}: CloudEvalRequestOptions): Promise<T> => {
  const url = new URL(`${normalizeApiBase(baseUrl)}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method,
    headers: getCLIHeaders(authToken),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response));
  }
  return (await response.json()) as T;
};

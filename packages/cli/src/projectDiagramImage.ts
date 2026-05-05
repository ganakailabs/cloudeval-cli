export type ProjectDiagramImageLayout = "architecture" | "dependency";
export type ProjectDiagramImageFormat = "png" | "jpeg" | "svg";
export type ProjectDiagramImageLabels = "all" | "viewport";

export interface ProjectDiagramImageUrlInput {
  frontendUrl: string;
  projectId: string;
  layout?: string;
  format?: string;
  labels?: string;
  userId?: string;
  publicGraph?: boolean;
  syncVersion?: string;
}

export interface ProjectDiagramImageDownloadInput
  extends ProjectDiagramImageUrlInput {
  token?: string;
}

export interface ProjectDiagramImageDownloadResult {
  bytes: Buffer;
  contentType: string;
  url: string;
  headers: Record<string, string>;
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

export const resolveProjectDiagramImageFrontendUrl = (
  input: {
    frontendUrl?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): string => {
  const env = input.env ?? process.env;
  return trimTrailingSlash(
    input.frontendUrl?.trim() ||
      env.CLOUDEVAL_FRONTEND_URL ||
      env.CLOUDEVAL_WEB_URL ||
      "https://cloudeval.ai",
  );
};

export const normalizeProjectDiagramImageLayout = (
  value?: string,
): ProjectDiagramImageLayout => {
  const normalized = (value || "architecture").toLowerCase();
  if (normalized === "architecture" || normalized === "dependency") {
    return normalized;
  }
  throw new Error("Diagram image layout must be architecture or dependency.");
};

export const normalizeProjectDiagramImageFormat = (
  value?: string,
): ProjectDiagramImageFormat => {
  const normalized = (value || "png").toLowerCase();
  if (normalized === "jpg") {
    return "jpeg";
  }
  if (normalized === "png" || normalized === "jpeg" || normalized === "svg") {
    return normalized;
  }
  throw new Error("Diagram image format must be png, jpeg, jpg, or svg.");
};

export const normalizeProjectDiagramImageLabels = (
  value?: string,
): ProjectDiagramImageLabels => {
  const normalized = (value || "all").toLowerCase();
  if (normalized === "all" || normalized === "viewport") {
    return normalized;
  }
  throw new Error("Diagram image labels must be all or viewport.");
};

export const buildProjectDiagramImageDownloadUrl = (
  input: ProjectDiagramImageUrlInput,
): string => {
  if (!input.projectId.trim()) {
    throw new Error("projectId is required.");
  }
  if (input.publicGraph && input.userId) {
    throw new Error(
      "Public diagram image downloads cannot include userId. Remove user scope or remove --public.",
    );
  }

  const url = new URL(
    `/api/projects/${encodeURIComponent(input.projectId)}/diagram-image`,
    `${trimTrailingSlash(input.frontendUrl)}/`,
  );
  url.searchParams.set("layout", normalizeProjectDiagramImageLayout(input.layout));
  url.searchParams.set("format", normalizeProjectDiagramImageFormat(input.format));
  url.searchParams.set("labels", normalizeProjectDiagramImageLabels(input.labels));
  if (input.publicGraph) {
    url.searchParams.set("public", "1");
  } else if (input.userId) {
    url.searchParams.set("user_id", input.userId);
  }
  if (input.syncVersion) {
    url.searchParams.set("sync_version", input.syncVersion);
  }
  return url.toString();
};

const headersToRecord = (headers: Headers): Record<string, string> => {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
};

const errorDetail = (error: unknown): string => {
  const details: string[] = [];
  if (error instanceof Error && error.message) {
    details.push(error.message);
  }
  const cause = (error as { cause?: unknown })?.cause;
  if (cause instanceof Error && cause.message) {
    details.push(cause.message);
  }
  const causeCode = (cause as { code?: unknown } | undefined)?.code;
  if (typeof causeCode === "string" && !details.includes(causeCode)) {
    details.push(causeCode);
  }
  return details.length ? details.join(": ") : "network request failed";
};

const frontendFetchFailureHint = (url: string): string => {
  const parsed = new URL(url);
  const localFrontend =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1";
  if (localFrontend) {
    return `Ensure the frontend dev server is running at ${parsed.origin}, or unset CLOUDEVAL_FRONTEND_URL / pass --frontend-url https://cloudeval.ai for the deployed frontend.`;
  }
  return "Check --frontend-url / CLOUDEVAL_FRONTEND_URL and network connectivity.";
};

const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const extractNextHtmlErrorMessage = (body: string): string => {
  const match = body.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!match) {
    return "";
  }
  try {
    const payload = JSON.parse(decodeHtmlEntities(match[1]));
    const message = payload?.err?.message;
    return typeof message === "string" ? message.split("\n")[0].trim() : "";
  } catch {
    return "";
  }
};

const summarizeErrorBody = (body: string, contentType: string, url: string): string => {
  const trimmed = body.trim();
  if (!trimmed) {
    return "";
  }
  const isHtml =
    contentType.toLowerCase().includes("text/html") ||
    /^<!doctype html/i.test(trimmed) ||
    /^<html[\s>]/i.test(trimmed);
  if (!isHtml) {
    return trimmed.slice(0, 2_000);
  }

  const nextError = extractNextHtmlErrorMessage(trimmed);
  const staleNextCache =
    /vendor-chunks\/@opentelemetry\.js|webpack-runtime\.js|\.next\/server/i.test(
      nextError,
    );
  const hint = staleNextCache
    ? " This usually means a stale Next.js dev server/cache; restart the frontend server and, if it persists, remove .next and start it again."
    : ` ${frontendFetchFailureHint(url)}`;
  return `Frontend returned an HTML error page${
    nextError ? `: ${nextError}` : ""
  }.${hint}`;
};

export const downloadProjectDiagramImage = async (
  input: ProjectDiagramImageDownloadInput,
): Promise<ProjectDiagramImageDownloadResult> => {
  const url = buildProjectDiagramImageDownloadUrl(input);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "image/png,image/jpeg,image/svg+xml",
        ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
      },
    });
  } catch (error) {
    throw new Error(
      `Failed to fetch diagram image from ${url}: ${errorDetail(error)}. ${frontendFetchFailureHint(url)}`,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const summary = summarizeErrorBody(
      body,
      response.headers.get("content-type") || "",
      url,
    );
    throw new Error(
      `Diagram image download failed with status ${response.status} ${response.statusText}${
        summary ? `: ${summary}` : ""
      }`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    bytes,
    contentType: response.headers.get("content-type") || "application/octet-stream",
    url,
    headers: headersToRecord(response.headers),
  };
};

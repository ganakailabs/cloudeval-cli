export type FrontendTarget =
  | "overview"
  | "chat"
  | "projects"
  | "project"
  | "connections"
  | "connection"
  | "reports"
  | "billing";

export interface ResolveFrontendBaseUrlOptions {
  frontendUrl?: string;
  apiBaseUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export interface FrontendLinkOptions {
  baseUrl: string;
  target: FrontendTarget;
  threadId?: string;
  projectId?: string;
  connectionId?: string;
  quick?: boolean;
  templateUrl?: string;
  name?: string;
  description?: string;
  provider?: string;
  autoSubmit?: boolean;
  view?: string;
  layout?: string;
  node?: string | string[];
  resource?: string;
  tab?: string;
  file?: string;
  files?: string | string[];
  cursor?: string;
  selection?: string;
  workspaceFocus?: boolean;
  presentation?: boolean;
  dialog?: string;
  reportType?: string;
  timeRange?: string;
  persona?: string;
  cadence?: string;
  issuesQuery?: string;
  issuesFullscreen?: boolean;
  issuesView?: string;
  downloadPdf?: boolean;
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

export const resolveFrontendBaseUrl = ({
  frontendUrl,
  apiBaseUrl,
  env = process.env,
}: ResolveFrontendBaseUrlOptions = {}): string => {
  const explicit =
    frontendUrl?.trim() || env.CLOUDEVAL_FRONTEND_URL || env.CLOUDEVAL_WEB_URL;
  if (explicit) {
    return trimTrailingSlash(explicit);
  }

  try {
    const api = apiBaseUrl ? new URL(apiBaseUrl) : undefined;
    if (api && ["localhost", "127.0.0.1", "::1"].includes(api.hostname)) {
      return "http://localhost:3000";
    }
  } catch {
    // Fall through to public frontend.
  }

  return "https://www.cloudeval.ai";
};

const appUrl = (baseUrl: string, path: string): URL =>
  new URL(`/app${path.startsWith("/") ? path : `/${path}`}`, `${trimTrailingSlash(baseUrl)}/`);

const setParam = (
  url: URL,
  key: string,
  value: string | number | boolean | undefined
) => {
  if (value !== undefined && value !== "" && value !== false) {
    url.searchParams.set(key, String(value));
  }
};

const setArrayParam = (url: URL, key: string, value: string | string[] | undefined) => {
  if (!value) {
    return;
  }
  url.searchParams.set(key, Array.isArray(value) ? value.join(",") : value);
};

export const buildFrontendUrl = (options: FrontendLinkOptions): string => {
  let url: URL;
  switch (options.target) {
    case "overview":
      url = appUrl(options.baseUrl, "/overview");
      break;
    case "chat":
      url = appUrl(options.baseUrl, "/chat");
      setParam(url, "threadId", options.threadId);
      break;
    case "projects":
      url = appUrl(options.baseUrl, "/projects");
      if (options.quick) {
        setParam(url, "dialog", "quick");
        setParam(url, "template_url", options.templateUrl);
        setParam(url, "name", options.name);
        setParam(url, "description", options.description);
        setParam(url, "provider", options.provider);
        setParam(url, "auto_submit", options.autoSubmit ? "true" : undefined);
      }
      break;
    case "project":
      if (!options.projectId) {
        throw new Error("projectId is required for project frontend links.");
      }
      url = appUrl(options.baseUrl, `/projects/${encodeURIComponent(options.projectId)}`);
      setParam(url, "view", options.view);
      setParam(url, "layout", options.layout);
      setArrayParam(url, "node", options.node);
      setParam(url, "resource", options.resource);
      setParam(url, "tab", options.tab);
      setParam(url, "file", options.file);
      setArrayParam(url, "files", options.files);
      setParam(url, "cursor", options.cursor);
      setParam(url, "selection", options.selection);
      setParam(url, "workspaceFocus", options.workspaceFocus ? "true" : undefined);
      setParam(url, "mode", options.presentation ? "presentation" : undefined);
      break;
    case "connections":
      url = appUrl(options.baseUrl, "/connections");
      setParam(url, "dialog", options.dialog);
      break;
    case "connection":
      if (!options.connectionId) {
        throw new Error("connectionId is required for connection frontend links.");
      }
      url = appUrl(options.baseUrl, `/connections/${encodeURIComponent(options.connectionId)}`);
      break;
    case "reports":
      url = options.projectId
        ? appUrl(options.baseUrl, `/reports/${encodeURIComponent(options.projectId)}`)
        : appUrl(options.baseUrl, "/reports");
      setParam(url, "tab", options.tab);
      setParam(url, "reportType", options.reportType);
      setParam(url, "timeRange", options.timeRange);
      setParam(url, "persona", options.persona);
      setParam(url, "cadence", options.cadence);
      setParam(url, "issuesQuery", options.issuesQuery);
      setParam(url, "issuesFullscreen", options.issuesFullscreen ? "1" : undefined);
      setParam(url, "issuesView", options.issuesView);
      setParam(url, "downloadPdf", options.downloadPdf ? "1" : undefined);
      break;
    case "billing":
      url = appUrl(options.baseUrl, "/subscription");
      setParam(url, "tab", options.tab);
      break;
    default:
      throw new Error(`Unsupported frontend target '${String(options.target)}'.`);
  }
  return url.toString();
};

export const openExternalUrl = async (url: string): Promise<void> => {
  const { spawn } = await import("node:child_process");
  const platform = process.platform;
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
};

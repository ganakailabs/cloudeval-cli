import { getCLIHeaders, normalizeApiBase, type Project } from "./auth";

export type CloudProvider = "azure" | "aws" | "gcp";

export interface ParsedTemplateUrl {
  normalizedUrl: string;
  githubUrl: string;
  cloudProvider: CloudProvider;
  suggestedName: string;
  suggestedDescription: string;
  owner: string;
  repo: string;
  branch: string;
  filePath: string;
}

export interface ConnectionRequest {
  user_id: string;
  name: string;
  cloud_provider: CloudProvider;
  description: string;
  type: "template" | "sync";
  template_url?: string;
  parameters_file_url?: string;
  auto_sync?: boolean;
}

export interface ProjectRequest {
  user_id: string;
  name: string;
  description: string;
  cloud_provider: CloudProvider;
  connection_ids: string[];
  type: "template" | "sync";
  report_config: {
    auto_generate_reports: boolean;
    include_cost_report: boolean;
    include_cost_forecast: boolean;
    region: string;
    currency: string;
  };
}

export interface QuickProjectInput {
  baseUrl?: string;
  authToken?: string;
  userId: string;
  templateUrl?: string;
  templateFile?: Blob;
  templateFileName?: string;
  parametersFile?: Blob;
  parametersFileName?: string;
  parametersUrl?: string;
  name?: string;
  description?: string;
  provider?: CloudProvider;
}

export interface QuickProjectPayload {
  connection: ConnectionRequest;
  project: ProjectRequest;
  normalizedTemplateUrl?: string;
  inferred: ParsedTemplateUrl | null;
}

export interface QuickProjectResult {
  project: Project;
  connection: Record<string, unknown>;
  syncStatus?: unknown;
  normalizedTemplateUrl?: string;
  inferred: ParsedTemplateUrl | null;
}

const providerValues = new Set(["azure", "aws", "gcp"]);

const sanitizeNamePart = (value: string): string =>
  value
    .replace(/\.(json|yaml|yml|tf)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const inferCloudProvider = (
  owner: string,
  repo: string,
  filePath: string
): CloudProvider => {
  const haystack = `${owner}/${repo}/${filePath}`.toLowerCase();
  if (haystack.includes("aws") || haystack.includes("cloudformation")) {
    return "aws";
  }
  if (haystack.includes("gcp") || haystack.includes("google")) {
    return "gcp";
  }
  return "azure";
};

const generateProjectName = (filePath: string, repo: string): string => {
  const parts = filePath.split("/").filter(Boolean);
  const file = parts[parts.length - 1] || repo;
  const parent = parts.length > 1 ? parts[parts.length - 2] : "";
  if (/^azuredeploy\.json$/i.test(file) && parent) {
    return sanitizeNamePart(parent);
  }
  return sanitizeNamePart(file || repo) || repo;
};

export const parseTemplateUrl = (value: string): ParsedTemplateUrl | null => {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname === "raw.githubusercontent.com") {
      if (parts.length < 3) {
        return null;
      }
      const [owner, repo, branch, ...fileParts] = parts;
      const filePath = fileParts.join("/");
      return {
        normalizedUrl: value,
        githubUrl: `https://github.com/${owner}/${repo}/blob/${branch}/${filePath}`,
        cloudProvider: inferCloudProvider(owner, repo, filePath),
        suggestedName: generateProjectName(filePath, repo),
        suggestedDescription: `Template from ${owner}/${repo}`,
        owner,
        repo,
        branch,
        filePath,
      };
    }

    if (url.hostname !== "github.com" || parts.length < 4) {
      return null;
    }
    const [owner, repo, type, branch, ...rest] = parts;
    if (type !== "blob" && type !== "tree") {
      return null;
    }
    const rawRest = rest.join("/");
    const filePath = rawRest && /\.(json|yaml|yml|tf)$/i.test(rawRest)
      ? rawRest
      : rawRest
        ? `${rawRest}/azuredeploy.json`
        : "azuredeploy.json";
    return {
      normalizedUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`,
      githubUrl: value,
      cloudProvider: inferCloudProvider(owner, repo, filePath),
      suggestedName: generateProjectName(filePath, repo),
      suggestedDescription: `Template from ${owner}/${repo}`,
      owner,
      repo,
      branch,
      filePath,
    };
  } catch {
    return null;
  }
};

export const buildQuickProjectPayload = (
  input: Omit<QuickProjectInput, "baseUrl" | "authToken" | "templateFile" | "parametersFile" | "templateFileName" | "parametersFileName">
): QuickProjectPayload => {
  const inferred = input.templateUrl ? parseTemplateUrl(input.templateUrl) : null;
  const normalizedTemplateUrl = inferred?.normalizedUrl ?? input.templateUrl;
  const provider = input.provider ?? inferred?.cloudProvider ?? "azure";
  if (!providerValues.has(provider)) {
    throw new Error(`Unsupported cloud provider '${provider}'.`);
  }
  const name = input.name?.trim() || inferred?.suggestedName || "Quick Project";
  const description =
    input.description?.trim() ||
    inferred?.suggestedDescription ||
    `Template project for ${name}`;

  const connection: ConnectionRequest = {
    user_id: input.userId,
    name: `${name} Connection`,
    cloud_provider: provider,
    description,
    type: "template",
    ...(normalizedTemplateUrl ? { template_url: normalizedTemplateUrl } : {}),
    ...(input.parametersUrl ? { parameters_file_url: input.parametersUrl } : {}),
    auto_sync: true,
  };

  const project: ProjectRequest = {
    user_id: input.userId,
    name,
    description,
    cloud_provider: provider,
    connection_ids: [],
    type: "template",
    report_config: {
      auto_generate_reports: true,
      include_cost_report: true,
      include_cost_forecast: true,
      region: "eastus",
      currency: "USD",
    },
  };

  return {
    connection,
    project,
    normalizedTemplateUrl,
    inferred,
  };
};

const responseJson = async <T>(response: Response, label: string): Promise<T> => {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `${label} failed with status ${response.status} ${response.statusText}${
        body.trim() ? `: ${body.trim()}` : ""
      }`
    );
  }
  return (await response.json()) as T;
};

const appendConnectionBody = (
  payload: ConnectionRequest,
  input: QuickProjectInput
): BodyInit => {
  if (!input.templateFile && !input.parametersFile) {
    return JSON.stringify(payload);
  }
  const formData = new FormData();
  formData.append("user_id", payload.user_id);
  formData.append("name", payload.name);
  formData.append("cloud_provider", payload.cloud_provider);
  formData.append("description", payload.description);
  formData.append("type", payload.type);
  formData.append("auto_sync", String(payload.auto_sync ?? true));
  if (payload.template_url) {
    formData.append("template_url", payload.template_url);
  }
  if (payload.parameters_file_url) {
    formData.append("parameters_file_url", payload.parameters_file_url);
  }
  if (input.templateFile) {
    formData.append("template_file", input.templateFile, input.templateFileName || "template.json");
  }
  if (input.parametersFile) {
    formData.append(
      "parameters_file",
      input.parametersFile,
      input.parametersFileName || "parameters.json"
    );
  }
  return formData;
};

const headersForBody = (
  authToken: string | undefined,
  body: BodyInit
): Record<string, string> => {
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const headers = getCLIHeaders(authToken);
    delete headers["Content-Type"];
    return headers;
  }
  return getCLIHeaders(authToken);
};

export const createQuickProject = async (
  input: QuickProjectInput & { baseUrl: string; authToken?: string }
): Promise<QuickProjectResult> => {
  if (!input.templateUrl && !input.templateFile) {
    throw new Error("Provide --template-url or --template-file.");
  }
  const built = buildQuickProjectPayload(input);
  const apiBase = normalizeApiBase(input.baseUrl);
  const connectionBody = appendConnectionBody(built.connection, input);
  const connection = await responseJson<Record<string, unknown>>(
    await fetch(`${apiBase}/connection/`, {
      method: "POST",
      headers: headersForBody(input.authToken, connectionBody),
      body: connectionBody,
    }),
    "Connection creation"
  );
  const connectionId = String(connection.id || "");
  if (!connectionId) {
    throw new Error("Connection creation did not return a connection id.");
  }

  const projectPayload = {
    ...built.project,
    connection_ids: [connectionId],
  };
  const project = await responseJson<Project>(
    await fetch(`${apiBase}/projects/`, {
      method: "POST",
      headers: getCLIHeaders(input.authToken),
      body: JSON.stringify(projectPayload),
    }),
    "Project creation"
  );

  return {
    project,
    connection,
    syncStatus: connection.sync_status ?? connection.sync_job ?? null,
    normalizedTemplateUrl: built.normalizedTemplateUrl,
    inferred: built.inferred,
  };
};

export const listConnections = async (
  options: { baseUrl: string; authToken?: string; userId: string }
): Promise<Record<string, unknown>[]> => {
  const response = await fetch(
    `${normalizeApiBase(options.baseUrl)}/connection/user/${encodeURIComponent(options.userId)}`,
    { method: "GET", headers: getCLIHeaders(options.authToken) }
  );
  return responseJson(response, "List connections");
};

export const getConnection = async (
  options: { baseUrl: string; authToken?: string; userId: string; connectionId: string }
): Promise<Record<string, unknown> | null> => {
  const connections = await listConnections(options);
  return connections.find((connection) => String(connection.id) === options.connectionId) ?? null;
};

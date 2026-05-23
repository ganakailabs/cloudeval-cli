import { redactSensitiveText } from "@cloudeval/shared";
import { getCLIHeaders, normalizeApiBase, type Project } from "./auth";
import { withIdempotencyHeader } from "./idempotency";

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
  workspaceFiles?: WorkspaceFileInput[];
  workspaceEntry?: string;
  cloudSync?: AzureCloudSyncInput;
}

export interface WorkspaceFileInput {
  path: string;
  blob: Blob;
}

export interface AzureCloudSyncInput {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
  resourceGroups?: string[];
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
  iacPipeline?: Record<string, any>;
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
  if (input.cloudSync && provider !== "azure") {
    throw new Error("Cloud sync project creation currently supports Azure only.");
  }
  const name = input.name?.trim() || inferred?.suggestedName || "Quick Project";
  const description =
    input.description?.trim() ||
    inferred?.suggestedDescription ||
    (input.cloudSync ? `Cloud sync project for ${name}` : `Template project for ${name}`);

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
    const redactedBody = redactSensitiveText(body.trim());
    throw new Error(
      `${label} failed with status ${response.status} ${response.statusText}${
        redactedBody ? `: ${redactedBody}` : ""
      }`
    );
  }
  return (await response.json()) as T;
};

const formatResponseError = (
  response: Response,
  label: string,
  body: string
): Error => {
  const redactedBody = redactSensitiveText(body.trim());
  return new Error(
    `${label} failed with status ${response.status} ${response.statusText}${
      redactedBody ? `: ${redactedBody}` : ""
    }`
  );
};

const buildInlineWorkspaceImportRequest = async (
  workspaceFiles: WorkspaceFileInput[]
) => ({
  source: "upload" as const,
  files: await Promise.all(
    workspaceFiles.map(async (file) => ({
      path: file.path,
      content: await file.blob.text(),
    }))
  ),
});

const runIacPipeline = async (
  input: QuickProjectInput & { baseUrl: string; authToken?: string },
  projectId: string,
  connectionId: string
): Promise<Record<string, any>> => {
  const apiBase = normalizeApiBase(input.baseUrl);
  const pipelineUrl = `${apiBase}/projects/${encodeURIComponent(projectId)}/iac/pipeline?user_id=${encodeURIComponent(input.userId)}`;
  const connectionImportBody = {
    import_request: { source: "connection", connection_id: connectionId },
    resolve: true,
    refresh_analysis: true,
  };
  const response = await fetch(pipelineUrl, {
    method: "POST",
    headers: withIdempotencyHeader(getCLIHeaders(input.authToken)),
    body: JSON.stringify(connectionImportBody),
  });
  if (response.ok) {
    return (await response.json()) as Record<string, any>;
  }

  const failureBody = await response.text().catch(() => "");
  const workspaceFiles = input.workspaceFiles ?? [];
  const canRetryAsUpload =
    response.status === 422 &&
    workspaceFiles.length > 0 &&
    /source/i.test(failureBody) &&
    /upload/i.test(failureBody);
  if (!canRetryAsUpload) {
    throw formatResponseError(response, "IaC pipeline", failureBody);
  }

  const uploadImportBody = {
    import_request: await buildInlineWorkspaceImportRequest(workspaceFiles),
    resolve: true,
    refresh_analysis: true,
  };
  const retryResponse = await fetch(pipelineUrl, {
    method: "POST",
    headers: withIdempotencyHeader(getCLIHeaders(input.authToken)),
    body: JSON.stringify(uploadImportBody),
  });
  return responseJson<Record<string, any>>(retryResponse, "IaC pipeline");
};

const appendConnectionBody = (
  payload: ConnectionRequest,
  input: QuickProjectInput
): BodyInit => {
  if (input.cloudSync) {
    return JSON.stringify({
      ...payload,
      subscription_id: input.cloudSync.subscriptionId,
      target_resource_groups: input.cloudSync.resourceGroups ?? [],
      credentials: {
        tenant_id: input.cloudSync.tenantId,
        client_id: input.cloudSync.clientId,
        client_secret: input.cloudSync.clientSecret,
        subscription_id: input.cloudSync.subscriptionId,
      },
    });
  }

  if (input.workspaceFiles?.length) {
    const entryPath = input.workspaceEntry || input.workspaceFiles[0]?.path;
    const entry = input.workspaceFiles.find((file) => file.path === entryPath);
    if (!entry) {
      throw new Error(`Workspace entry file '${entryPath}' was not found.`);
    }

    const formData = new FormData();
    formData.append("user_id", payload.user_id);
    formData.append("name", payload.name);
    formData.append("cloud_provider", payload.cloud_provider);
    formData.append("description", payload.description);
    formData.append("type", payload.type);
    formData.append("auto_sync", String(payload.auto_sync ?? true));
    formData.append("visualization_source_path", entry.path);
    formData.append("template_file", entry.blob, entry.path);

    const workspaceFilePaths: string[] = [];
    for (const file of input.workspaceFiles) {
      if (file.path === entry.path) {
        continue;
      }
      workspaceFilePaths.push(file.path);
      formData.append("workspace_files", file.blob, file.path);
    }
    formData.append("workspace_file_paths", JSON.stringify(workspaceFilePaths));
    return formData;
  }

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
  if (
    !input.templateUrl &&
    !input.templateFile &&
    !input.workspaceFiles?.length &&
    !input.cloudSync
  ) {
    throw new Error("Provide --template-url, --template-file, --workspace-dir, or --cloud-sync.");
  }
  const built = buildQuickProjectPayload(input);
  if (input.cloudSync) {
    built.connection.type = "sync";
    built.connection.auto_sync = true;
    built.project.type = "sync";
    built.project.report_config.include_cost_forecast = true;
  }
  const apiBase = normalizeApiBase(input.baseUrl);
  const connectionBody = appendConnectionBody(built.connection, input);
  const connection = await responseJson<Record<string, unknown>>(
    await fetch(`${apiBase}/connection/`, {
      method: "POST",
      headers: withIdempotencyHeader(headersForBody(input.authToken, connectionBody)),
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
      headers: withIdempotencyHeader(getCLIHeaders(input.authToken)),
      body: JSON.stringify(projectPayload),
    }),
    "Project creation"
  );

  let iacPipeline: Record<string, any> | undefined;
  if (!input.cloudSync) {
    iacPipeline = await runIacPipeline(
      input,
      String(project.id),
      connectionId
    );
  }

  return {
    project,
    connection,
    syncStatus: connection.sync_status ?? connection.sync_job ?? null,
    normalizedTemplateUrl: built.normalizedTemplateUrl,
    inferred: built.inferred,
    iacPipeline,
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

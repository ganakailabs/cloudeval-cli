import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import {
  buildFrontendUrl,
  openExternalUrl,
  resolveFrontendBaseUrl,
  type FrontendTarget,
} from "./frontendLinks.js";
import { getFirstNameForDisplay } from "./ui/userDisplayName.js";
import { loadCliConfig, normalizeConfigProfile } from "./cliConfig.js";
import { recordSessionTurn } from "./sessionsStore.js";
import { CLI_VERSION } from "./version.js";
import {
  writeFormattedOutput,
  formatErrorEnvelope,
  formatSuccessEnvelope,
  type MachineOutputFormat,
  type SuccessEnvelope,
} from "./outputFormatter.js";
import { resolveReportProjectId } from "./reports/reportProject.js";
import {
  MCP_SETUP_CLIENTS,
  buildMcpClientSetup,
  normalizeMcpSetupClient,
  normalizeMcpSetupToolset,
  writeMcpClientConfig,
} from "./mcpSetupCommand.js";
import {
  downloadProjectDiagramImage,
  normalizeProjectDiagramImageFormat,
  normalizeProjectDiagramImageLabels,
  normalizeProjectDiagramImageLayout,
  resolveProjectDiagramImageFrontendUrl,
} from "./projectDiagramImage.js";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonRecord = Record<string, unknown>;

type JsonRpcId = string | number;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: JsonRecord;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: JsonRecord;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: JsonRecord;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: JsonRecord;
  isError?: boolean;
};

type ToolHandler = (args: JsonRecord) => Promise<SuccessEnvelope>;

type JsonSchema = Record<string, unknown>;

interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: JsonRecord;
}

interface McpResourceDefinition {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

interface McpPromptDefinition {
  name: string;
  title: string;
  description: string;
  arguments?: Array<{
    name: string;
    description: string;
    required?: boolean;
  }>;
}

export interface RegisterMcpCommandOptions {
  defaultBaseUrl: string;
  resolveBaseUrl: (
    options: { baseUrl?: string },
    command?: Command,
  ) => Promise<string>;
}

interface ServeMcpOptions {
  baseUrl: string;
  frontendUrl?: string;
  profile?: string;
  apiKey?: string;
  machine?: boolean;
  verbose?: boolean;
  toolset?: McpToolsetName;
}

interface InvocationConfig {
  baseUrl: string;
  frontendUrl?: string;
  profile: string;
  defaultProjectId?: string;
  model?: string;
  apiKey?: string;
  machine: boolean;
}

type ReportRunType = "cost" | "waf" | "architecture" | "unit-tests" | "all";
type DownloadReportType = "cost" | "waf" | "architecture" | "all";
type ReportView = "raw" | "parsed" | "formatted";
type BillingGranularity = "hour" | "day" | "month";
type McpToolsetName = "all" | "readonly" | "projects" | "reports" | "billing";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const STREAM_OUTPUT_NODES = new Set([
  "generate_response",
  "handle_social_interaction",
  "response_compose",
]);
const DEFAULT_REPORT_REGION = "eastus";
const DEFAULT_REPORT_CURRENCY = "USD";

const envelopeSchema: JsonSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    command: { type: "string" },
    data: {
      description: "Tool-specific result payload.",
    },
    frontendUrl: { type: "string" },
    filesWritten: {
      type: "array",
      items: { type: "string" },
    },
    traceId: { type: "string" },
  },
  required: ["ok", "command", "data"],
  additionalProperties: true,
};

const commonToolProperties = {
  baseUrl: {
    type: "string",
    description:
      "CloudEval API base URL. Defaults to the MCP server --base-url, active profile, CLOUDEVAL_BASE_URL, or the public API.",
  },
  frontendUrl: {
    type: "string",
    description:
      "CloudEval frontend base URL for generated links. Defaults to --frontend-url, active profile, CLOUDEVAL_FRONTEND_URL, or public frontend.",
  },
  profile: {
    type: "string",
    description:
      "CloudEval CLI config profile to read defaults from. Defaults to the server --profile or CLOUDEVAL_PROFILE.",
  },
  apiKey: {
    type: "string",
    description:
      "Optional API key for this call. Prefer MCP client env configuration or stored `cloudeval login` credentials.",
  },
  machine: {
    type: "boolean",
    description:
      "Allow service-principal machine authentication from environment credentials.",
  },
};

const projectIdProperty = {
  type: "string",
  description:
    "CloudEval project id. Defaults to active profile defaultProjectId, then Playground/first project where supported.",
};

const makeInputSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): JsonSchema => ({
  type: "object",
  properties: {
    ...properties,
    ...commonToolProperties,
  },
  required,
  additionalProperties: false,
});

export const mcpToolDefinitions: McpToolDefinition[] = [
  {
    name: "capabilities.get",
    title: "Get CloudEval Capabilities",
    description:
      "Return CloudEval CLI and MCP capability metadata for agent planning.",
    inputSchema: makeInputSchema({}),
    outputSchema: envelopeSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "projects.list",
    title: "List Projects",
    description:
      "List CloudEval projects visible to the authenticated account.",
    inputSchema: makeInputSchema({}),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "projects.get",
    title: "Get Project",
    description:
      "Fetch one CloudEval project by id from the authenticated account's project list.",
    inputSchema: makeInputSchema(
      {
        projectId: {
          ...projectIdProperty,
          description: "CloudEval project id to fetch.",
        },
      },
      ["projectId"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "projects.exportDiagram",
    title: "Export Project Diagram",
    description:
      "Export a GraphEditor-rendered architecture or dependency diagram to a local PNG, JPEG, or SVG file for CLI and MCP agents.",
    inputSchema: makeInputSchema(
      {
        projectId: {
          ...projectIdProperty,
          description: "CloudEval project id to render.",
        },
        layout: {
          type: "string",
          enum: ["architecture", "dependency"],
          default: "architecture",
        },
        format: {
          type: "string",
          enum: ["png", "jpeg", "jpg", "svg"],
          default: "png",
        },
        labels: {
          type: "string",
          enum: ["all", "viewport"],
          default: "all",
        },
        outputPath: {
          type: "string",
          description: "Absolute or relative local path for the downloaded image.",
        },
        headersOutputPath: {
          type: "string",
          description: "Optional local path for response headers.",
        },
        public: {
          type: "boolean",
          description:
            "Use the explicit public/share graph without sending private auth.",
          default: false,
        },
        syncVersion: {
          type: "string",
          description: "Optional project sync version.",
        },
      },
      ["projectId", "outputPath"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "ask",
    title: "Ask CloudEval",
    description:
      "Ask CloudEval a one-shot question, optionally scoped to a project and model.",
    inputSchema: makeInputSchema(
      {
        question: {
          type: "string",
          description: "Question or instruction to send to CloudEval.",
        },
        projectId: projectIdProperty,
        model: {
          type: "string",
          description:
            "Model name. Defaults to active profile model if configured.",
        },
        threadId: {
          type: "string",
          description:
            "Optional thread id to use for this one-shot ask. Defaults to a generated UUID.",
        },
      },
      ["question"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "reports.list",
    title: "List Reports",
    description: "List cost and Well-Architected reports for a project.",
    inputSchema: makeInputSchema({
      projectId: projectIdProperty,
      kind: {
        type: "string",
        enum: ["all", "cost", "waf"],
        description: "Report kind filter.",
        default: "all",
      },
    }),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "reports.run",
    title: "Run Reports",
    description:
      "Submit report generation jobs for a project. This can consume backend compute and credits.",
    inputSchema: makeInputSchema({
      projectId: projectIdProperty,
      type: {
        type: "string",
        enum: ["cost", "waf", "architecture", "unit-tests", "all"],
        default: "all",
      },
      region: {
        type: "string",
        description: "Cost report region.",
        default: DEFAULT_REPORT_REGION,
      },
      currency: {
        type: "string",
        description: "Cost report currency.",
        default: DEFAULT_REPORT_CURRENCY,
      },
      includeTimeSeries: {
        type: "boolean",
        description: "Include cost report time-series generation.",
        default: true,
      },
      saveReport: {
        type: "boolean",
        description: "Persist generated report artifacts.",
        default: true,
      },
      wait: {
        type: "boolean",
        description: "Poll submitted jobs until they reach a terminal state.",
        default: false,
      },
      pollIntervalMs: {
        type: "number",
        description: "Polling interval when wait is true.",
        default: 2500,
      },
    }),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "reports.download",
    title: "Download Reports",
    description:
      "Fetch raw, parsed, or formatted report payloads. Optionally write them to a local output path.",
    inputSchema: makeInputSchema({
      projectId: projectIdProperty,
      type: {
        type: "string",
        enum: ["cost", "waf", "architecture", "all"],
        default: "all",
      },
      view: {
        type: "string",
        enum: ["raw", "parsed", "formatted"],
        default: "raw",
      },
      timestamp: {
        type: "string",
        description: "Historical report timestamp.",
      },
      outputPath: {
        type: "string",
        description:
          "Optional local file or directory path. Multiple report types write separate JSON files under a directory.",
      },
    }),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "billing.summary",
    title: "Billing Summary",
    description:
      "Return CloudEval billing entitlement, credit status, and subscription status.",
    inputSchema: makeInputSchema({}),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "billing.usage",
    title: "Billing Usage",
    description:
      "Return CloudEval billing usage summary with date, granularity, and model filters.",
    inputSchema: makeInputSchema({
      range: {
        type: "string",
        enum: ["7d", "30d", "90d", "all"],
        default: "30d",
      },
      startAt: { type: "string", description: "Start timestamp." },
      endAt: { type: "string", description: "End timestamp." },
      granularity: {
        type: "string",
        enum: ["hour", "day", "month"],
        default: "day",
      },
      actionType: { type: "string" },
      model: { type: "string" },
      outcome: { type: "string" },
      chargeStatus: { type: "string" },
    }),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "billing.ledger",
    title: "Billing Ledger",
    description: "Return paginated CloudEval billing ledger entries.",
    inputSchema: makeInputSchema({
      range: {
        type: "string",
        enum: ["7d", "30d", "90d", "all"],
        default: "30d",
      },
      startAt: { type: "string", description: "Start timestamp." },
      endAt: { type: "string", description: "End timestamp." },
      actionType: { type: "string" },
      model: { type: "string" },
      outcome: { type: "string" },
      chargeStatus: { type: "string" },
      limit: { type: "number", default: 25 },
      cursor: { type: "string" },
    }),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "open.url",
    title: "Build Frontend URL",
    description:
      "Build a CloudEval frontend deep link. Optionally open it in the system browser.",
    inputSchema: makeInputSchema(
      {
        target: {
          type: "string",
          enum: [
            "overview",
            "chat",
            "projects",
            "project",
            "connections",
            "connection",
            "reports",
            "billing",
          ],
        },
        open: {
          type: "boolean",
          description:
            "Open the URL with the system browser. Defaults to false for MCP safety.",
          default: false,
        },
        threadId: { type: "string" },
        projectId: { type: "string" },
        connectionId: { type: "string" },
        quick: { type: "boolean" },
        templateUrl: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        provider: { type: "string" },
        autoSubmit: { type: "boolean" },
        view: { type: "string" },
        layout: { type: "string" },
        node: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        resource: { type: "string" },
        tab: { type: "string" },
        file: { type: "string" },
        files: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        cursor: { type: "string" },
        selection: { type: "string" },
        workspaceFocus: { type: "boolean" },
        presentation: { type: "boolean" },
        dialog: { type: "string" },
        reportType: { type: "string" },
        timeRange: { type: "string" },
        persona: { type: "string" },
        cadence: { type: "string" },
        issuesQuery: { type: "string" },
        issuesFullscreen: { type: "boolean" },
        issuesView: { type: "string" },
        downloadPdf: { type: "boolean" },
        pdfVerbosity: { type: "string" },
        downloadReport: {
          type: "string",
          enum: ["pdf", "markdown", "json"],
        },
        reportVerbosity: {
          type: "string",
          enum: ["brief", "detailed", "evidence"],
        },
      },
      ["target"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
];

export const mcpToolNames = mcpToolDefinitions.map((tool) => tool.name);

const toolByName = new Map(mcpToolDefinitions.map((tool) => [tool.name, tool]));
const MCP_TOOL_ALIASES: Record<string, string> = {
  "projects.diagramImage": "projects.exportDiagram",
};

const MCP_TOOLSETS: Record<McpToolsetName, readonly string[]> = {
  all: mcpToolNames,
  readonly: [
    "capabilities.get",
    "projects.list",
    "projects.get",
    "reports.list",
    "billing.summary",
    "billing.usage",
    "billing.ledger",
  ],
  projects: [
    "capabilities.get",
    "projects.list",
    "projects.get",
    "projects.exportDiagram",
    "open.url",
  ],
  reports: [
    "capabilities.get",
    "projects.list",
    "projects.get",
    "reports.list",
    "reports.run",
    "reports.download",
    "open.url",
  ],
  billing: [
    "capabilities.get",
    "billing.summary",
    "billing.usage",
    "billing.ledger",
    "open.url",
  ],
};

const MCP_TOOLSET_NAMES = Object.keys(MCP_TOOLSETS) as McpToolsetName[];

const normalizeMcpToolset = (value?: string): McpToolsetName => {
  const normalized = (value ?? "all").toLowerCase();
  if ((MCP_TOOLSET_NAMES as readonly string[]).includes(normalized)) {
    return normalized as McpToolsetName;
  }
  throw new Error(`Unknown MCP toolset '${value}'. Expected one of: ${MCP_TOOLSET_NAMES.join(", ")}.`);
};

const toolsForToolset = (toolset: McpToolsetName): McpToolDefinition[] => {
  const names = new Set(MCP_TOOLSETS[toolset]);
  return mcpToolDefinitions.filter((tool) => names.has(tool.name));
};

const mcpResourceDefinitions: McpResourceDefinition[] = [
  {
    uri: "cloudeval://capabilities",
    name: "capabilities",
    title: "CloudEval Capabilities",
    description: "CloudEval CLI and MCP capability metadata.",
    mimeType: "application/json",
  },
  {
    uri: "cloudeval://projects",
    name: "projects",
    title: "CloudEval Projects",
    description: "Projects visible to the authenticated CloudEval account.",
    mimeType: "application/json",
  },
  {
    uri: "cloudeval://billing/summary",
    name: "billing-summary",
    title: "CloudEval Billing Summary",
    description: "Billing entitlement, credits, and subscription status.",
    mimeType: "application/json",
  },
  {
    uri: "cloudeval://reports/latest",
    name: "latest-reports",
    title: "Latest CloudEval Reports",
    description: "Latest cost and Well-Architected report list for the default project.",
    mimeType: "application/json",
  },
];

const mcpPromptDefinitions: McpPromptDefinition[] = [
  {
    name: "cost-review",
    title: "Cost Review",
    description: "Review CloudEval cost posture, usage trends, and savings opportunities.",
    arguments: [
      { name: "projectId", description: "CloudEval project id to review." },
      { name: "range", description: "Usage/report range such as 7d, 30d, or 90d." },
    ],
  },
  {
    name: "waf-triage",
    title: "Well-Architected Triage",
    description: "Triage critical Well-Architected findings and next remediation steps.",
    arguments: [
      { name: "projectId", description: "CloudEval project id to triage." },
      { name: "severity", description: "Finding severity focus.", required: false },
    ],
  },
  {
    name: "architecture-review",
    title: "Architecture Review",
    description: "Review a project architecture for reliability, cost, security, and operational risks.",
    arguments: [
      { name: "projectId", description: "CloudEval project id to review." },
    ],
  },
  {
    name: "billing-review",
    title: "Billing Review",
    description: "Summarize billing usage, credits, ledger anomalies, and recommended actions.",
    arguments: [
      { name: "range", description: "Usage range such as 7d, 30d, 90d, or all." },
    ],
  },
];

const MCP_RESOURCE_TOOL_REQUIREMENTS: Record<string, readonly string[]> = {
  "cloudeval://capabilities": ["capabilities.get"],
  "cloudeval://projects": ["projects.list"],
  "cloudeval://billing/summary": ["billing.summary"],
  "cloudeval://reports/latest": ["reports.list"],
};

const MCP_PROMPT_TOOL_REQUIREMENTS: Record<string, readonly string[]> = {
  "cost-review": ["reports.list", "billing.usage"],
  "waf-triage": ["reports.list"],
  "architecture-review": ["reports.list"],
  "billing-review": ["billing.summary", "billing.usage", "billing.ledger"],
};

const hasRequiredTools = (
  requiredTools: readonly string[] | undefined,
  availableToolNames: Set<string>
): boolean => (requiredTools ?? []).every((toolName) => availableToolNames.has(toolName));

const resourcesForToolset = (toolset: McpToolsetName): McpResourceDefinition[] => {
  const availableToolNames = new Set(MCP_TOOLSETS[toolset]);
  return mcpResourceDefinitions.filter((resource) =>
    hasRequiredTools(MCP_RESOURCE_TOOL_REQUIREMENTS[resource.uri], availableToolNames)
  );
};

const promptsForToolset = (toolset: McpToolsetName): McpPromptDefinition[] => {
  const availableToolNames = new Set(MCP_TOOLSETS[toolset]);
  return mcpPromptDefinitions.filter((prompt) =>
    hasRequiredTools(MCP_PROMPT_TOOL_REQUIREMENTS[prompt.name], availableToolNames)
  );
};

export const getMcpStatusData = () => ({
  protocolVersion: MCP_PROTOCOL_VERSION,
  protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
  serverInfo: {
    name: "cloudeval",
    title: "CloudEval CLI MCP Server",
    version: CLI_VERSION,
  },
  command: "cloudeval mcp serve",
  toolsets: MCP_TOOLSET_NAMES,
  tools: mcpToolNames,
  resources: mcpResourceDefinitions.map((resource) => resource.uri),
  prompts: mcpPromptDefinitions.map((prompt) => prompt.name),
  setupClients: MCP_SETUP_CLIENTS,
});

export const getMcpDoctorChecks = () => {
  const status = getMcpStatusData();
  return {
    status,
    checks: [
      {
        id: "mcp-initialize",
        label: "MCP initialize metadata is available",
        status: "pass" as const,
        detail: status.protocolVersion,
      },
      {
        id: "mcp-tools-list",
        label: "MCP tools/list is available",
        status: mcpToolDefinitions.length > 0 ? "pass" as const : "fail" as const,
        detail: `${mcpToolDefinitions.length} tools across ${MCP_TOOLSET_NAMES.length} toolsets`,
      },
      {
        id: "mcp-resources-list",
        label: "MCP resources/list is available",
        status: mcpResourceDefinitions.length > 0 ? "pass" as const : "fail" as const,
        detail: `${mcpResourceDefinitions.length} resources`,
      },
      {
        id: "mcp-prompts-list",
        label: "MCP prompts/list is available",
        status: mcpPromptDefinitions.length > 0 ? "pass" as const : "fail" as const,
        detail: `${mcpPromptDefinitions.length} prompts`,
      },
    ],
  };
};

const isObject = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const booleanValue = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const enumValue = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T => {
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
};

const jsonText = (value: unknown): string => JSON.stringify(value, null, 2);

const toToolResult = (envelope: SuccessEnvelope): ToolResult => ({
  content: [{ type: "text", text: jsonText(envelope) }],
  structuredContent: envelope as unknown as JsonRecord,
  isError: false,
});

const toToolError = (command: string, error: unknown): ToolResult => {
  const envelope = formatErrorEnvelope(command, error);
  return {
    content: [{ type: "text", text: jsonText(envelope) }],
    structuredContent: envelope as unknown as JsonRecord,
    isError: true,
  };
};

const collapseRepeatedAssistantText = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length % 2 !== 0) {
    return value;
  }
  const midpoint = trimmed.length / 2;
  const first = trimmed.slice(0, midpoint);
  const second = trimmed.slice(midpoint);
  return first === second ? first : value;
};

const withEnvelope = <T>(input: {
  command: string;
  data: T;
  frontendUrl?: string;
  filesWritten?: string[];
  traceId?: string;
}): SuccessEnvelope<T> =>
  formatSuccessEnvelope({
    command: input.command,
    data: input.data,
    frontendUrl: input.frontendUrl,
    filesWritten: input.filesWritten,
    traceId: input.traceId,
  });

const rangeToDates = (range?: string): { startAt?: string; endAt?: string } => {
  if (!range || range === "all") {
    return {};
  }
  const days = range === "7d" ? 7 : range === "90d" ? 90 : 30;
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);
  return { startAt: start.toISOString(), endAt: end.toISOString() };
};

const pickReportDownloadPayload = (
  value: unknown,
  view: ReportView,
): unknown => {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (view === "raw") {
      return record.raw ?? record.raw_report ?? record;
    }
    if (view === "parsed") {
      return record.parsed ?? record.processed ?? record.normalized ?? record;
    }
    return (
      record.formatted ??
      record.summary ??
      record.processed ??
      record.parsed ??
      record
    );
  }
  return value;
};

const extractJobId = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, any>;
  return (
    record.job_id ??
    record.id ??
    record.job?.job_id ??
    record.job?.id ??
    record.data?.job_id ??
    record.data?.job?.job_id
  );
};

const isTerminalJobStatus = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return true;
  const status = String(
    (value as Record<string, any>).status ?? "",
  ).toLowerCase();
  return [
    "completed",
    "succeeded",
    "failed",
    "error",
    "cancelled",
    "canceled",
  ].includes(status);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const writeHeaderFile = async (
  outputPath: string,
  headers: Record<string, string>,
) => {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const text = Object.entries(headers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  await fs.writeFile(outputPath, `${text}\n`, "utf8");
};

const resolveInvocationConfig = async (
  serverOptions: ServeMcpOptions,
  args: JsonRecord,
): Promise<InvocationConfig> => {
  const profile = normalizeConfigProfile(
    stringValue(args.profile) ?? serverOptions.profile,
  );
  const config = await loadCliConfig(profile);
  return {
    baseUrl:
      stringValue(args.baseUrl) ?? serverOptions.baseUrl ?? config.baseUrl,
    frontendUrl:
      stringValue(args.frontendUrl) ??
      serverOptions.frontendUrl ??
      config.frontendUrl,
    profile,
    defaultProjectId: config.defaultProjectId,
    model: stringValue(args.model) ?? config.model,
    apiKey: stringValue(args.apiKey) ?? serverOptions.apiKey,
    machine: booleanValue(args.machine) ?? Boolean(serverOptions.machine),
  };
};

const frontendBase = (config: InvocationConfig): string =>
  resolveFrontendBaseUrl({
    frontendUrl: config.frontendUrl,
    apiBaseUrl: config.baseUrl,
  });

const reportsFrontendUrl = (
  config: InvocationConfig,
  input: {
    projectId?: string;
    type?: string;
    tab?: string;
    pdfVerbosity?: string;
    downloadReport?: string;
    reportVerbosity?: string;
  },
): string =>
  buildFrontendUrl({
    baseUrl: frontendBase(config),
    target: "reports",
    projectId: input.projectId,
    tab:
      input.tab ??
      (input.type === "cost"
        ? "cost"
        : input.type === "waf" || input.type === "architecture"
          ? "architecture"
          : "overview"),
    reportType: input.type,
    pdfVerbosity: input.pdfVerbosity,
    downloadReport: input.downloadReport,
    reportVerbosity: input.reportVerbosity,
  });

const resolveAuth = async (
  config: InvocationConfig,
  options: { requireUser?: boolean } = {},
) => {
  const core = await import("@cloudeval/core");
  core.assertSecureBaseUrl(config.baseUrl);
  let token: string;
  try {
    token = await core.getAuthToken({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      allowMachineAuth: config.machine,
    });
  } catch (error: any) {
    throw new Error(
      `${error?.message ?? "Authentication failed"} MCP stdio cannot run browser or stdin login flows; run 'cloudeval login' first or configure CLOUDEVAL_API_KEY / --api-key / --machine.`,
    );
  }
  const status = await core.checkUserStatus(config.baseUrl, token);
  if (options.requireUser && !status.user?.id) {
    throw new Error(
      "Authenticated user id is unavailable. Run `cloudeval login` and retry.",
    );
  }
  return { core, token, user: status.user };
};

const resolveProject = async (
  config: InvocationConfig,
  args: JsonRecord,
  auth: Awaited<ReturnType<typeof resolveAuth>>,
) => {
  const requestedProjectId =
    stringValue(args.projectId) ?? config.defaultProjectId;
  const userId = auth.user?.id;
  if (!userId) {
    if (requestedProjectId) {
      return {
        id: requestedProjectId,
        name: "Selected Project",
        cloud_provider: "azure",
      };
    }
    throw new Error(
      "Could not determine the authenticated user. Provide projectId.",
    );
  }

  const projects = await auth.core.getProjects(
    config.baseUrl,
    auth.token,
    userId,
  );
  if (requestedProjectId) {
    return (
      projects.find((project: any) => project.id === requestedProjectId) ?? {
        id: requestedProjectId,
        name: "Selected Project",
        user_id: userId,
        cloud_provider: "azure",
      }
    );
  }

  const selected =
    projects.find((project: any) => project.name === "Playground") ??
    projects[0];
  if (selected) {
    return selected;
  }

  if (auth.user?.email) {
    return auth.core.ensurePlaygroundProject(config.baseUrl, auth.token, {
      id: userId,
      email: auth.user.email,
      full_name: auth.user.full_name,
      name: auth.user.name,
    });
  }

  throw new Error(
    "No project is available for this account. Provide projectId or run `cloudeval chat` to complete onboarding.",
  );
};

const assertModelAvailable = async (
  config: InvocationConfig,
  token: string,
) => {
  if (!config.model) {
    return;
  }
  const core = await import("@cloudeval/core");
  try {
    const response = await fetch(
      `${core.normalizeApiBase(config.baseUrl)}/models`,
      {
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
    );
    if (!response.ok) {
      return;
    }
    const payload = await response.json();
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.models)
        ? payload.models
        : Array.isArray(payload?.data)
          ? payload.data
          : [];
    const available = list
      .map((model: any) => model?.id ?? model?.name ?? model?.model)
      .filter(
        (id: unknown): id is string => typeof id === "string" && Boolean(id),
      );
    if (available.length && !available.includes(config.model)) {
      throw new Error(
        `Model '${config.model}' is not available for this backend/account. Available models: ${available.join(", ")}.`,
      );
    }
  } catch (error: any) {
    if (
      error?.message?.startsWith(`Model '${config.model}' is not available`)
    ) {
      throw error;
    }
  }
};

const waitForReportJobs = async (input: {
  core: typeof import("@cloudeval/core");
  baseUrl: string;
  token: string;
  userId?: string;
  submitted: unknown[];
  pollIntervalMs: number;
}): Promise<unknown[]> => {
  const jobIds = input.submitted.map(extractJobId).filter(Boolean) as string[];
  if (!jobIds.length) {
    return input.submitted;
  }
  const finalStatuses: unknown[] = [];
  for (const jobId of jobIds) {
    let lastStatus: unknown;
    for (;;) {
      lastStatus = await input.core.getReportJobStatus({
        baseUrl: input.baseUrl,
        authToken: input.token,
        userId: input.userId,
        jobId,
      });
      if (isTerminalJobStatus(lastStatus)) {
        break;
      }
      await sleep(input.pollIntervalMs);
    }
    finalStatuses.push(lastStatus);
  }
  return finalStatuses;
};

const downloadReports = async (
  config: InvocationConfig,
  args: JsonRecord,
  auth: Awaited<ReturnType<typeof resolveAuth>>,
) => {
  const projectId = await resolveReportProjectId({
    baseUrl: config.baseUrl,
    token: auth.token,
    requestedProjectId: stringValue(args.projectId) ?? config.defaultProjectId,
    workspace: {
      checkUserStatus: auth.core.checkUserStatus,
      getProjects: auth.core.getProjects,
    },
  });
  const type = enumValue<DownloadReportType>(
    args.type,
    ["cost", "waf", "architecture", "all"],
    "all",
  );
  const view = enumValue<ReportView>(
    args.view,
    ["raw", "parsed", "formatted"],
    "raw",
  );
  const reportTypes = type === "all" ? ["cost", "waf"] : [type];
  const timestamp = stringValue(args.timestamp);
  const payload: Record<string, unknown> = {};

  for (const reportType of reportTypes) {
    if (reportType === "cost") {
      const data = timestamp
        ? await auth.core.getCostReportHistory({
            baseUrl: config.baseUrl,
            authToken: auth.token,
            projectId,
            userId: auth.user?.id,
            timestamp,
          })
        : await auth.core.getCostReportFull({
            baseUrl: config.baseUrl,
            authToken: auth.token,
            projectId,
            userId: auth.user?.id,
          });
      payload.cost = pickReportDownloadPayload(data, view);
      continue;
    }
    const data = timestamp
      ? await auth.core.getWafReportHistory({
          baseUrl: config.baseUrl,
          authToken: auth.token,
          projectId,
          userId: auth.user?.id,
          timestamp,
        })
      : await auth.core.getWafReportFull({
          baseUrl: config.baseUrl,
          authToken: auth.token,
          projectId,
          userId: auth.user?.id,
        });
    payload.waf = pickReportDownloadPayload(data, view);
  }

  const data =
    reportTypes.length === 1
      ? payload[reportTypes[0] === "architecture" ? "waf" : reportTypes[0]]
      : payload;
  const frontendUrl = reportsFrontendUrl(config, { projectId, type });
  const outputPath = stringValue(args.outputPath);
  const filesWritten: string[] = [];
  if (outputPath) {
    if (reportTypes.length > 1) {
      const stat = await fs.stat(outputPath).catch(() => undefined);
      const outputIsDirectory =
        stat?.isDirectory() || !path.extname(outputPath);
      if (outputIsDirectory) {
        await fs.mkdir(outputPath, { recursive: true });
        for (const [key, value] of Object.entries(payload)) {
          const file = path.join(outputPath, `${projectId}-${key}-report.json`);
          await fs.writeFile(
            file,
            `${JSON.stringify(value, null, 2)}\n`,
            "utf8",
          );
          filesWritten.push(file);
        }
      } else {
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(
          outputPath,
          `${JSON.stringify(data, null, 2)}\n`,
          "utf8",
        );
        filesWritten.push(outputPath);
      }
    } else {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(
        outputPath,
        `${JSON.stringify(data, null, 2)}\n`,
        "utf8",
      );
      filesWritten.push(outputPath);
    }
  }

  return withEnvelope({
    command: "reports download",
    data:
      outputPath && filesWritten.length
        ? { projectId, type, view, payload: data, filesWritten }
        : { projectId, type, view, payload: data },
    frontendUrl,
    filesWritten,
  });
};

const buildToolHandlers = (
  serverOptions: ServeMcpOptions,
): Map<string, ToolHandler> => {
  const handlers = new Map<string, ToolHandler>();

  handlers.set("capabilities.get", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const toolset = normalizeMcpToolset(serverOptions.toolset);
    return withEnvelope({
      command: "capabilities",
      data: {
        version: 1,
        cliVersion: CLI_VERSION,
        mcp: {
          transport: "stdio",
          protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
          serverCommand: "cloudeval mcp serve",
          toolset,
          toolsets: MCP_TOOLSETS,
          tools: toolsForToolset(toolset).map((tool) => tool.name),
          resources: resourcesForToolset(toolset).map((resource) => resource.uri),
          prompts: promptsForToolset(toolset).map((prompt) => prompt.name),
        },
        defaults: {
          baseUrl: config.baseUrl,
          frontendUrl: config.frontendUrl,
          profile: config.profile,
          defaultProjectId: config.defaultProjectId,
          model: config.model,
        },
      },
    });
  });

  handlers.set("projects.list", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const projects = await auth.core.getProjects(
      config.baseUrl,
      auth.token,
      auth.user!.id,
    );
    const frontendUrl = buildFrontendUrl({
      baseUrl: frontendBase(config),
      target: "projects",
    });
    return withEnvelope({
      command: "projects list",
      data: projects,
      frontendUrl,
    });
  });

  handlers.set("projects.get", async (args) => {
    const projectId = stringValue(args.projectId);
    if (!projectId) {
      throw new Error("projectId is required.");
    }
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const projects = await auth.core.getProjects(
      config.baseUrl,
      auth.token,
      auth.user!.id,
    );
    const project = projects.find((item: any) => item.id === projectId);
    if (!project) {
      throw new Error(`Project ${projectId} was not found.`);
    }
    const frontendUrl = buildFrontendUrl({
      baseUrl: frontendBase(config),
      target: "project",
      projectId,
    });
    return withEnvelope({
      command: "projects get",
      data: project,
      frontendUrl,
    });
  });

  handlers.set("projects.exportDiagram", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const projectId = stringValue(args.projectId) ?? config.defaultProjectId;
    if (!projectId) {
      throw new Error("projectId is required.");
    }
    const rawOutputPath = stringValue(args.outputPath);
    if (!rawOutputPath) {
      throw new Error("outputPath is required.");
    }
    const outputPath = path.resolve(rawOutputPath);

    const publicGraph = booleanValue(args.public) ?? false;
    const auth = publicGraph
      ? undefined
      : await resolveAuth(config, { requireUser: true });
    const layout = normalizeProjectDiagramImageLayout(stringValue(args.layout));
    const imageFormat = normalizeProjectDiagramImageFormat(stringValue(args.format));
    const labels = normalizeProjectDiagramImageLabels(stringValue(args.labels));
    const result = await downloadProjectDiagramImage({
      frontendUrl: resolveProjectDiagramImageFrontendUrl({
        frontendUrl: config.frontendUrl,
      }),
      projectId,
      layout,
      format: imageFormat,
      labels,
      token: auth?.token,
      userId: auth?.user?.id,
      publicGraph,
      syncVersion: stringValue(args.syncVersion),
    });

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, result.bytes);
    const filesWritten = [outputPath];
    const rawHeadersOutputPath = stringValue(args.headersOutputPath);
    const headersOutputPath = rawHeadersOutputPath
      ? path.resolve(rawHeadersOutputPath)
      : undefined;
    if (headersOutputPath) {
      await writeHeaderFile(headersOutputPath, result.headers);
      filesWritten.push(headersOutputPath);
    }

    return withEnvelope({
      command: "projects export-diagram",
      data: {
        projectId,
        layout,
        format: imageFormat,
        labels,
        public: publicGraph,
        outputPath,
        headersOutputPath,
        contentType: result.contentType,
        bytes: result.bytes.length,
        authMode: result.headers["x-cloudeval-diagram-auth-mode"],
        graphPrivate: result.headers["x-cloudeval-diagram-graph-private"],
        graphSource: result.headers["x-cloudeval-diagram-graph-source"],
      },
      frontendUrl: result.url,
      filesWritten,
    });
  });

  handlers.set("ask", async (args) => {
    const question = stringValue(args.question);
    if (!question) {
      throw new Error("question is required.");
    }
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config);
    await assertModelAvailable(config, auth.token);
    const project = await resolveProject(config, args, auth);
    const threadId = stringValue(args.threadId) ?? randomUUID();
    const email = auth.core.extractEmailFromToken(auth.token);
    const userName = getFirstNameForDisplay({
      email: email ?? auth.user?.email,
    });
    let chatState: any = { ...auth.core.initialChatState, threadId };
    let responseText = "";
    for await (const chunk of auth.core.streamChat({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      message: question,
      threadId,
      user: {
        id: project.user_id ?? auth.user?.id ?? "cli-user",
        name: userName,
      },
      project,
      settings: config.model ? { model: config.model } : undefined,
      completeAfterResponse: true,
      responseCompletionGraceMs: 5000,
    })) {
      chatState = auth.core.reduceChunk(chatState, chunk);
      const latestMessage = [...chatState.messages]
        .reverse()
        .find((message: any) => message.role === "assistant");
      if (
        chunk.type === "responding" &&
        chunk.content &&
        (!chunk.node || STREAM_OUTPUT_NODES.has(chunk.node))
      ) {
        responseText = latestMessage?.content || chunk.content;
      }
      if (chunk.type === "error") {
        throw new Error(
          chunk.message || chunk.description || "CloudEval ask failed.",
        );
      }
    }
    const finalMessage = [...chatState.messages]
      .reverse()
      .find((message: any) => message.role === "assistant");
    const finalResponse = collapseRepeatedAssistantText(
      finalMessage?.content || responseText || "",
    );
    const frontendUrl = buildFrontendUrl({
      baseUrl: frontendBase(config),
      target: "chat",
      threadId: chatState.threadId,
    });

    try {
      await recordSessionTurn({
        threadId: chatState.threadId,
        question,
        response: finalResponse,
        project: {
          id: project.id,
          name: project.name,
        },
        model: config.model,
        profile: config.profile,
      });
    } catch {
      // Local session history is useful but should not fail an MCP tool call.
    }

    return withEnvelope({
      command: "ask",
      data: {
        response: finalResponse,
        threadId: chatState.threadId,
        project: {
          id: project.id,
          name: project.name,
        },
      },
      frontendUrl,
      traceId: chatState.traceId,
    });
  });

  handlers.set("reports.list", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const projectId = await resolveReportProjectId({
      baseUrl: config.baseUrl,
      token: auth.token,
      requestedProjectId:
        stringValue(args.projectId) ?? config.defaultProjectId,
      workspace: {
        checkUserStatus: auth.core.checkUserStatus,
        getProjects: auth.core.getProjects,
      },
    });
    const kind = enumValue(args.kind, ["all", "cost", "waf"], "all");
    const reports = await auth.core.listReports({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      projectId,
      kind,
      userId: auth.user?.id,
    });
    return withEnvelope({
      command: "reports list",
      data: reports,
      frontendUrl: reportsFrontendUrl(config, { projectId, type: kind }),
    });
  });

  handlers.set("reports.run", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const projectId = await resolveReportProjectId({
      baseUrl: config.baseUrl,
      token: auth.token,
      requestedProjectId:
        stringValue(args.projectId) ?? config.defaultProjectId,
      workspace: {
        checkUserStatus: auth.core.checkUserStatus,
        getProjects: auth.core.getProjects,
      },
    });
    const type = enumValue<ReportRunType>(
      args.type,
      ["cost", "waf", "architecture", "unit-tests", "all"],
      "all",
    );
    const submitted = await auth.core.runReports({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      projectId,
      userId: auth.user?.id,
      type,
      region: stringValue(args.region) ?? DEFAULT_REPORT_REGION,
      currency: stringValue(args.currency) ?? DEFAULT_REPORT_CURRENCY,
      includeTimeSeries: booleanValue(args.includeTimeSeries) ?? true,
      saveReport: booleanValue(args.saveReport) ?? true,
    });
    const finalStatuses = booleanValue(args.wait)
      ? await waitForReportJobs({
          core: auth.core,
          baseUrl: config.baseUrl,
          token: auth.token,
          userId: auth.user?.id,
          submitted,
          pollIntervalMs: Math.max(
            500,
            numberValue(args.pollIntervalMs) ?? 2500,
          ),
        })
      : undefined;
    return withEnvelope({
      command: "reports run",
      data: {
        projectId,
        type,
        submitted,
        jobs: submitted.map(extractJobId).filter(Boolean),
        finalStatuses,
      },
      frontendUrl: reportsFrontendUrl(config, { projectId, type }),
    });
  });

  handlers.set("reports.download", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    return downloadReports(config, args, auth);
  });

  handlers.set("billing.summary", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const [entitlement, subscriptionStatus] = await Promise.all([
      auth.core.getBillingEntitlement({
        baseUrl: config.baseUrl,
        authToken: auth.token,
      }),
      auth.core.getSubscriptionStatus({
        baseUrl: config.baseUrl,
        authToken: auth.token,
      }),
    ]);
    const frontendUrl = buildFrontendUrl({
      baseUrl: frontendBase(config),
      target: "billing",
      tab: "plans",
    });
    return withEnvelope({
      command: "billing summary",
      data: {
        creditStatus: auth.core.getCreditStatus(entitlement),
        entitlement,
        subscriptionStatus,
      },
      frontendUrl,
    });
  });

  handlers.set("billing.usage", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const range = rangeToDates(stringValue(args.range) ?? "30d");
    const data = await auth.core.getBillingUsageSummary({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      startAt: stringValue(args.startAt) ?? range.startAt,
      endAt: stringValue(args.endAt) ?? range.endAt,
      granularity: enumValue<BillingGranularity>(
        args.granularity,
        ["hour", "day", "month"],
        "day",
      ),
      actionType: stringValue(args.actionType),
      modelName: stringValue(args.model),
      outcome: stringValue(args.outcome),
      chargeStatus: stringValue(args.chargeStatus),
    });
    const frontendUrl = buildFrontendUrl({
      baseUrl: frontendBase(config),
      target: "billing",
      tab: "usage",
    });
    return withEnvelope({
      command: "billing usage",
      data,
      frontendUrl,
    });
  });

  handlers.set("billing.ledger", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const range = rangeToDates(stringValue(args.range) ?? "30d");
    const data = await auth.core.getBillingUsageLedger({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      startAt: stringValue(args.startAt) ?? range.startAt,
      endAt: stringValue(args.endAt) ?? range.endAt,
      actionType: stringValue(args.actionType),
      modelName: stringValue(args.model),
      outcome: stringValue(args.outcome),
      chargeStatus: stringValue(args.chargeStatus),
      limit: Math.max(
        1,
        Math.min(100, Math.floor(numberValue(args.limit) ?? 25)),
      ),
      cursor: stringValue(args.cursor),
    });
    const frontendUrl = buildFrontendUrl({
      baseUrl: frontendBase(config),
      target: "billing",
      tab: "usage",
    });
    return withEnvelope({
      command: "billing ledger",
      data,
      frontendUrl,
    });
  });

  handlers.set("open.url", async (args) => {
    const target = stringValue(args.target) as FrontendTarget | undefined;
    if (!target) {
      throw new Error("target is required.");
    }
    const config = await resolveInvocationConfig(serverOptions, args);
    const url = buildFrontendUrl({
      baseUrl: frontendBase(config),
      target,
      threadId: stringValue(args.threadId),
      projectId: stringValue(args.projectId),
      connectionId: stringValue(args.connectionId),
      quick: booleanValue(args.quick),
      templateUrl: stringValue(args.templateUrl),
      name: stringValue(args.name),
      description: stringValue(args.description),
      provider: stringValue(args.provider),
      autoSubmit: booleanValue(args.autoSubmit),
      view: stringValue(args.view),
      layout: stringValue(args.layout),
      node:
        typeof args.node === "string" || Array.isArray(args.node)
          ? (args.node as any)
          : undefined,
      resource: stringValue(args.resource),
      tab: stringValue(args.tab),
      file: stringValue(args.file),
      files:
        typeof args.files === "string" || Array.isArray(args.files)
          ? (args.files as any)
          : undefined,
      cursor: stringValue(args.cursor),
      selection: stringValue(args.selection),
      workspaceFocus: booleanValue(args.workspaceFocus),
      presentation: booleanValue(args.presentation),
      dialog: stringValue(args.dialog),
      reportType: stringValue(args.reportType),
      timeRange: stringValue(args.timeRange),
      persona: stringValue(args.persona),
      cadence: stringValue(args.cadence),
      issuesQuery: stringValue(args.issuesQuery),
      issuesFullscreen: booleanValue(args.issuesFullscreen),
      issuesView: stringValue(args.issuesView),
      downloadPdf: booleanValue(args.downloadPdf),
      pdfVerbosity: stringValue(args.pdfVerbosity),
      downloadReport: stringValue(args.downloadReport),
      reportVerbosity: stringValue(args.reportVerbosity),
    });
    if (booleanValue(args.open)) {
      await openExternalUrl(url);
    }
    return withEnvelope({
      command: "open url",
      data: { url, opened: Boolean(booleanValue(args.open)) },
      frontendUrl: url,
    });
  });

  return handlers;
};

const resourceText = (uri: string, value: unknown) => ({
  uri,
  mimeType: "application/json",
  text: `${JSON.stringify(value, null, 2)}\n`,
});

const readMcpResource = async (
  uri: string,
  handlers: Map<string, ToolHandler>,
  availableToolNames: Set<string>,
  toolset: McpToolsetName
): Promise<JsonRecord> => {
  if (!mcpResourceDefinitions.some((resource) => resource.uri === uri)) {
    throw new Error(`Unknown resource: ${uri}`);
  }
  if (!hasRequiredTools(MCP_RESOURCE_TOOL_REQUIREMENTS[uri], availableToolNames)) {
    throw new Error(`Resource ${uri} is not available in toolset ${toolset}.`);
  }
  if (uri === "cloudeval://capabilities") {
    const envelope = await handlers.get("capabilities.get")?.({});
    return { contents: [resourceText(uri, envelope?.data ?? {})] };
  }

  const toolName =
    uri === "cloudeval://projects"
      ? "projects.list"
      : uri === "cloudeval://billing/summary"
        ? "billing.summary"
        : "reports.list";
  const handler = handlers.get(toolName);
  if (!handler) {
    return {
      contents: [
        resourceText(uri, formatErrorEnvelope(toolName, new Error(`Tool ${toolName} is not available in this MCP toolset.`))),
      ],
    };
  }
  try {
    const envelope = await handler({});
    return { contents: [resourceText(uri, envelope)] };
  } catch (error) {
    return {
      contents: [resourceText(uri, formatErrorEnvelope(toolName, error))],
    };
  }
};

const promptArgument = (
  args: JsonRecord,
  name: string,
  fallback: string
): string => stringValue(args[name]) ?? fallback;

const renderPromptText = (name: string, args: JsonRecord): string => {
  const projectId = promptArgument(args, "projectId", "the default CloudEval project");
  const range = promptArgument(args, "range", "30d");
  if (name === "cost-review") {
    return [
      `Run a CloudEval cost review for ${projectId} over ${range}.`,
      "Use available CloudEval tools to inspect latest reports, billing usage, and project context.",
      "Return the top cost drivers, savings opportunities, anomalies, and concrete next actions.",
    ].join("\n");
  }
  if (name === "waf-triage") {
    const severity = promptArgument(args, "severity", "critical and high");
    return [
      `Triage ${severity} Well-Architected findings for ${projectId}.`,
      "Use CloudEval report data where available.",
      "Group issues by pillar, identify likely blast radius, and propose an ordered remediation plan.",
    ].join("\n");
  }
  if (name === "architecture-review") {
    return [
      `Review the CloudEval architecture for ${projectId}.`,
      "Focus on reliability, security, operational excellence, performance, and cost efficiency.",
      "Call out missing evidence separately from confirmed findings.",
    ].join("\n");
  }
  if (name === "billing-review") {
    return [
      `Review CloudEval billing usage over ${range}.`,
      "Inspect credits, usage, ledger patterns, and subscription status.",
      "Summarize risks, unusual charges, forecast pressure, and recommended billing actions.",
    ].join("\n");
  }
  throw new Error(`Unknown prompt: ${name}`);
};

const getMcpPrompt = (
  name: string,
  args: JsonRecord,
  availableToolNames: Set<string>,
  toolset: McpToolsetName
): JsonRecord => {
  const definition = mcpPromptDefinitions.find((prompt) => prompt.name === name);
  if (!definition) {
    throw new Error(`Unknown prompt: ${name}`);
  }
  if (!hasRequiredTools(MCP_PROMPT_TOOL_REQUIREMENTS[name], availableToolNames)) {
    throw new Error(`Prompt ${name} is not available in toolset ${toolset}.`);
  }
  return {
    description: definition.description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: renderPromptText(name, args),
        },
      },
    ],
  };
};

const isRequest = (message: JsonRpcMessage): message is JsonRpcRequest =>
  "id" in message &&
  message.id !== null &&
  (typeof message.id === "string" || typeof message.id === "number") &&
  typeof (message as any).method === "string";

const isNotification = (
  message: JsonRpcMessage,
): message is JsonRpcNotification =>
  !("id" in message) && typeof (message as any).method === "string";

const jsonRpcResult = (id: JsonRpcId, result: JsonRecord): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  result,
});

const jsonRpcError = (
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: {
    code,
    message,
    ...(data === undefined ? {} : { data }),
  },
});

const protocolVersionFor = (requested: unknown): string =>
  typeof requested === "string" &&
  SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : MCP_PROTOCOL_VERSION;

const MCP_STDIO_SEPARATOR = "\r\n\r\n";

const serializeJsonRpc = (
  message: JsonRpcResponse | JsonRpcNotification,
): string => {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}${MCP_STDIO_SEPARATOR}${body}`;
};

const parseContentLength = (header: string): number | undefined => {
  for (const line of header.split(/\r?\n/)) {
    const match = line.match(/^Content-Length:\s*(\d+)\s*$/i);
    if (match) {
      return Number(match[1]);
    }
  }
  return undefined;
};

export const serveMcpServer = async (
  options: ServeMcpOptions,
): Promise<void> => {
  const toolset = normalizeMcpToolset(options.toolset);
  const handlers = buildToolHandlers(options);
  const availableTools = toolsForToolset(toolset);
  const availableToolNames = new Set(availableTools.map((tool) => tool.name));
  const availableResources = resourcesForToolset(toolset);
  const availablePrompts = promptsForToolset(toolset);
  let initialized = false;
  const log = (message: string, data?: unknown) => {
    if (!options.verbose) {
      return;
    }
    process.stderr.write(
      `[cloudeval-mcp] ${message}${data === undefined ? "" : ` ${JSON.stringify(data)}`}\n`,
    );
  };
  const send = (message: JsonRpcResponse | JsonRpcNotification) => {
    process.stdout.write(serializeJsonRpc(message));
  };
  const handleRequest = async (
    request: JsonRpcRequest,
  ): Promise<JsonRpcResponse | undefined> => {
    try {
      if (request.method === "initialize") {
        const protocolVersion = protocolVersionFor(
          request.params?.protocolVersion,
        );
        initialized = true;
        return jsonRpcResult(request.id, {
          protocolVersion,
          capabilities: {
            tools: {
              listChanged: false,
            },
            resources: {
              listChanged: false,
            },
            prompts: {
              listChanged: false,
            },
          },
          serverInfo: {
            name: "cloudeval",
            title: "CloudEval CLI MCP Server",
            version: CLI_VERSION,
          },
          instructions:
            "Use CloudEval tools for project-aware cloud evaluation, reports, billing usage, one-shot asks, and frontend deep links. Authentication comes from stored `cloudeval login` credentials, CLOUDEVAL_API_KEY, --api-key, or --machine environment credentials.",
        });
      }
      if (request.method === "ping") {
        return jsonRpcResult(request.id, {});
      }
      if (!initialized && request.method !== "tools/list") {
        return jsonRpcError(
          request.id,
          -32002,
          "MCP server has not been initialized.",
        );
      }
      if (request.method === "tools/list") {
        return jsonRpcResult(request.id, {
          tools: availableTools,
        });
      }
      if (request.method === "tools/call") {
        const requestedName = stringValue(request.params?.name);
        const name = requestedName ? MCP_TOOL_ALIASES[requestedName] ?? requestedName : undefined;
        if (!name || !toolByName.has(name)) {
          return jsonRpcError(
            request.id,
            -32602,
            `Unknown tool: ${requestedName ?? "<missing>"}`,
          );
        }
        if (!availableToolNames.has(name)) {
          return jsonRpcError(
            request.id,
            -32602,
            `Tool ${name} is not available in toolset ${toolset}.`
          );
        }
        const args = isObject(request.params?.arguments)
          ? (request.params!.arguments as JsonRecord)
          : {};
        const handler = handlers.get(name);
        if (!handler) {
          return jsonRpcError(
            request.id,
            -32603,
            `Tool has no handler: ${name}`,
          );
        }
        try {
          const envelope = await handler(args);
          return jsonRpcResult(
            request.id,
            toToolResult(envelope) as unknown as JsonRecord,
          );
        } catch (error) {
          return jsonRpcResult(
            request.id,
            toToolError(name, error) as unknown as JsonRecord,
          );
        }
      }
      if (request.method === "resources/list") {
        return jsonRpcResult(request.id, {
          resources: availableResources,
        });
      }
      if (request.method === "resources/read") {
        const uri = stringValue(request.params?.uri);
        if (!uri) {
          return jsonRpcError(request.id, -32602, "Resource uri is required.");
        }
        try {
          return jsonRpcResult(
            request.id,
            await readMcpResource(uri, handlers, availableToolNames, toolset),
          );
        } catch (error: any) {
          return jsonRpcError(
            request.id,
            -32602,
            error?.message ?? String(error),
          );
        }
      }
      if (request.method === "prompts/list") {
        return jsonRpcResult(request.id, {
          prompts: availablePrompts,
        });
      }
      if (request.method === "prompts/get") {
        const name = stringValue(request.params?.name);
        if (!name) {
          return jsonRpcError(request.id, -32602, "Prompt name is required.");
        }
        const args = isObject(request.params?.arguments)
          ? (request.params!.arguments as JsonRecord)
          : {};
        try {
          return jsonRpcResult(
            request.id,
            getMcpPrompt(name, args, availableToolNames, toolset),
          );
        } catch (error: any) {
          return jsonRpcError(
            request.id,
            -32602,
            error?.message ?? String(error),
          );
        }
      }
      return jsonRpcError(
        request.id,
        -32601,
        `Method not found: ${request.method}`,
      );
    } catch (error: any) {
      return jsonRpcError(
        request.id,
        -32603,
        error?.message ?? "Internal MCP server error.",
      );
    }
  };

  const handleMessage = async (message: unknown) => {
    if (Array.isArray(message)) {
      for (const item of message) {
        await handleMessage(item);
      }
      return;
    }
    if (!isObject(message) || message.jsonrpc !== "2.0") {
      send(jsonRpcError(0, -32600, "Invalid JSON-RPC message."));
      return;
    }
    const rpcMessage = message as unknown as JsonRpcMessage;
    if (isNotification(rpcMessage)) {
      if (rpcMessage.method === "notifications/initialized") {
        initialized = true;
        log("initialized notification received");
      }
      return;
    }
    if (!isRequest(rpcMessage)) {
      return;
    }
    const response = await handleRequest(rpcMessage);
    if (response) {
      send(response);
    }
  };

  let stdinBuffer = Buffer.alloc(0);
  const processFrames = async () => {
    while (stdinBuffer.length) {
      const headerEnd = stdinBuffer.indexOf(MCP_STDIO_SEPARATOR);
      if (headerEnd === -1) {
        return;
      }
      const header = stdinBuffer.subarray(0, headerEnd).toString("ascii");
      const contentLength = parseContentLength(header);
      stdinBuffer = stdinBuffer.subarray(headerEnd + MCP_STDIO_SEPARATOR.length);
      if (contentLength === undefined) {
        send(
          jsonRpcError(0, -32700, "Parse error", {
            message: "Missing MCP Content-Length header.",
          }),
        );
        continue;
      }
      if (stdinBuffer.length < contentLength) {
        stdinBuffer = Buffer.concat([
          Buffer.from(`${header}${MCP_STDIO_SEPARATOR}`, "ascii"),
          stdinBuffer,
        ]);
        return;
      }
      const body = stdinBuffer.subarray(0, contentLength).toString("utf8");
      stdinBuffer = stdinBuffer.subarray(contentLength);
      try {
        await handleMessage(JSON.parse(body) as JsonValue);
      } catch (error: any) {
        send(
          jsonRpcError(0, -32700, "Parse error", {
            message: error?.message ?? String(error),
          }),
        );
      }
    }
  };

  for await (const chunk of process.stdin) {
    stdinBuffer = Buffer.concat([
      stdinBuffer,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    ]);
    await processFrames();
  }

  if (stdinBuffer.toString("utf8").trim()) {
    try {
      await handleMessage(JSON.parse(stdinBuffer.toString("utf8")) as JsonValue);
    } catch (error: any) {
      send(
        jsonRpcError(0, -32700, "Parse error", {
          message: error?.message ?? String(error),
        }),
      );
    }
  }
};

export const registerMcpCommand = (
  program: Command,
  deps: RegisterMcpCommandOptions,
) => {
  const mcp = program
    .command("mcp")
    .description("Model Context Protocol utilities");

  mcp
    .command("status")
    .description("Show CloudEval MCP server capabilities")
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file")
    .action(async (options: { format?: MachineOutputFormat; output?: string }) => {
      await writeFormattedOutput({
        command: "mcp status",
        data: getMcpStatusData(),
        format: options.format,
        output: options.output,
      });
    });

  mcp
    .command("setup")
    .description("Generate or install CloudEval MCP client configuration")
    .argument("<client>", `MCP client: ${MCP_SETUP_CLIENTS.join(", ")}`)
    .option("--dry-run", "Print config without writing client files", false)
    .option("--command <path>", "CloudEval command path for the MCP client", "cloudeval")
    .option(
      "--toolset <name>",
      "Toolset to expose: all, readonly, projects, reports, billing",
      "all"
    )
    .option("--config-path <path>", "Override MCP client config path")
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file")
    .action(async (
      client: string,
      options: {
        dryRun?: boolean;
        command?: string;
        toolset?: string;
        configPath?: string;
        format?: MachineOutputFormat;
        output?: string;
      }
    ) => {
      const setup = buildMcpClientSetup({
        client: normalizeMcpSetupClient(client),
        command: options.command ?? "cloudeval",
        toolset: normalizeMcpSetupToolset(options.toolset),
        configPath: options.configPath,
      });
      const writtenPath = options.dryRun
        ? undefined
        : await writeMcpClientConfig(setup);
      await writeFormattedOutput({
        command: "mcp setup",
        data: {
          ...setup,
          dryRun: Boolean(options.dryRun),
          writtenPath,
          note:
            setup.client === "codex" && !writtenPath
              ? "Run the printed Codex command to register this MCP server."
              : setup.client === "generic" && !writtenPath
                ? "Copy the printed MCP server config into your MCP client."
              : undefined,
        },
        format: options.format,
        output: options.output,
      });
    });

  mcp
    .command("serve")
    .description("Run CloudEval as a stdio MCP server")
    .option("--base-url <url>", "Backend base URL", deps.defaultBaseUrl)
    .option("--frontend-url <url>", "Frontend base URL")
    .option(
      "--api-key <key>",
      "API key (prefer MCP client env or stored login)",
      process.env.CLOUDEVAL_API_KEY,
    )
    .option("--machine", "Allow machine credential fallback", false)
    .option(
      "--toolset <name>",
      `Expose a focused MCP toolset: ${MCP_TOOLSET_NAMES.join(", ")}`,
      "all"
    )
    .option("-v, --verbose", "Write MCP server diagnostics to stderr", false)
    .action(async (options, command) => {
      const baseUrl = await deps.resolveBaseUrl(options, command);
      await serveMcpServer({
        baseUrl,
        frontendUrl: options.frontendUrl,
        profile: normalizeConfigProfile(command.optsWithGlobals?.().profile),
        apiKey: stringValue(options.apiKey),
        machine: Boolean(options.machine),
        toolset: normalizeMcpToolset(options.toolset),
        verbose: Boolean(options.verbose),
      });
    });
};

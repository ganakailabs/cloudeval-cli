import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import {
  getBundledAgentProfile,
  getBundledAgentProfiles,
} from "@cloudeval/shared";
import {
  buildFrontendUrl,
  openExternalUrl,
  resolveFrontendBaseUrl,
  type FrontendTarget,
} from "./frontendLinks.js";
import { getFirstNameForDisplay } from "./ui/userDisplayName.js";
import {
  getCliConfigPath,
  listCliConfigProfiles,
  loadCliConfig,
  normalizeConfigProfile,
  readCliConfigValue,
  saveCliConfig,
} from "./cliConfig.js";
import {
  exportSessions,
  getSession,
  listSessions,
  recordSessionTurn,
  searchSessions,
} from "./sessionsStore.js";
import { CLI_VERSION } from "./version.js";
import {
  getRecipe,
  recipes,
  recipeSummary,
  renderRecipeCommands,
  renderRecipePrompt,
} from "./recipes/catalog.js";
import {
  skillsResourceData,
} from "./skills/catalog.js";
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
  formatMcpClientSetupText,
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
import { buildProjectOverview } from "./projectsCommand.js";
import {
  getProjectGraph,
  getProjectGraphDiff,
  getProjectGraphInsights,
  getProjectGraphTimeline,
  listProjectSyncRuns,
} from "./graphClient.js";
import {
  buildCiInitPlan,
  buildDraftFix,
  buildFindingEvidence,
  buildGraphNeighborhood,
  buildReviewLocalRun,
} from "./ideContracts.js";
import {
  buildIacDetectData,
  buildIacIndexData,
  IDE_SCHEMA_VERSION,
} from "./iacCommand.js";
import {
  getRule,
  getRuleCategories,
  formatTemplateProgressEvent,
  templateProgressEventKey,
  parseTemplate,
  searchRules,
  testTemplate,
  validateTemplate,
  waitForTemplateValidationResult,
  withTemplateTestDetails,
  withTemplateValidationDetails,
  type TemplateProgressEvent,
} from "./templateValidationClient.js";
import { warnIfAccessKeyFromCliOption } from "./authGuard.js";
import {
  classifyTelemetryError,
  type CliTelemetry,
} from "./telemetry.js";

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

type ToolHandlerContext = {
  progressToken?: JsonRpcId;
  sendProgress?: (
    event: TemplateProgressEvent,
    command: string,
  ) => void | Promise<void>;
};

type ToolHandler = (
  args: JsonRecord,
  context?: ToolHandlerContext,
) => Promise<SuccessEnvelope>;

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
  getTelemetry?: () => CliTelemetry | undefined;
  finishTelemetry?: (exitCode: number, error?: unknown) => Promise<void>;
}

interface ServeMcpOptions {
  baseUrl: string;
  frontendUrl?: string;
  profile?: string;
  accessKey?: string;
  verbose?: boolean;
  toolset?: McpToolsetName;
  telemetry?: CliTelemetry;
}

interface InvocationConfig {
  baseUrl: string;
  frontendUrl?: string;
  profile: string;
  defaultProjectId?: string;
  model?: string;
  accessKey?: string;
}

type ReportRunType = "cost" | "waf" | "architecture" | "unit-tests" | "all";
type DownloadReportType = "cost" | "waf" | "architecture" | "all";
type ReportView = "raw" | "parsed" | "formatted";
type BillingGranularity = "hour" | "day" | "month";
type McpToolsetName =
  | "all"
  | "readonly"
  | "projects"
  | "reports"
  | "billing"
  | "ide"
  | "graph"
  | "ide"
  | "validation";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const STREAM_OUTPUT_NODES = new Set([
  "generate_response",
  "handle_social_interaction",
  "response_compose",
]);
const ASK_STREAM_IDLE_TIMEOUT_MS = 90_000;
const AGENT_PROFILE_STREAM_IDLE_TIMEOUT_MS = 180_000;
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
      "Cloudeval API base URL. Defaults to the MCP server --base-url, active profile, CLOUDEVAL_BASE_URL, or the public API.",
  },
  frontendUrl: {
    type: "string",
    description:
      "Cloudeval frontend base URL for generated links. Defaults to --frontend-url, active profile, CLOUDEVAL_FRONTEND_URL, or public frontend.",
  },
  profile: {
    type: "string",
    description:
      "Cloudeval CLI config profile to read defaults from. Defaults to the server --profile or CLOUDEVAL_PROFILE.",
  },
};

const projectIdProperty = {
  type: "string",
  description:
    "Cloudeval project id. Defaults to active profile defaultProjectId, then Playground/first project where supported.",
};

const templatePathProperty = {
  type: "string",
  description: "Local cloud template JSON file path.",
};

const parametersPathProperty = {
  type: "string",
  description: "Optional local parameters JSON file path.",
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
    name: "capabilities_get",
    title: "Get Cloudeval Capabilities",
    description:
      "Return Cloudeval CLI and MCP capability metadata for agent planning.",
    inputSchema: makeInputSchema({}),
    outputSchema: envelopeSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "projects_list",
    title: "List Projects",
    description:
      "List Cloudeval projects visible to the authenticated account.",
    inputSchema: makeInputSchema({}),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "agent_profiles_list",
    title: "List Agent Profiles",
    description:
      "List backend-owned Cloudeval Agent Profiles such as Architecture, Cost, Change Reviewer, Evidence Auditor, and Security Reviewer.",
    inputSchema: makeInputSchema({}),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: false,
    },
  },
  {
    name: "agent_profiles_get",
    title: "Get Agent Profile",
    description: "Fetch one Cloudeval Agent Profile by id.",
    inputSchema: makeInputSchema(
      {
        profileId: {
          type: "string",
          description: "Agent Profile id, for example cost.",
        },
      },
      ["profileId"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: false,
    },
  },
  {
    name: "agent_profiles_run",
    title: "Run Agent Profile",
    description:
      "Run a Cloudeval Agent Profile against a project through the normal chat stream contract.",
    inputSchema: makeInputSchema(
      {
        profileId: {
          type: "string",
          description: "Agent Profile id, for example cost.",
        },
        prompt: {
          type: "string",
          description:
            "Optional prompt override. Defaults to the profile starter prompt.",
        },
        projectId: projectIdProperty,
        model: {
          type: "string",
          description:
            "Optional model override. Defaults to active profile model if configured.",
        },
        threadId: {
          type: "string",
          description:
            "Optional thread id to use. Defaults to a generated UUID.",
        },
      },
      ["profileId"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      consumesCredits: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "projects_get",
    title: "Get Project",
    description:
      "Fetch one Cloudeval project by id from the authenticated account's project list.",
    inputSchema: makeInputSchema(
      {
        projectId: {
          ...projectIdProperty,
          description: "Cloudeval project id to fetch.",
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
    name: "projects_overview",
    title: "Get Project Overview",
    description:
      "Fetch a Cloudeval project cockpit overview with graph, report, connection, credit, and deep-link metadata for IDE and agent workflows.",
    inputSchema: makeInputSchema(
      {
        projectId: {
          ...projectIdProperty,
          description:
            "Cloudeval project id to inspect. Defaults to the configured project when omitted.",
        },
      },
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "connections_list",
    title: "List Connections",
    description:
      "List Cloudeval cloud/template connections visible to the authenticated account.",
    inputSchema: makeInputSchema({}),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "connections_get",
    title: "Get Connection",
    description:
      "Fetch one Cloudeval connection by id from the authenticated account's connection list.",
    inputSchema: makeInputSchema(
      {
        connectionId: {
          type: "string",
          description: "Cloudeval connection id to fetch.",
        },
      },
      ["connectionId"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "projects_export_diagram",
    title: "Export Project Diagram",
    description:
      "Export a GraphEditor-rendered architecture or dependency diagram to a local PNG, JPEG, or SVG file for CLI and MCP agents.",
    inputSchema: makeInputSchema(
      {
        projectId: {
          ...projectIdProperty,
          description: "Cloudeval project id to render.",
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
          description:
            "Absolute or relative local path for the downloaded image.",
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
      requiresAuth: true,
      writesLocalFile: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "projects_graph_get",
    title: "Get Project Graph",
    description: "Fetch project graph nodes and relationships for automation.",
    inputSchema: makeInputSchema({
      projectId: projectIdProperty,
      syncVersion: { type: "string", description: "Optional sync version." },
      asOf: { type: "string", description: "Optional replay timestamp." },
      includeDiff: { type: "boolean", default: false },
    }),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "projects_graph_timeline",
    title: "Project Graph Timeline",
    description: "List retained graph snapshots for a project.",
    inputSchema: makeInputSchema({
      projectId: projectIdProperty,
      limit: { type: "number", default: 20 },
    }),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "projects_graph_diff",
    title: "Project Graph Diff",
    description: "Compare two retained project graph snapshots.",
    inputSchema: makeInputSchema({
      projectId: projectIdProperty,
      fromSyncVersion: { type: "string", description: "Baseline sync version." },
      toSyncVersion: { type: "string", description: "Target sync version." },
    }),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "projects_graph_insights",
    title: "Project Graph Insights",
    description:
      "Fetch graph intelligence for overview, impact, critical paths, security, cost, or changes.",
    inputSchema: makeInputSchema({
      projectId: projectIdProperty,
      focus: {
        type: "string",
        enum: ["overview", "impact", "critical-paths", "security", "cost", "changes"],
        default: "overview",
      },
      resourceId: { type: "string", description: "Resource id for impact analysis." },
      syncVersion: { type: "string", description: "Optional sync version." },
      limit: { type: "number", default: 10 },
    }),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "projects_graph_sync_runs",
    title: "Project Graph Sync Runs",
    description: "List recent graph-producing sync runs for a project.",
    inputSchema: makeInputSchema({
      projectId: projectIdProperty,
      limit: { type: "number", default: 20 },
    }),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "ask",
    title: "Ask Cloudeval",
    description:
      "Ask Cloudeval a one-shot question, optionally scoped to a project and model.",
    inputSchema: makeInputSchema(
      {
        question: {
          type: "string",
          description: "Question or instruction to send to Cloudeval.",
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
        mode: {
          type: "string",
          enum: ["ask", "agent"],
          description: "Cloudeval runtime mode. Defaults to ask.",
          default: "ask",
        },
      },
      ["question"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      consumesCredits: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "models_list",
    title: "List Models",
    description:
      "List backend-supported Cloudeval models for the active account or access key.",
    inputSchema: makeInputSchema({}),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: false,
    },
  },
  {
    name: "models_default_get",
    title: "Get Default Model",
    description:
      "Return the configured default model for the selected CLI profile.",
    inputSchema: makeInputSchema({}),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      requiresAuth: false,
    },
  },
  {
    name: "models_default_set",
    title: "Set Default Model",
    description:
      "Set the configured default model for the selected CLI profile.",
    inputSchema: makeInputSchema(
      {
        model: { type: "string", description: "Model id or name to store." },
      },
      ["model"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      requiresAuth: false,
    },
  },
  {
    name: "sessions_list",
    title: "List Sessions",
    description: "List local Cloudeval CLI session history summaries.",
    inputSchema: makeInputSchema({
      limit: { type: "number", default: 20 },
    }),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      requiresAuth: false,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "sessions_get",
    title: "Get Session",
    description: "Return one local Cloudeval CLI session by thread id.",
    inputSchema: makeInputSchema(
      {
        threadId: { type: "string", description: "Local session thread id." },
      },
      ["threadId"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      requiresAuth: false,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "sessions_search",
    title: "Search Sessions",
    description: "Search local Cloudeval CLI session titles and messages.",
    inputSchema: makeInputSchema(
      {
        query: { type: "string", description: "Search query." },
        limit: { type: "number", default: 20 },
      },
      ["query"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      requiresAuth: false,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "sessions_export",
    title: "Export Sessions",
    description:
      "Return local Cloudeval CLI session history for the selected profile.",
    inputSchema: makeInputSchema({}),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      requiresAuth: false,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "identity_get",
    title: "Get Identity",
    description:
      "Return Cloudeval identity and capability metadata for the active credential.",
    inputSchema: makeInputSchema({}),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "auth_status",
    title: "Auth Status",
    description: "Return local Cloudeval authentication status.",
    inputSchema: makeInputSchema({}),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      requiresAuth: false,
    },
  },
  {
    name: "status",
    title: "CLI Status",
    description:
      "Return local Cloudeval CLI status and active configuration metadata.",
    inputSchema: makeInputSchema({}),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      requiresAuth: false,
    },
  },
  {
    name: "doctor",
    title: "CLI Doctor",
    description: "Return local Cloudeval CLI diagnostic checks.",
    inputSchema: makeInputSchema({
      deep: {
        type: "boolean",
        description: "Check backend reachability as well as local setup.",
        default: false,
      },
      mcp: {
        type: "boolean",
        description: "Include MCP metadata checks.",
        default: false,
      },
    }),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: false,
    },
  },
  {
    name: "config_show",
    title: "Show Config",
    description: "Return the selected Cloudeval CLI profile configuration.",
    inputSchema: makeInputSchema({}),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      requiresAuth: false,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "config_get",
    title: "Get Config Value",
    description: "Return one setting from the selected Cloudeval CLI profile.",
    inputSchema: makeInputSchema(
      {
        key: { type: "string", description: "Config key." },
      },
      ["key"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      requiresAuth: false,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "config_profiles",
    title: "List Config Profiles",
    description: "Return Cloudeval CLI config profile names.",
    inputSchema: makeInputSchema({}),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      requiresAuth: false,
    },
  },
  {
    name: "credentials_templates",
    title: "Credential Templates",
    description: "List Cloudeval access-key credential templates.",
    inputSchema: makeInputSchema({}),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
    },
  },
  {
    name: "credentials_list",
    title: "List Credentials",
    description:
      "List Cloudeval access-key credentials, optionally scoped by project.",
    inputSchema: makeInputSchema({
      projectId: projectIdProperty,
    }),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "credentials_inspect",
    title: "Inspect Credential",
    description: "Inspect a Cloudeval access-key credential by id.",
    inputSchema: makeInputSchema(
      {
        credentialId: { type: "string", description: "Credential id." },
      },
      ["credentialId"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "credentials_create",
    title: "Create Credential",
    description:
      "Create a scoped Cloudeval access-key credential. Secret values are redacted unless showSecret is true.",
    inputSchema: makeInputSchema(
      {
        template: { type: "string", description: "Credential template id." },
        name: { type: "string", description: "Credential name." },
        projectId: projectIdProperty,
        expires: {
          type: "string",
          description: "Expiration duration, for example 90d.",
        },
        capabilities: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        idempotencyKey: { type: "string" },
        showSecret: {
          type: "boolean",
          description:
            "Return the one-time access key secret. Defaults to false.",
          default: false,
        },
      },
      ["template", "name", "projectId"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "credentials_revoke",
    title: "Revoke Credential",
    description: "Revoke a Cloudeval access-key credential.",
    inputSchema: makeInputSchema(
      {
        credentialId: { type: "string", description: "Credential id." },
        reason: { type: "string", description: "Revocation reason." },
        idempotencyKey: { type: "string" },
      },
      ["credentialId"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "recipes_list",
    title: "List Recipes",
    description: "List Cloudeval reusable recipes and their safety metadata.",
    inputSchema: makeInputSchema({}),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      requiresAuth: false,
    },
  },
  {
    name: "recipes_get",
    title: "Get Recipe",
    description: "Fetch one Cloudeval recipe by id.",
    inputSchema: makeInputSchema(
      {
        recipeId: {
          type: "string",
          description: "Cloudeval recipe id.",
        },
      },
      ["recipeId"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      requiresAuth: false,
    },
  },
  {
    name: "recipes_run",
    title: "Run Recipe",
    description:
      "Run a Cloudeval recipe. Ask/agent recipes consume model credits; explicit side-effect recipes return commands instead of mutating automatically.",
    inputSchema: makeInputSchema(
      {
        recipeId: {
          type: "string",
          description: "Cloudeval recipe id.",
        },
        projectId: projectIdProperty,
        connectionId: { type: "string" },
        credentialId: { type: "string" },
        range: {
          type: "string",
          description: "Usage/report range such as 7d, 30d, 90d, or all.",
          default: "30d",
        },
        templateFile: { type: "string" },
        templateUrl: { type: "string" },
        parametersFile: { type: "string" },
        parametersUrl: { type: "string" },
        provider: { type: "string" },
        name: { type: "string" },
        outputPath: { type: "string" },
        outputDir: { type: "string" },
        client: { type: "string" },
        layout: { type: "string" },
        model: { type: "string" },
        threadId: { type: "string" },
      },
      ["recipeId"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      consumesCredits: true,
      writesLocalFile: false,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "reports_list",
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
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "reports_show",
    title: "Show Report",
    description: "Fetch one Cloudeval report by id for a project.",
    inputSchema: makeInputSchema(
      {
        reportId: { type: "string", description: "Cloudeval report id." },
        projectId: projectIdProperty,
        view: {
          type: "string",
          enum: ["raw", "parsed", "formatted"],
          default: "formatted",
        },
      },
      ["reportId"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "reports_cost",
    title: "Latest Cost Report",
    description:
      "Fetch the latest normalized Cloudeval cost report for a project.",
    inputSchema: makeInputSchema({
      projectId: projectIdProperty,
      period: { type: "string", default: "30d" },
      view: {
        type: "string",
        description: "Cost view hint such as overview or raw.",
      },
    }),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "reports_waf",
    title: "Latest WAF Report",
    description:
      "Fetch the latest normalized Well-Architected report for a project.",
    inputSchema: makeInputSchema({
      projectId: projectIdProperty,
      reportId: { type: "string", description: "Optional report id." },
      severity: { type: "string", description: "Optional severity filter." },
      view: {
        type: "string",
        description: "WAF view hint such as overview, rules, or raw.",
      },
    }),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "reports_rules",
    title: "WAF Rules",
    description:
      "Return WAF rule findings from the latest Cloudeval WAF report.",
    inputSchema: makeInputSchema({
      projectId: projectIdProperty,
      severity: { type: "string", description: "Optional severity filter." },
    }),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "reports_run",
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
      requiresAuth: true,
      consumesCredits: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "reports_download",
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
      requiresAuth: true,
      writesLocalFile: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "template_validate",
    title: "Validate Template",
    description:
      "Validate a local cloud template JSON file. Parameters files are accepted but optional.",
    inputSchema: makeInputSchema(
      {
        templatePath: templatePathProperty,
        parametersPath: parametersPathProperty,
        failedOnly: { type: "boolean", default: false },
        ruleId: {
          type: "string",
          description: "Single validation check id to run.",
        },
        ruleNames: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
          description:
            "Validation check ids to run. Accepts an array or comma-separated string.",
        },
        category: { type: "string", description: "Validation category filter." },
        pillar: { type: "string", description: "Architecture pillar filter." },
        minSeverity: { type: "string", description: "Minimum severity level." },
        maxResults: { type: "number", description: "Maximum validation results." },
        projectId: projectIdProperty,
        saveReport: { type: "boolean", default: false },
        details: {
          type: "boolean",
          description: "Include frontend-style per-check evidence details.",
          default: false,
        },
        wait: {
          type: "boolean",
          description:
            "Poll an async validation job until results are ready. When the MCP call includes _meta.progressToken, wait progress is emitted as notifications/progress.",
          default: false,
        },
        pollIntervalMs: {
          type: "number",
          description: "Polling interval when wait is true.",
        },
        waitTimeoutMs: {
          type: "number",
          description: "Maximum time to wait when wait is true.",
        },
      },
      ["templatePath"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      consumesCredits: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "template_test",
    title: "Run Template Tests",
    description:
      "Run local cloud template test checks. Parameters files are accepted but optional.",
    inputSchema: makeInputSchema(
      {
        templatePath: templatePathProperty,
        parametersPath: parametersPathProperty,
        includeTests: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
          description:
            "Template test names to run. Accepts an array or comma-separated string.",
        },
        skipTests: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
          description:
            "Template test names to skip. Accepts an array or comma-separated string.",
        },
        category: { type: "string", description: "Template test category." },
        testGroups: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
          description:
            "Template test groups to run. Accepts an array or comma-separated string.",
        },
        verbose: { type: "boolean", default: false },
        wait: {
          type: "boolean",
          description:
            "Poll an async template test job until results are ready. When the MCP call includes _meta.progressToken, wait progress is emitted as notifications/progress.",
          default: false,
        },
        pollIntervalMs: {
          type: "number",
          description: "Polling interval when wait is true.",
        },
        waitTimeoutMs: {
          type: "number",
          description: "Maximum time to wait when wait is true.",
        },
      },
      ["templatePath"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      consumesCredits: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "template_parse",
    title: "Parse Template",
    description:
      "Parse a local cloud template JSON file. Parameters files are accepted but optional.",
    inputSchema: makeInputSchema(
      {
        templatePath: templatePathProperty,
        parametersPath: parametersPathProperty,
        location: { type: "string", description: "Default location for resolved resources." },
      },
      ["templatePath"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      consumesCredits: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "rules_categories",
    title: "Rule Categories",
    description: "List cloud validation check categories.",
    inputSchema: makeInputSchema({}),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
    },
  },
  {
    name: "rules_search",
    title: "Search Rules",
    description: "Search cloud validation checks.",
    inputSchema: makeInputSchema(
      {
        query: { type: "string", description: "Search query." },
        category: { type: "string", description: "Category filter." },
        pillar: { type: "string", description: "Architecture pillar filter." },
      },
      ["query"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
    },
  },
  {
    name: "rules_get",
    title: "Get Rule",
    description: "Show one cloud validation check by id.",
    inputSchema: makeInputSchema(
      {
        ruleId: { type: "string", description: "Validation check id." },
      },
      ["ruleId"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
    },
  },
  {
    name: "billing_summary",
    title: "Billing Summary",
    description:
      "Return Cloudeval billing entitlement, credit status, and subscription status.",
    inputSchema: makeInputSchema({}),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "billing_usage",
    title: "Billing Usage",
    description:
      "Return Cloudeval billing usage summary with date, granularity, and model filters.",
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
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "billing_ledger",
    title: "Billing Ledger",
    description: "Return paginated Cloudeval billing ledger entries.",
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
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "billing_plans",
    title: "Billing Plans",
    description: "Return Cloudeval billing plan configuration.",
    inputSchema: makeInputSchema({}),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: false,
    },
  },
  {
    name: "billing_topups",
    title: "Billing Top-ups",
    description: "Return available Cloudeval credit top-up packs.",
    inputSchema: makeInputSchema({}),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      mayExposeSensitiveData: false,
    },
  },
  {
    name: "billing_invoices",
    title: "Billing Invoices",
    description:
      "Return Cloudeval subscription invoice or billing-info records.",
    inputSchema: makeInputSchema({
      limit: { type: "number", default: 25 },
    }),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "billing_notifications",
    title: "Billing Notifications",
    description:
      "Return Cloudeval billing notifications for the authenticated account.",
    inputSchema: makeInputSchema({
      limit: { type: "number", default: 25 },
    }),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "billing_topup_checkout",
    title: "Create Top-up Checkout",
    description:
      "Create a checkout session for a selected top-up pack. This is explicit and externally visible.",
    inputSchema: makeInputSchema(
      {
        packId: { type: "string", description: "Top-up pack id." },
        preferredCurrency: { type: "string" },
        countryCode: { type: "string" },
        contactEmail: { type: "string" },
        contactPhone: { type: "string" },
        contactCountryCode: { type: "string" },
        returnTo: { type: "string" },
      },
      ["packId"],
    ),
    outputSchema: envelopeSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
      requiresAuth: true,
      mayExposeSensitiveData: true,
    },
  },
  {
    name: "open_url",
    title: "Build Frontend URL",
    description:
      "Build a Cloudeval frontend deep link. Optionally open it in the system browser.",
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
      requiresAuth: false,
    },
  },
  {
    name: "cloudeval_iac_detect",
    title: "Detect IaC",
    description: "Detect ARM, Bicep, Terraform, and OpenTofu files in a workspace.",
    inputSchema: makeInputSchema({
      workspace: { type: "string", description: "Workspace directory.", default: "." },
    }),
    outputSchema: envelopeSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, requiresAuth: false },
  },
  {
    name: "cloudeval_iac_index",
    title: "Index IaC",
    description: "Index resources and ranges in an IaC file or workspace.",
    inputSchema: makeInputSchema({
      file: { type: "string", description: "IaC file path." },
      workspace: { type: "string", description: "Workspace directory.", default: "." },
    }),
    outputSchema: envelopeSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, requiresAuth: false },
  },
  {
    name: "cloudeval_review_local",
    title: "Review Local IaC",
    description: "Run the IDE local review path. This tool indexes resources and returns local support state.",
    inputSchema: makeInputSchema({
      file: { type: "string", description: "IaC file path." },
      workspace: { type: "string", description: "Workspace directory.", default: "." },
      projectId: projectIdProperty,
    }),
    outputSchema: envelopeSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, requiresAuth: false },
  },
  {
    name: "cloudeval_get_finding_evidence",
    title: "Get Finding Evidence",
    description: "Read evidence for a finding from a Cloudeval IDE run cache.",
    inputSchema: makeInputSchema({
      workspace: { type: "string", description: "Workspace directory.", default: "." },
      runId: { type: "string", description: "IDE run id." },
      findingId: { type: "string", description: "Finding id." },
    }, ["runId", "findingId"]),
    outputSchema: envelopeSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, requiresAuth: false },
  },
  {
    name: "cloudeval_get_resource_context",
    title: "Get Resource Context",
    description: "Return indexed resources for an IaC file or workspace.",
    inputSchema: makeInputSchema({
      file: { type: "string", description: "IaC file path." },
      workspace: { type: "string", description: "Workspace directory.", default: "." },
    }),
    outputSchema: envelopeSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, requiresAuth: false },
  },
  {
    name: "cloudeval_explain_blast_radius",
    title: "Explain Blast Radius",
    description: "Fetch Cloudeval graph-neighborhood evidence for a project resource.",
    inputSchema: makeInputSchema({
      projectId: projectIdProperty,
      resourceId: { type: "string", description: "Cloudeval resource id or IaC address." },
      limit: { type: "number", description: "Maximum graph insight items." },
    }, ["resourceId"]),
    outputSchema: envelopeSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, requiresAuth: true },
  },
  {
    name: "cloudeval_draft_fix",
    title: "Draft Fix",
    description: "Return a non-mutating draft-fix proposal for a finding.",
    inputSchema: makeInputSchema({
      workspace: { type: "string", description: "Workspace directory.", default: "." },
      runId: { type: "string", description: "IDE run id." },
      findingId: { type: "string", description: "Finding id." },
    }, ["runId", "findingId"]),
    outputSchema: envelopeSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, requiresAuth: false },
  },
  {
    name: "cloudeval_generate_ci_gate",
    title: "Generate CI Gate",
    description: "Generate Cloudeval CI gate files. This MCP tool returns file contents and does not write files.",
    inputSchema: makeInputSchema({
      projectId: projectIdProperty,
      provider: { type: "string", enum: ["github-actions", "azure-pipelines"] },
    }, ["projectId"]),
    outputSchema: envelopeSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, requiresAuth: false },
  },
];

export const mcpToolNames = mcpToolDefinitions.map((tool) => tool.name);

const toolByName = new Map(mcpToolDefinitions.map((tool) => [tool.name, tool]));
const MCP_TOOL_ALIASES: Record<string, string> = {
  "capabilities.get": "capabilities_get",
  "projects.list": "projects_list",
  "projects.get": "projects_get",
  "projects.overview": "projects_overview",
  "cloudeval_project_overview": "projects_overview",
  "agentProfiles.list": "agent_profiles_list",
  "agentProfiles.get": "agent_profiles_get",
  "agentProfiles.run": "agent_profiles_run",
  "projects.exportDiagram": "projects_export_diagram",
  "projects.diagramImage": "projects_export_diagram",
  "projects.graph": "projects_graph_get",
  "projects.graphTimeline": "projects_graph_timeline",
  "projects.graphDiff": "projects_graph_diff",
  "projects.graphInsights": "projects_graph_insights",
  "projects.graphSyncRuns": "projects_graph_sync_runs",
  "connections.list": "connections_list",
  "connections.get": "connections_get",
  "reports.list": "reports_list",
  "reports.show": "reports_show",
  "reports.cost": "reports_cost",
  "reports.waf": "reports_waf",
  "reports.rules": "reports_rules",
  "reports.run": "reports_run",
  "reports.download": "reports_download",
  "template.validate": "template_validate",
  "template.test": "template_test",
  "template.parse": "template_parse",
  "rules.categories": "rules_categories",
  "rules.search": "rules_search",
  "rules.get": "rules_get",
  "billing.summary": "billing_summary",
  "billing.usage": "billing_usage",
  "billing.ledger": "billing_ledger",
  "billing.plans": "billing_plans",
  "billing.topups": "billing_topups",
  "billing.invoices": "billing_invoices",
  "billing.notifications": "billing_notifications",
  "billing.topupCheckout": "billing_topup_checkout",
  "models.list": "models_list",
  "models.defaultGet": "models_default_get",
  "models.defaultSet": "models_default_set",
  "sessions.list": "sessions_list",
  "sessions.get": "sessions_get",
  "sessions.search": "sessions_search",
  "sessions.export": "sessions_export",
  "identity.get": "identity_get",
  "auth.status": "auth_status",
  "config.show": "config_show",
  "config.get": "config_get",
  "config.profiles": "config_profiles",
  "credentials.templates": "credentials_templates",
  "credentials.list": "credentials_list",
  "credentials.inspect": "credentials_inspect",
  "credentials.create": "credentials_create",
  "credentials.revoke": "credentials_revoke",
  "recipes.list": "recipes_list",
  "recipes.get": "recipes_get",
  "recipes.run": "recipes_run",
  "open.url": "open_url",
};

const MCP_TOOLSETS: Record<McpToolsetName, readonly string[]> = {
  all: mcpToolNames,
  readonly: [
    "capabilities_get",
    "agent_profiles_list",
    "agent_profiles_get",
    "projects_list",
    "projects_get",
    "projects_overview",
    "projects_graph_get",
    "projects_graph_timeline",
    "projects_graph_diff",
    "projects_graph_insights",
    "projects_graph_sync_runs",
    "connections_list",
    "connections_get",
    "reports_list",
    "reports_show",
    "reports_cost",
    "reports_waf",
    "reports_rules",
    "rules_categories",
    "rules_search",
    "rules_get",
    "billing_summary",
    "billing_usage",
    "billing_ledger",
    "billing_plans",
    "billing_topups",
    "billing_invoices",
    "billing_notifications",
    "models_list",
    "models_default_get",
    "sessions_list",
    "sessions_get",
    "sessions_search",
    "sessions_export",
    "identity_get",
    "auth_status",
    "status",
    "doctor",
    "config_show",
    "config_get",
    "config_profiles",
    "credentials_templates",
    "credentials_list",
    "credentials_inspect",
    "recipes_list",
    "recipes_get",
  ],
  projects: [
    "capabilities_get",
    "projects_list",
    "projects_get",
    "projects_overview",
    "connections_list",
    "connections_get",
    "projects_export_diagram",
    "projects_graph_get",
    "projects_graph_timeline",
    "projects_graph_diff",
    "projects_graph_insights",
    "projects_graph_sync_runs",
    "recipes_list",
    "recipes_get",
    "open_url",
  ],
  ide: [
    "capabilities_get",
    "cloudeval_iac_detect",
    "cloudeval_iac_index",
    "cloudeval_review_local",
    "cloudeval_get_finding_evidence",
    "cloudeval_get_resource_context",
    "cloudeval_explain_blast_radius",
    "cloudeval_draft_fix",
    "cloudeval_generate_ci_gate",
    "projects_list",
    "projects_get",
    "projects_overview",
    "connections_list",
    "connections_get",
    "projects_graph_get",
    "projects_graph_timeline",
    "projects_graph_insights",
    "projects_graph_sync_runs",
    "reports_list",
    "reports_show",
    "reports_cost",
    "reports_waf",
    "reports_rules",
    "billing_summary",
    "billing_usage",
    "rules_categories",
    "rules_search",
    "rules_get",
    "template_validate",
    "recipes_list",
    "recipes_get",
    "open_url",
  ],
  reports: [
    "capabilities_get",
    "projects_list",
    "projects_get",
    "reports_list",
    "reports_show",
    "reports_cost",
    "reports_waf",
    "reports_rules",
    "reports_run",
    "reports_download",
    "recipes_list",
    "recipes_get",
    "open_url",
  ],
  billing: [
    "capabilities_get",
    "billing_summary",
    "billing_usage",
    "billing_ledger",
    "billing_plans",
    "billing_topups",
    "billing_invoices",
    "billing_notifications",
    "billing_topup_checkout",
    "open_url",
  ],
  graph: [
    "capabilities_get",
    "projects_list",
    "projects_get",
    "projects_overview",
    "projects_graph_get",
    "projects_graph_timeline",
    "projects_graph_diff",
    "projects_graph_insights",
    "projects_graph_sync_runs",
    "recipes_list",
    "recipes_get",
  ],
  validation: [
    "capabilities_get",
    "template_validate",
    "template_test",
    "template_parse",
    "rules_categories",
    "rules_search",
    "rules_get",
    "recipes_list",
    "recipes_get",
  ],
};

const MCP_TOOLSET_NAMES = Object.keys(MCP_TOOLSETS) as McpToolsetName[];

const normalizeMcpToolset = (value?: string): McpToolsetName => {
  const normalized = (value ?? "readonly").toLowerCase();
  if ((MCP_TOOLSET_NAMES as readonly string[]).includes(normalized)) {
    return normalized as McpToolsetName;
  }
  throw new Error(
    `Unknown MCP toolset '${value}'. Expected one of: ${MCP_TOOLSET_NAMES.join(", ")}.`,
  );
};

const toolsForToolset = (toolset: McpToolsetName): McpToolDefinition[] => {
  return MCP_TOOLSETS[toolset]
    .map((name) => toolByName.get(name))
    .filter((tool): tool is McpToolDefinition => Boolean(tool));
};

const mcpResourceDefinitions: McpResourceDefinition[] = [
  {
    uri: "cloudeval://capabilities",
    name: "capabilities",
    title: "Cloudeval Capabilities",
    description: "Cloudeval CLI and MCP capability metadata.",
    mimeType: "application/json",
  },
  {
    uri: "cloudeval://projects",
    name: "projects",
    title: "Cloudeval Projects",
    description: "Projects visible to the authenticated Cloudeval account.",
    mimeType: "application/json",
  },
  {
    uri: "cloudeval://billing/summary",
    name: "billing-summary",
    title: "Cloudeval Billing Summary",
    description: "Billing entitlement, credits, and subscription status.",
    mimeType: "application/json",
  },
  {
    uri: "cloudeval://reports/latest",
    name: "latest-reports",
    title: "Latest Cloudeval Reports",
    description:
      "Latest cost and Well-Architected report list for the default project.",
    mimeType: "application/json",
  },
  {
    uri: "cloudeval://recipes",
    name: "recipes",
    title: "Cloudeval Recipes",
    description: "Cloudeval reusable recipes and agent skill metadata.",
    mimeType: "application/json",
  },
  {
    uri: "cloudeval://skills",
    name: "skills",
    title: "Cloudeval Skills",
    description: "Public Cloudeval SKILL.md catalog for agent reasoning.",
    mimeType: "application/json",
  },
  {
    uri: "cloudeval://workspace/detections",
    name: "workspace-detections",
    title: "Workspace IaC Detections",
    description: "Auth-free local IaC detection results for the current workspace.",
    mimeType: "application/json",
  },
  {
    uri: "cloudeval://runs/latest",
    name: "latest-ide-run",
    title: "Latest IDE Review Run",
    description: "Latest Cloudeval IDE review run when available from local cache.",
    mimeType: "application/json",
  },
  {
    uri: "cloudeval://findings/latest",
    name: "latest-findings",
    title: "Latest IDE Findings",
    description: "Latest local IDE findings when available from local cache.",
    mimeType: "application/json",
  },
];

const idePromptDefinitions: McpPromptDefinition[] = [
  {
    name: "review_current_iac_file",
    title: "Review Current IaC File",
    description: "Index and review the current IaC file using Cloudeval evidence where available.",
    arguments: [{ name: "file", description: "IaC file path.", required: true }],
  },
  {
    name: "explain_finding_with_evidence",
    title: "Explain Finding With Evidence",
    description: "Explain a Cloudeval finding using evidence, freshness, confidence, and resource mapping.",
    arguments: [
      { name: "runId", description: "IDE run id.", required: true },
      { name: "findingId", description: "Finding id.", required: true },
    ],
  },
  {
    name: "draft_safe_fix",
    title: "Draft Safe Fix",
    description: "Draft a non-mutating fix proposal for a Cloudeval finding.",
    arguments: [
      { name: "runId", description: "IDE run id.", required: true },
      { name: "findingId", description: "Finding id.", required: true },
    ],
  },
  {
    name: "generate_ci_gate",
    title: "Generate CI Gate",
    description: "Generate a Cloudeval CI gate using the existing cloudeval review command.",
    arguments: [{ name: "projectId", description: "Cloudeval project id.", required: true }],
  },
  {
    name: "explain_blast_radius",
    title: "Explain Blast Radius",
    description: "Explain blast radius using Cloudeval graph-neighborhood evidence.",
    arguments: [
      { name: "projectId", description: "Cloudeval project id.", required: true },
      { name: "resourceId", description: "Resource id or IaC address.", required: true },
    ],
  },
];

const mcpPromptDefinitions: McpPromptDefinition[] = [
  ...recipes.map((recipe) => ({
    name: recipe.id,
    title: recipe.title,
    description: recipe.description,
    arguments: recipe.inputs.map((input) => ({
      name: input.name === "projectId" ? "projectId" : input.name,
      description: input.description,
      required: input.required,
    })),
  })),
  ...idePromptDefinitions,
];

const MCP_RESOURCE_TOOL_REQUIREMENTS: Record<string, readonly string[]> = {
  "cloudeval://capabilities": ["capabilities_get"],
  "cloudeval://projects": ["projects_list"],
  "cloudeval://billing/summary": ["billing_summary"],
  "cloudeval://reports/latest": ["reports_list"],
  "cloudeval://recipes": ["recipes_list"],
  "cloudeval://skills": ["capabilities_get"],
  "cloudeval://workspace/detections": ["cloudeval_iac_detect"],
  "cloudeval://runs/latest": ["cloudeval_review_local"],
  "cloudeval://findings/latest": ["cloudeval_get_finding_evidence"],
};

const promptRequirementTools = (tools: string[]): string[] =>
  tools.filter((tool) => tool !== "ask" && tool !== "recipes_run");

const MCP_PROMPT_TOOL_REQUIREMENTS: Record<string, readonly string[]> =
  {
    ...Object.fromEntries(
      recipes.map((recipe) => [
        recipe.id,
        promptRequirementTools(recipe.mcpTools),
      ]),
    ),
    review_current_iac_file: ["cloudeval_iac_index"],
    explain_finding_with_evidence: ["cloudeval_get_finding_evidence"],
    draft_safe_fix: ["cloudeval_draft_fix"],
    generate_ci_gate: ["cloudeval_generate_ci_gate"],
    explain_blast_radius: ["cloudeval_explain_blast_radius"],
  };

const hasRequiredTools = (
  requiredTools: readonly string[] | undefined,
  availableToolNames: Set<string>,
): boolean =>
  (requiredTools ?? []).every((toolName) => availableToolNames.has(toolName));

const resourcesForToolset = (
  toolset: McpToolsetName,
): McpResourceDefinition[] => {
  const availableToolNames = new Set(MCP_TOOLSETS[toolset]);
  return mcpResourceDefinitions.filter((resource) =>
    hasRequiredTools(
      MCP_RESOURCE_TOOL_REQUIREMENTS[resource.uri],
      availableToolNames,
    ),
  );
};

const promptsForToolset = (toolset: McpToolsetName): McpPromptDefinition[] => {
  const availableToolNames = new Set(MCP_TOOLSETS[toolset]);
  return mcpPromptDefinitions.filter((prompt) =>
    hasRequiredTools(
      MCP_PROMPT_TOOL_REQUIREMENTS[prompt.name],
      availableToolNames,
    ),
  );
};

export const getMcpStatusData = () => ({
  protocolVersion: MCP_PROTOCOL_VERSION,
  protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
  serverInfo: {
    name: "cloudeval",
    title: "Cloudeval CLI MCP Server",
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
        status:
          mcpToolDefinitions.length > 0 ? ("pass" as const) : ("fail" as const),
        detail: `${mcpToolDefinitions.length} tools across ${MCP_TOOLSET_NAMES.length} toolsets`,
      },
      {
        id: "mcp-resources-list",
        label: "MCP resources/list is available",
        status:
          mcpResourceDefinitions.length > 0
            ? ("pass" as const)
            : ("fail" as const),
        detail: `${mcpResourceDefinitions.length} resources`,
      },
      {
        id: "mcp-prompts-list",
        label: "MCP prompts/list is available",
        status:
          mcpPromptDefinitions.length > 0
            ? ("pass" as const)
            : ("fail" as const),
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
  warnings?: string[];
  schemaVersion?: string;
  freshness?: unknown;
  evidence?: unknown[];
}): SuccessEnvelope<T> =>
  formatSuccessEnvelope({
    command: input.command,
    data: input.data,
    frontendUrl: input.frontendUrl,
    filesWritten: input.filesWritten,
    traceId: input.traceId,
    warnings: input.warnings,
    schemaVersion: input.schemaVersion,
    freshness: input.freshness,
    evidence: input.evidence,
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
    accessKey: serverOptions.accessKey,
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
      accessKey: config.accessKey,
      baseUrl: config.baseUrl,
    });
  } catch (error: any) {
    throw new Error(
      `${error?.message ?? "Authentication failed"} MCP stdio cannot run browser or stdin login flows; run 'cloudeval login' first or provide CLOUDEVAL_ACCESS_KEY / --access-key.`,
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
    throw new Error(
      "Could not determine the authenticated user. Run `cloudeval login` and retry.",
    );
  }

  const projects = await auth.core.getProjects(
    config.baseUrl,
    auth.token,
    userId,
  );
  if (requestedProjectId) {
    const match = projects.find(
      (project: any) => project.id === requestedProjectId,
    );
    if (!match) {
      throw new Error(
        `Project ${requestedProjectId} was not found for authenticated user ${userId}. ` +
          "Run `cloudeval projects list` to choose a visible project.",
      );
    }
    return match;
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

const projectStarterPromptType = (project: any): "template" | "sync" =>
  String(project?.project_data_source ?? project?.type ?? "")
    .trim()
    .toLowerCase() === "template"
    ? "template"
    : "sync";

const starterPromptForProject = (profile: any, project: any): string =>
  profile.starter_prompts?.[projectStarterPromptType(project)]?.trim() ||
  profile.starter_prompt;

const listProfilesForDiscovery = async (
  core: typeof import("@cloudeval/core"),
  baseUrl: string,
) => {
  try {
    return await core.listAgentProfiles({
      baseUrl,
    });
  } catch (error) {
    if (core.isAgentProfileDiscoveryFallbackError(error)) {
      return { profiles: getBundledAgentProfiles() };
    }
    throw error;
  }
};

const getProfileForDiscovery = async (
  core: typeof import("@cloudeval/core"),
  baseUrl: string,
  profileId: string,
) => {
  try {
    return await core.getAgentProfile({
      baseUrl,
      profileId,
    });
  } catch (error) {
    if (core.isAgentProfileDiscoveryFallbackError(error)) {
      const profile = getBundledAgentProfile(profileId);
      if (!profile) {
        throw new Error(`Unknown Agent Profile "${profileId}".`);
      }
      return { profile };
    }
    throw error;
  }
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

const resolveMcpReportProjectId = async (
  config: InvocationConfig,
  args: JsonRecord,
  auth: Awaited<ReturnType<typeof resolveAuth>>,
): Promise<string> =>
  resolveReportProjectId({
    baseUrl: config.baseUrl,
    token: auth.token,
    requestedProjectId: stringValue(args.projectId) ?? config.defaultProjectId,
    workspace: {
      checkUserStatus: auth.core.checkUserStatus,
      getProjects: auth.core.getProjects,
    },
  });

const arrayValue = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  if (typeof value === "string") {
    const parsed = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return parsed.length ? parsed : undefined;
  }
  return undefined;
};

const boundedLimit = (value: unknown, fallback: number, max: number): number =>
  Math.max(1, Math.min(max, Math.floor(numberValue(value) ?? fallback)));

const redactCredentialSecrets = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(redactCredentialSecrets);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/^(access_?key|secret|token|api_?key|private_?key)$/i.test(key)) {
      output[key] = "<redacted>";
      continue;
    }
    output[key] = redactCredentialSecrets(item);
  }
  return output;
};

const rulesFromWafReport = (report: unknown): unknown[] => {
  if (!report || typeof report !== "object") {
    return [];
  }
  const record = report as Record<string, any>;
  const candidates = [
    record.parsed?.rules,
    record.raw?.rules,
    record.raw?.ruleResults,
    record.raw?.all_rules,
    record.all_rules,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
};

const buildToolHandlers = (
  serverOptions: ServeMcpOptions,
): Map<string, ToolHandler> => {
  const handlers = new Map<string, ToolHandler>();

  handlers.set("capabilities_get", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const toolset = normalizeMcpToolset(serverOptions.toolset);
    let live: unknown;
    try {
      const auth = await resolveAuth(config);
      live = await auth.core.getCapabilities({
        baseUrl: config.baseUrl,
        authToken: auth.token,
      });
    } catch {
      live = undefined;
    }
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
          resources: resourcesForToolset(toolset).map(
            (resource) => resource.uri,
          ),
          prompts: promptsForToolset(toolset).map((prompt) => prompt.name),
        },
        defaults: {
          baseUrl: config.baseUrl,
          frontendUrl: config.frontendUrl,
          profile: config.profile,
          defaultProjectId: config.defaultProjectId,
          model: config.model,
        },
        ...(live ? { live } : {}),
      },
    });
  });

  handlers.set("agent_profiles_list", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const core = await import("@cloudeval/core");
    const data = await listProfilesForDiscovery(core, config.baseUrl);
    return withEnvelope({
      command: "agents list",
      data,
    });
  });

  handlers.set("agent_profiles_get", async (args) => {
    const profileId = stringValue(args.profileId);
    if (!profileId) {
      throw new Error("profileId is required.");
    }
    const config = await resolveInvocationConfig(serverOptions, args);
    const core = await import("@cloudeval/core");
    const data = await getProfileForDiscovery(core, config.baseUrl, profileId);
    return withEnvelope({
      command: "agents show",
      data,
    });
  });

  handlers.set("agent_profiles_run", async (args) => {
    const profileId = stringValue(args.profileId);
    if (!profileId) {
      throw new Error("profileId is required.");
    }
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config);
    const profileResponse = await auth.core.getAgentProfile({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      profileId,
    });
    const profile = (profileResponse as any)?.profile;
    if (!profile?.id) {
      throw new Error("Agent Profile response did not include a profile.");
    }
    await assertModelAvailable(config, auth.token);
    const project = await resolveProject(config, args, auth);
    const threadId = stringValue(args.threadId) ?? randomUUID();
    const prompt =
      stringValue(args.prompt) ?? starterPromptForProject(profile, project);
    const email = auth.core.extractEmailFromToken(auth.token);
    const userName = getFirstNameForDisplay({
      email: email ?? auth.user?.email,
    });
    let chatState: any = { ...auth.core.initialChatState, threadId };
    let responseText = "";
    for await (const chunk of auth.core.streamChat({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      message: prompt,
      threadId,
      user: {
        id: project.user_id ?? auth.user?.id ?? "cli-user",
        name: userName,
      },
      project,
      settings: {
        ...((stringValue(args.model) ?? config.model)
          ? { model: stringValue(args.model) ?? config.model }
          : {}),
        mode: profile.default_mode,
      },
      agentProfileId: profile.id,
      completeAfterResponse: true,
      responseCompletionGraceMs: 5000,
      streamIdleTimeoutMs: AGENT_PROFILE_STREAM_IDLE_TIMEOUT_MS,
    })) {
      chatState = auth.core.reduceChunk(chatState, chunk);
      if (
        chunk.type === "responding" &&
        chunk.content &&
        (!chunk.node || STREAM_OUTPUT_NODES.has(chunk.node))
      ) {
        responseText =
          [...chatState.messages]
            .reverse()
            .find((message: any) => message.role === "assistant")?.content ||
          chunk.content;
      }
      if (chunk.type === "error") {
        throw new Error(
          chunk.message ||
            chunk.description ||
            "Cloudeval Agent Profile run failed.",
        );
      }
    }
    const finalMessage = [...chatState.messages]
      .reverse()
      .find((message: any) => message.role === "assistant");
    const frontendUrl = buildFrontendUrl({
      baseUrl: frontendBase(config),
      target: "chat",
      threadId,
    });
    return withEnvelope({
      command: "agents run",
      data: {
        profile,
        prompt,
        response: finalMessage?.content || responseText,
        ...(finalMessage?.visualizations?.length
          ? { visualizations: finalMessage.visualizations }
          : {}),
        threadId,
        project: { id: project.id, name: project.name },
      },
      frontendUrl,
    });
  });

  handlers.set("projects_list", async (args) => {
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

  handlers.set("projects_get", async (args) => {
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

  handlers.set("projects_overview", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const projectId = stringValue(args.projectId) ?? config.defaultProjectId;
    if (!projectId) {
      throw new Error("projectId is required.");
    }
    const { overview, warnings, frontendUrl } = await buildProjectOverview({
      context: {
        baseUrl: config.baseUrl,
        token: auth.token,
        user: auth.user!,
      },
      core: auth.core,
      projectId,
      options: { frontendUrl: config.frontendUrl },
    });
    return withEnvelope({
      command: "projects overview",
      data: overview,
      frontendUrl,
      warnings,
      schemaVersion: "2026-07-ide-v1",
      freshness: {
        source: "project",
        observedAt: new Date().toISOString(),
        stale: false,
      },
    });
  });

  handlers.set("connections_list", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const data = await auth.core.listConnections({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      userId: auth.user!.id,
    });
    const frontendUrl = buildFrontendUrl({
      baseUrl: frontendBase(config),
      target: "connections",
    });
    return withEnvelope({
      command: "connections list",
      data,
      frontendUrl,
    });
  });

  handlers.set("connections_get", async (args) => {
    const connectionId = stringValue(args.connectionId);
    if (!connectionId) {
      throw new Error("connectionId is required.");
    }
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const data = await auth.core.getConnection({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      userId: auth.user!.id,
      connectionId,
    });
    if (!data) {
      throw new Error(`Connection ${connectionId} was not found.`);
    }
    const frontendUrl = buildFrontendUrl({
      baseUrl: frontendBase(config),
      target: "connection",
      connectionId,
    });
    return withEnvelope({
      command: "connections get",
      data,
      frontendUrl,
    });
  });

  handlers.set("projects_export_diagram", async (args) => {
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
    const imageFormat = normalizeProjectDiagramImageFormat(
      stringValue(args.format),
    );
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

  handlers.set("projects_graph_get", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const projectId = stringValue(args.projectId) ?? config.defaultProjectId;
    if (!projectId) {
      throw new Error("projectId is required.");
    }
    const data = await getProjectGraph({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      userId: auth.user!.id,
      projectId,
      syncVersion: stringValue(args.syncVersion),
      asOf: stringValue(args.asOf),
      includeDiff: booleanValue(args.includeDiff),
    });
    return withEnvelope({ command: "projects graph", data });
  });

  handlers.set("projects_graph_timeline", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const projectId = stringValue(args.projectId) ?? config.defaultProjectId;
    if (!projectId) {
      throw new Error("projectId is required.");
    }
    const data = await getProjectGraphTimeline({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      userId: auth.user!.id,
      projectId,
      limit: numberValue(args.limit),
    });
    return withEnvelope({ command: "projects graph timeline", data });
  });

  handlers.set("projects_graph_diff", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const projectId = stringValue(args.projectId) ?? config.defaultProjectId;
    if (!projectId) {
      throw new Error("projectId is required.");
    }
    const data = await getProjectGraphDiff({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      userId: auth.user!.id,
      projectId,
      fromSyncVersion: stringValue(args.fromSyncVersion),
      toSyncVersion: stringValue(args.toSyncVersion),
    });
    return withEnvelope({ command: "projects graph diff", data });
  });

  handlers.set("projects_graph_insights", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const projectId = stringValue(args.projectId) ?? config.defaultProjectId;
    if (!projectId) {
      throw new Error("projectId is required.");
    }
    const data = await getProjectGraphInsights({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      userId: auth.user!.id,
      projectId,
      focus: stringValue(args.focus),
      resourceId: stringValue(args.resourceId),
      syncVersion: stringValue(args.syncVersion),
      limit: numberValue(args.limit),
    });
    return withEnvelope({ command: "projects graph insights", data });
  });

  handlers.set("projects_graph_sync_runs", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const projectId = stringValue(args.projectId) ?? config.defaultProjectId;
    if (!projectId) {
      throw new Error("projectId is required.");
    }
    const data = await listProjectSyncRuns({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      userId: auth.user!.id,
      projectId,
      limit: numberValue(args.limit),
    });
    return withEnvelope({ command: "projects graph sync-runs", data });
  });

  handlers.set("template_validate", async (args, context) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const templatePath = stringValue(args.templatePath);
    if (!templatePath) {
      throw new Error("templatePath is required.");
    }
    const ruleId = stringValue(args.ruleId);
    const ruleNames = Array.from(new Set([
      ...(ruleId ? [ruleId] : []),
      ...(arrayValue(args.ruleNames) ?? []),
    ]));
    const submitted = await validateTemplate({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      userId: auth.user!.id,
      templatePath,
      parametersPath: stringValue(args.parametersPath),
      failedOnly: booleanValue(args.failedOnly),
      ruleNames,
      category: stringValue(args.category),
      pillar: stringValue(args.pillar),
      minSeverity: stringValue(args.minSeverity),
      maxResults: numberValue(args.maxResults),
      projectId: stringValue(args.projectId) ?? config.defaultProjectId,
      saveReport: booleanValue(args.saveReport),
    });
    const data = booleanValue(args.wait)
      ? await waitForTemplateValidationResult({
          baseUrl: config.baseUrl,
          authToken: auth.token,
          userId: auth.user!.id,
          submitted,
          pollIntervalMs: numberValue(args.pollIntervalMs),
          waitTimeoutMs: numberValue(args.waitTimeoutMs),
          templatePath,
          parametersPath: stringValue(args.parametersPath),
          onProgress: context?.sendProgress
            ? (event) => context.sendProgress!(event, "validate template")
            : undefined,
        })
      : submitted;
    return withEnvelope({
      command: "validate template",
      data: booleanValue(args.details)
        ? withTemplateValidationDetails(data)
        : data,
    });
  });

  handlers.set("template_test", async (args, context) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const templatePath = stringValue(args.templatePath);
    if (!templatePath) {
      throw new Error("templatePath is required.");
    }
    const submitted = await testTemplate({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      userId: auth.user!.id,
      templatePath,
      parametersPath: stringValue(args.parametersPath),
      includeTests: arrayValue(args.includeTests),
      skipTests: arrayValue(args.skipTests),
      testCategories: stringValue(args.category)
        ? [stringValue(args.category)!]
        : undefined,
      testGroups: arrayValue(args.testGroups),
      verboseOutput: booleanValue(args.verbose),
    });
    const data = booleanValue(args.wait)
      ? await waitForTemplateValidationResult({
          baseUrl: config.baseUrl,
          authToken: auth.token,
          userId: auth.user!.id,
          submitted,
          pollIntervalMs: numberValue(args.pollIntervalMs),
          waitTimeoutMs: numberValue(args.waitTimeoutMs),
          templatePath,
          parametersPath: stringValue(args.parametersPath),
          onProgress: context?.sendProgress
            ? (event) => context.sendProgress!(event, "validate tests")
            : undefined,
        })
      : submitted;
    return withEnvelope({
      command: "validate tests",
      data: withTemplateTestDetails(data, {
        templatePath,
        parametersPath: stringValue(args.parametersPath),
      }),
    });
  });

  handlers.set("template_parse", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const templatePath = stringValue(args.templatePath);
    if (!templatePath) {
      throw new Error("templatePath is required.");
    }
    const data = await parseTemplate({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      userId: auth.user!.id,
      templatePath,
      parametersPath: stringValue(args.parametersPath),
      location: stringValue(args.location),
      returnAll: true,
    });
    return withEnvelope({ command: "validate parse", data });
  });

  handlers.set("rules_categories", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config);
    const data = await getRuleCategories({
      baseUrl: config.baseUrl,
      authToken: auth.token,
    });
    return withEnvelope({ command: "rules categories", data });
  });

  handlers.set("rules_search", async (args) => {
    const query = stringValue(args.query);
    if (!query) {
      throw new Error("query is required.");
    }
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config);
    const data = await searchRules({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      query,
      category: stringValue(args.category),
      pillar: stringValue(args.pillar),
    });
    return withEnvelope({ command: "rules search", data });
  });

  handlers.set("rules_get", async (args) => {
    const ruleId = stringValue(args.ruleId);
    if (!ruleId) {
      throw new Error("ruleId is required.");
    }
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config);
    const data = await getRule({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      ruleId,
    });
    return withEnvelope({ command: "rules show", data });
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
    const mode = enumValue(args.mode, ["ask", "agent"], "ask");
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
      settings: {
        ...(config.model ? { model: config.model } : {}),
        mode,
      },
      completeAfterResponse: true,
      responseCompletionGraceMs: 5000,
      streamIdleTimeoutMs: ASK_STREAM_IDLE_TIMEOUT_MS,
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
          chunk.message || chunk.description || "Cloudeval ask failed.",
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
        ...(finalMessage?.visualizations?.length
          ? { visualizations: finalMessage.visualizations }
          : {}),
        threadId: chatState.threadId,
        mode,
        project: {
          id: project.id,
          name: project.name,
        },
      },
      frontendUrl,
      traceId: chatState.traceId,
    });
  });

  handlers.set("models_list", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config);
    const response = await fetch(
      `${auth.core.normalizeApiBase(config.baseUrl)}/models`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${auth.token}`,
        },
      },
    );
    if (!response.ok) {
      throw new Error(
        `Failed to list models: ${response.status} ${response.statusText}`,
      );
    }
    const payload = await response.json();
    return withEnvelope({
      command: "models list",
      data: payload,
    });
  });

  handlers.set("models_default_get", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const current = await loadCliConfig(config.profile);
    return withEnvelope({
      command: "models default get",
      data: { profile: config.profile, model: current.model ?? null },
    });
  });

  handlers.set("models_default_set", async (args) => {
    const model = stringValue(args.model);
    if (!model) {
      throw new Error("model is required.");
    }
    const config = await resolveInvocationConfig(serverOptions, args);
    const current = await loadCliConfig(config.profile);
    const next = { ...current, model };
    const configPath = await saveCliConfig(next, config.profile);
    return withEnvelope({
      command: "models default set",
      data: { profile: config.profile, path: configPath, model },
    });
  });

  handlers.set("sessions_list", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const data = await listSessions(
      boundedLimit(args.limit, 20, 200),
      config.profile,
    );
    return withEnvelope({
      command: "sessions list",
      data,
    });
  });

  handlers.set("sessions_get", async (args) => {
    const threadId = stringValue(args.threadId);
    if (!threadId) {
      throw new Error("threadId is required.");
    }
    const config = await resolveInvocationConfig(serverOptions, args);
    const data = await getSession(threadId, config.profile);
    if (!data) {
      throw new Error(`Session ${threadId} was not found.`);
    }
    return withEnvelope({
      command: "sessions get",
      data,
    });
  });

  handlers.set("sessions_search", async (args) => {
    const query = stringValue(args.query);
    if (!query) {
      throw new Error("query is required.");
    }
    const config = await resolveInvocationConfig(serverOptions, args);
    const data = await searchSessions(query, {
      profile: config.profile,
      limit: boundedLimit(args.limit, 20, 200),
    });
    return withEnvelope({
      command: "sessions search",
      data,
    });
  });

  handlers.set("sessions_export", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const data = await exportSessions(config.profile);
    return withEnvelope({
      command: "sessions export",
      data,
    });
  });

  handlers.set("identity_get", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config);
    const data = await auth.core.getIdentity({
      baseUrl: config.baseUrl,
      authToken: auth.token,
    });
    return withEnvelope({
      command: "identity",
      data,
    });
  });

  handlers.set("auth_status", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const core = await import("@cloudeval/core");
    const data = await core.getAuthStatus(config.baseUrl, { validate: true });
    return withEnvelope({
      command: "auth status",
      data,
    });
  });

  handlers.set("status", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const core = await import("@cloudeval/core");
    const auth = await core.getAuthStatus(config.baseUrl, { validate: true });
    return withEnvelope({
      command: "status",
      data: {
        profile: config.profile,
        baseUrl: config.baseUrl,
        configPath: getCliConfigPath(config.profile),
        config: await loadCliConfig(config.profile),
        auth,
        node: process.versions.node,
      },
    });
  });

  handlers.set("doctor", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const checks: Array<Record<string, unknown>> = [
      {
        id: "node-version",
        label: "Node.js version",
        status:
          Number(process.versions.node.split(".")[0] ?? 0) >= 20
            ? "pass"
            : "fail",
        detail: process.versions.node,
      },
      {
        id: "config-readable",
        label: "Config profile is readable",
        status: "pass",
        detail: getCliConfigPath(config.profile),
      },
    ];
    try {
      const core = await import("@cloudeval/core");
      core.assertSecureBaseUrl(config.baseUrl);
      checks.push({
        id: "base-url-secure",
        label: "Backend URL is HTTPS or localhost HTTP",
        status: "pass",
        detail: config.baseUrl,
      });
      const auth = await core.getAuthStatus(config.baseUrl);
      checks.push({
        id: "auth-storage",
        label: "Auth storage backend",
        status: auth.storageBackend === "memory" ? "warn" : "pass",
        detail: auth.storageBackend,
      });
    } catch (error: any) {
      checks.push({
        id: "base-url-secure",
        label: "Backend URL is HTTPS or localhost HTTP",
        status: "fail",
        detail: error?.message ?? String(error),
      });
    }
    if (booleanValue(args.deep)) {
      try {
        const response = await fetch(config.baseUrl.replace(/\/$/, ""));
        checks.push({
          id: "backend-reachable",
          label: "Backend is reachable",
          status: response.status < 500 ? "pass" : "warn",
          detail: `${response.status} ${response.statusText}`,
        });
      } catch (error: any) {
        checks.push({
          id: "backend-reachable",
          label: "Backend is reachable",
          status: "warn",
          detail: error?.message ?? String(error),
        });
      }
    }
    const mcp = booleanValue(args.mcp) ? getMcpDoctorChecks() : undefined;
    const allChecks = [...checks, ...(mcp?.checks ?? [])];
    return withEnvelope({
      command: "doctor",
      data: {
        ok: allChecks.every((check) => check.status !== "fail"),
        checks: allChecks,
        profile: config.profile,
        config: await loadCliConfig(config.profile),
        ...(mcp?.status ? { mcp: mcp.status } : {}),
      },
    });
  });

  handlers.set("config_show", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    return withEnvelope({
      command: "config show",
      data: await loadCliConfig(config.profile),
    });
  });

  handlers.set("config_get", async (args) => {
    const key = stringValue(args.key);
    if (!key) {
      throw new Error("key is required.");
    }
    const config = await resolveInvocationConfig(serverOptions, args);
    const data = await loadCliConfig(config.profile);
    return withEnvelope({
      command: "config get",
      data: { key, value: readCliConfigValue(data, key) ?? null },
    });
  });

  handlers.set("config_profiles", async () => {
    return withEnvelope({
      command: "config profiles",
      data: await listCliConfigProfiles(),
    });
  });

  handlers.set("credentials_templates", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config);
    const data = await auth.core.getCredentialTemplates({
      baseUrl: config.baseUrl,
      authToken: auth.token,
    });
    return withEnvelope({
      command: "credentials templates",
      data,
    });
  });

  handlers.set("credentials_list", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config);
    const data = await auth.core.listCredentials({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      projectId: stringValue(args.projectId),
    });
    return withEnvelope({
      command: "credentials list",
      data,
    });
  });

  handlers.set("credentials_inspect", async (args) => {
    const credentialId = stringValue(args.credentialId);
    if (!credentialId) {
      throw new Error("credentialId is required.");
    }
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config);
    const data = await auth.core.getCredential({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      credentialId,
    });
    return withEnvelope({
      command: "credentials inspect",
      data,
    });
  });

  handlers.set("credentials_create", async (args) => {
    const template = stringValue(args.template);
    const name = stringValue(args.name);
    const projectId = stringValue(args.projectId);
    if (!template || !name || !projectId) {
      throw new Error("template, name, and projectId are required.");
    }
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config);
    const data = await auth.core.createCredential({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      template,
      name,
      projectId,
      expires: stringValue(args.expires),
      capabilities: arrayValue(args.capabilities),
      idempotencyKey: stringValue(args.idempotencyKey) ?? randomUUID(),
    });
    return withEnvelope({
      command: "credentials create",
      data: booleanValue(args.showSecret)
        ? data
        : redactCredentialSecrets(data),
    });
  });

  handlers.set("credentials_revoke", async (args) => {
    const credentialId = stringValue(args.credentialId);
    if (!credentialId) {
      throw new Error("credentialId is required.");
    }
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config);
    const data = await auth.core.revokeCredential({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      credentialId,
      reason: stringValue(args.reason),
      idempotencyKey: stringValue(args.idempotencyKey) ?? randomUUID(),
    });
    return withEnvelope({
      command: "credentials revoke",
      data,
    });
  });

  handlers.set("recipes_list", async () => {
    return withEnvelope({
      command: "recipes list",
      data: { recipes: recipes.map(recipeSummary) },
    });
  });

  handlers.set("recipes_get", async (args) => {
    const recipeId = stringValue(args.recipeId);
    if (!recipeId) {
      throw new Error("recipeId is required.");
    }
    const recipe = getRecipe(recipeId);
    if (!recipe) {
      throw new Error(`Unknown recipe '${recipeId}'.`);
    }
    return withEnvelope({
      command: "recipes get",
      data: recipe,
    });
  });

  handlers.set("recipes_run", async (args) => {
    const recipeId = stringValue(args.recipeId);
    if (!recipeId) {
      throw new Error("recipeId is required.");
    }
    const recipe = getRecipe(recipeId);
    if (!recipe) {
      throw new Error(`Unknown recipe '${recipeId}'.`);
    }
    const recipeContext = {
      projectId: stringValue(args.projectId),
      connectionId: stringValue(args.connectionId),
      credentialId: stringValue(args.credentialId),
      range: stringValue(args.range),
      templateFile: stringValue(args.templateFile),
      templateUrl: stringValue(args.templateUrl),
      parametersFile: stringValue(args.parametersFile),
      parametersUrl: stringValue(args.parametersUrl),
      provider: stringValue(args.provider),
      name: stringValue(args.name),
      outputPath: stringValue(args.outputPath),
      outputDir: stringValue(args.outputDir),
      client: stringValue(args.client),
      model: stringValue(args.model),
      layout: stringValue(args.layout),
      format: stringValue(args.format),
    };
    const prompt = renderRecipePrompt(recipe, recipeContext);
    const commands = renderRecipeCommands(recipe, recipeContext);
    if (recipe.mode === "guide") {
      return withEnvelope({
        command: "recipes run",
        data: {
          recipeId: recipe.id,
          title: recipe.title,
          mode: recipe.mode,
          prompt,
          commands,
          safety: recipe.safety,
          expectedOutput: recipe.expectedOutput,
          note: "This recipe requires explicit user-run commands for side effects; no mutation was performed.",
        },
      });
    }
    const askHandler = handlers.get("ask");
    if (!askHandler) {
      throw new Error("ask tool is unavailable.");
    }
    const envelope = await askHandler({
      ...args,
      question: prompt,
      mode: recipe.mode,
      threadId: stringValue(args.threadId),
      projectId: stringValue(args.projectId),
      model: stringValue(args.model),
    });
    return withEnvelope({
      command: "recipes run",
      data: {
        recipeId: recipe.id,
        title: recipe.title,
        mode: recipe.mode,
        prompt,
        commands,
        safety: recipe.safety,
        ...(envelope.data as Record<string, unknown>),
      },
      frontendUrl: envelope.frontendUrl,
      traceId: envelope.traceId,
    });
  });

  handlers.set("reports_list", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const projectId = await resolveMcpReportProjectId(config, args, auth);
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

  handlers.set("reports_show", async (args) => {
    const reportId = stringValue(args.reportId);
    if (!reportId) {
      throw new Error("reportId is required.");
    }
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const projectId = await resolveMcpReportProjectId(config, args, auth);
    const view = enumValue<ReportView>(
      args.view,
      ["raw", "parsed", "formatted"],
      "formatted",
    );
    const report = await auth.core.getReport({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      projectId,
      reportId,
      view,
      userId: auth.user?.id,
    });
    return withEnvelope({
      command: "reports show",
      data: report,
      frontendUrl: reportsFrontendUrl(config, { projectId }),
    });
  });

  handlers.set("reports_cost", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const projectId = await resolveMcpReportProjectId(config, args, auth);
    const report = await auth.core.getCostReport({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      projectId,
      period: stringValue(args.period) ?? "30d",
      view: stringValue(args.view),
      userId: auth.user?.id,
    });
    return withEnvelope({
      command: "reports cost",
      data: report,
      frontendUrl: reportsFrontendUrl(config, { projectId, type: "cost" }),
    });
  });

  handlers.set("reports_waf", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const projectId = await resolveMcpReportProjectId(config, args, auth);
    const report = await auth.core.getWafReport({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      projectId,
      reportId: stringValue(args.reportId),
      severity: stringValue(args.severity),
      view: stringValue(args.view),
      userId: auth.user?.id,
    });
    return withEnvelope({
      command: "reports waf",
      data: report,
      frontendUrl: reportsFrontendUrl(config, { projectId, type: "waf" }),
    });
  });

  handlers.set("reports_rules", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const projectId = await resolveMcpReportProjectId(config, args, auth);
    const report = await auth.core.getWafReport({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      projectId,
      severity: stringValue(args.severity),
      view: "rules",
      userId: auth.user?.id,
    });
    return withEnvelope({
      command: "reports rules",
      data: rulesFromWafReport(report),
      frontendUrl: reportsFrontendUrl(config, { projectId, type: "waf" }),
    });
  });

  handlers.set("reports_run", async (args) => {
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

  handlers.set("reports_download", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    return downloadReports(config, args, auth);
  });

  handlers.set("billing_summary", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const range = rangeToDates("30d");
    const [entitlement, subscriptionStatus, usageSummary] = await Promise.all([
      auth.core.getBillingEntitlement({
        baseUrl: config.baseUrl,
        authToken: auth.token,
      }),
      auth.core.getSubscriptionStatus({
        baseUrl: config.baseUrl,
        authToken: auth.token,
      }),
      auth.core.getBillingUsageSummary({
        baseUrl: config.baseUrl,
        authToken: auth.token,
        startAt: range.startAt,
        endAt: range.endAt,
        granularity: "day",
      }).catch(() => null),
    ]);
    const frontendUrl = buildFrontendUrl({
      baseUrl: frontendBase(config),
      target: "billing",
      tab: "plans",
    });
    const usageCreditsUsed = auth.core.getBillingUsageCreditsUsed(usageSummary);
    return withEnvelope({
      command: "billing summary",
      data: {
        creditStatus: auth.core.getCreditStatus(entitlement, {
          reportedUsedCredits: usageCreditsUsed,
        }),
        entitlement,
        subscriptionStatus,
        usageCreditsUsed,
      },
      frontendUrl,
    });
  });

  handlers.set("billing_usage", async (args) => {
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

  handlers.set("billing_ledger", async (args) => {
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

  handlers.set("billing_plans", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    let token: string | undefined;
    try {
      const auth = await resolveAuth(config);
      token = auth.token;
    } catch {
      token = config.accessKey;
    }
    const core = await import("@cloudeval/core");
    const data = await core.getBillingConfig({
      baseUrl: config.baseUrl,
      authToken: token,
    });
    const frontendUrl = buildFrontendUrl({
      baseUrl: frontendBase(config),
      target: "billing",
      tab: "plans",
    });
    return withEnvelope({
      command: "billing plans",
      data,
      frontendUrl,
    });
  });

  handlers.set("billing_topups", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const data = await auth.core.getTopUpPacks({
      baseUrl: config.baseUrl,
      authToken: auth.token,
    });
    const frontendUrl = buildFrontendUrl({
      baseUrl: frontendBase(config),
      target: "billing",
      tab: "billing",
    });
    return withEnvelope({
      command: "billing topups",
      data,
      frontendUrl,
    });
  });

  handlers.set("billing_invoices", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const data = await auth.core.getSubscriptionBillingInfo({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      limit: boundedLimit(args.limit, 25, 50),
    });
    const frontendUrl = buildFrontendUrl({
      baseUrl: frontendBase(config),
      target: "billing",
      tab: "billing",
    });
    return withEnvelope({
      command: "billing invoices",
      data,
      frontendUrl,
    });
  });

  handlers.set("billing_notifications", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const data = await auth.core.getBillingNotifications({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      limit: boundedLimit(args.limit, 25, 100),
    });
    const frontendUrl = buildFrontendUrl({
      baseUrl: frontendBase(config),
      target: "billing",
      tab: "billing",
    });
    return withEnvelope({
      command: "billing notifications",
      data,
      frontendUrl,
    });
  });

  handlers.set("billing_topup_checkout", async (args) => {
    const packId = stringValue(args.packId);
    if (!packId) {
      throw new Error("packId is required.");
    }
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const returnTo =
      stringValue(args.returnTo) ??
      buildFrontendUrl({
        baseUrl: frontendBase(config),
        target: "billing",
        tab: "billing",
      });
    const session = await auth.core.createTopUpCheckoutSession({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      packId,
      preferredCurrency: stringValue(args.preferredCurrency),
      countryCode: stringValue(args.countryCode),
      contactEmail: stringValue(args.contactEmail),
      contactPhone: stringValue(args.contactPhone),
      contactCountryCode: stringValue(args.contactCountryCode),
      returnTo,
    });
    const checkoutUrl = String(
      (session as any)?.checkout_url ?? (session as any)?.launcher_url ?? "",
    );
    return withEnvelope({
      command: "billing topup",
      data: { packId, checkoutUrl: checkoutUrl || null, session },
      frontendUrl: checkoutUrl || returnTo,
    });
  });

  handlers.set("open_url", async (args) => {
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

  handlers.set("cloudeval_iac_detect", async (args) => {
    const data = await buildIacDetectData({
      workspace: stringValue(args.workspace) ?? ".",
    });
    return formatSuccessEnvelope({
      command: "iac detect",
      data,
      schemaVersion: IDE_SCHEMA_VERSION,
      freshness: { source: "local", observedAt: new Date().toISOString(), stale: false },
    });
  });

  handlers.set("cloudeval_iac_index", async (args) => {
    const data = await buildIacIndexData({
      file: stringValue(args.file),
      workspace: stringValue(args.workspace) ?? ".",
    });
    return formatSuccessEnvelope({
      command: "iac index",
      data,
      schemaVersion: IDE_SCHEMA_VERSION,
      freshness: { source: "local", observedAt: new Date().toISOString(), stale: false },
    });
  });

  handlers.set("cloudeval_review_local", async (args) => {
    const workspace = path.resolve(stringValue(args.workspace) ?? ".");
    const indexData = await buildIacIndexData({
      file: stringValue(args.file),
      workspace,
    });
    const run = await buildReviewLocalRun({
      command: "review local",
      workspace,
      indexes: indexData.indexes,
      validationData: { details: [] },
      warnings: indexData.indexes
        .filter((index) => index.supportLevel === "indexed_only")
        .map((index) => `${index.adapter} is indexed only; deep findings require scanner-backed evidence.`),
    });
    return formatSuccessEnvelope({
      command: "review local",
      data: run,
      traceId: run.id,
      schemaVersion: IDE_SCHEMA_VERSION,
      freshness: run.freshness,
      evidence: run.evidence,
    });
  });

  handlers.set("cloudeval_get_finding_evidence", async (args) => {
    const data = await buildFindingEvidence({
      workspace: path.resolve(stringValue(args.workspace) ?? "."),
      runId: stringValue(args.runId) ?? "",
      findingId: stringValue(args.findingId) ?? "",
    });
    return formatSuccessEnvelope({
      command: "findings evidence",
      data,
      traceId: stringValue(args.runId),
      schemaVersion: IDE_SCHEMA_VERSION,
      freshness: data.freshness,
      evidence: data.evidenceRefs,
    });
  });

  handlers.set("cloudeval_get_resource_context", async (args) => {
    const data = await buildIacIndexData({
      file: stringValue(args.file),
      workspace: stringValue(args.workspace) ?? ".",
    });
    return formatSuccessEnvelope({
      command: "iac index",
      data,
      schemaVersion: IDE_SCHEMA_VERSION,
      freshness: { source: "local", observedAt: new Date().toISOString(), stale: false },
    });
  });

  handlers.set("cloudeval_explain_blast_radius", async (args) => {
    const config = await resolveInvocationConfig(serverOptions, args);
    const auth = await resolveAuth(config, { requireUser: true });
    const projectId = stringValue(args.projectId) ?? config.defaultProjectId;
    const resourceId = stringValue(args.resourceId);
    if (!projectId || !resourceId) {
      throw new Error("projectId and resourceId are required.");
    }
    const graphData = await getProjectGraphInsights({
      baseUrl: config.baseUrl,
      authToken: auth.token,
      userId: auth.user!.id,
      projectId,
      resourceId,
      focus: "impact",
      limit: numberValue(args.limit),
    });
    const data = buildGraphNeighborhood({ projectId, resourceId, graphData });
    return formatSuccessEnvelope({
      command: "graph neighborhood",
      data,
      schemaVersion: IDE_SCHEMA_VERSION,
    });
  });

  handlers.set("cloudeval_draft_fix", async (args) => {
    const data = await buildDraftFix({
      workspace: path.resolve(stringValue(args.workspace) ?? "."),
      runId: stringValue(args.runId) ?? "",
      findingId: stringValue(args.findingId) ?? "",
    });
    return formatSuccessEnvelope({
      command: "findings draft-fix",
      data,
      traceId: stringValue(args.runId),
      schemaVersion: IDE_SCHEMA_VERSION,
      evidence: data.evidenceRefs,
    });
  });

  handlers.set("cloudeval_generate_ci_gate", async (args) => {
    const projectId = stringValue(args.projectId);
    if (!projectId) {
      throw new Error("projectId is required.");
    }
    const data = buildCiInitPlan({
      projectId,
      provider: stringValue(args.provider),
      write: false,
    });
    return formatSuccessEnvelope({
      command: "ci init",
      data,
      schemaVersion: IDE_SCHEMA_VERSION,
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
  toolset: McpToolsetName,
): Promise<JsonRecord> => {
  if (!mcpResourceDefinitions.some((resource) => resource.uri === uri)) {
    throw new Error(`Unknown resource: ${uri}`);
  }
  if (
    !hasRequiredTools(MCP_RESOURCE_TOOL_REQUIREMENTS[uri], availableToolNames)
  ) {
    throw new Error(`Resource ${uri} is not available in toolset ${toolset}.`);
  }
  if (uri === "cloudeval://capabilities") {
    const envelope = await handlers.get("capabilities_get")?.({});
    return { contents: [resourceText(uri, envelope?.data ?? {})] };
  }

  if (uri === "cloudeval://skills") {
    return {
      contents: [
        resourceText(
          uri,
          formatSuccessEnvelope({
            command: "skills list",
            data: await skillsResourceData(),
          }),
        ),
      ],
    };
  }

  if (uri === "cloudeval://workspace/detections") {
    const envelope = await handlers.get("cloudeval_iac_detect")?.({
      workspace: process.cwd(),
    });
    return { contents: [resourceText(uri, envelope ?? {})] };
  }

  if (uri === "cloudeval://runs/latest" || uri === "cloudeval://findings/latest") {
    const runsDir = path.join(process.cwd(), ".cloudeval", "ide-runs");
    try {
      const entries = await fs.readdir(runsDir, { withFileTypes: true });
      const files = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map(async (entry) => {
            const file = path.join(runsDir, entry.name);
            const stat = await fs.stat(file);
            return { file, mtimeMs: stat.mtimeMs };
          }),
      );
      const latest = files.sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
      if (!latest) {
        return {
          contents: [resourceText(uri, { ok: true, data: { run: null, findings: [] } })],
        };
      }
      const run = JSON.parse(await fs.readFile(latest.file, "utf8"));
      return {
        contents: [
          resourceText(
            uri,
            uri === "cloudeval://findings/latest"
              ? { ok: true, data: { runId: run.id, findings: run.findings ?? [] } }
              : { ok: true, data: run },
          ),
        ],
      };
    } catch {
      return {
        contents: [resourceText(uri, { ok: true, data: { run: null, findings: [] } })],
      };
    }
  }

  const toolName =
    uri === "cloudeval://projects"
      ? "projects_list"
      : uri === "cloudeval://billing/summary"
        ? "billing_summary"
        : uri === "cloudeval://recipes"
          ? "recipes_list"
          : "reports_list";
  const handler = handlers.get(toolName);
  if (!handler) {
    return {
      contents: [
        resourceText(
          uri,
          formatErrorEnvelope(
            toolName,
            new Error(`Tool ${toolName} is not available in this MCP toolset.`),
          ),
        ),
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
  fallback: string,
): string => stringValue(args[name]) ?? fallback;

const renderPromptText = (name: string, args: JsonRecord): string => {
  const recipe = getRecipe(name);
  if (recipe) {
    return renderRecipePrompt(recipe, {
      projectId: promptArgument(
        args,
        "projectId",
        "the default Cloudeval project",
      ),
      range: promptArgument(args, "range", "30d"),
      templateFile: stringValue(args.templateFile),
      templateUrl: stringValue(args.templateUrl),
      parametersFile: stringValue(args.parametersFile),
      parametersUrl: stringValue(args.parametersUrl),
      provider: stringValue(args.provider),
      name: stringValue(args.name),
      outputPath: stringValue(args.outputPath),
    });
  }
  if (name === "review_current_iac_file") {
    return `Use cloudeval_iac_index on ${promptArgument(args, "file", "the active IaC file")}, then use cloudeval_review_local. Explain support level honestly and cite evidence freshness.`;
  }
  if (name === "explain_finding_with_evidence") {
    return `Use cloudeval_get_finding_evidence with runId=${promptArgument(args, "runId", "<run-id>")} and findingId=${promptArgument(args, "findingId", "<finding-id>")}. Explain the finding, resource mapping, confidence, freshness, and next action.`;
  }
  if (name === "draft_safe_fix") {
    return `Use cloudeval_draft_fix with runId=${promptArgument(args, "runId", "<run-id>")} and findingId=${promptArgument(args, "findingId", "<finding-id>")}. Return only a reviewable proposal and do not mutate cloud state.`;
  }
  if (name === "generate_ci_gate") {
    return `Use cloudeval_generate_ci_gate with projectId=${promptArgument(args, "projectId", "<project-id>")}. Show generated files and ask for explicit confirmation before writing anything.`;
  }
  if (name === "explain_blast_radius") {
    return `Use cloudeval_explain_blast_radius with projectId=${promptArgument(args, "projectId", "<project-id>")} and resourceId=${promptArgument(args, "resourceId", "<resource-id>")}. Explain impact scope and evidence gaps.`;
  }
  throw new Error(`Unknown prompt: ${name}`);
};

const getMcpPrompt = (
  name: string,
  args: JsonRecord,
  availableToolNames: Set<string>,
  toolset: McpToolsetName,
): JsonRecord => {
  const definition = mcpPromptDefinitions.find(
    (prompt) => prompt.name === name,
  );
  const aliasedRecipe = definition ? undefined : getRecipe(name);
  const effectiveName = definition?.name ?? aliasedRecipe?.id;
  const effectiveDefinition: McpPromptDefinition | undefined =
    definition ??
    (aliasedRecipe
      ? {
          name: aliasedRecipe.id,
          title: aliasedRecipe.title,
          description: aliasedRecipe.description,
          arguments: aliasedRecipe.inputs.map((input) => ({
            name: input.name === "projectId" ? "projectId" : input.name,
            description: input.description,
            required: input.required,
          })),
        }
      : undefined);
  if (!effectiveDefinition || !effectiveName) {
    throw new Error(`Unknown prompt: ${name}`);
  }
  if (
    !hasRequiredTools(
      MCP_PROMPT_TOOL_REQUIREMENTS[effectiveName],
      availableToolNames,
    )
  ) {
    throw new Error(`Prompt ${name} is not available in toolset ${toolset}.`);
  }
  return {
    description: effectiveDefinition.description,
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

const MCP_CONTENT_LENGTH_SEPARATOR = "\r\n\r\n";
const MCP_LF_HEADER_SEPARATOR = "\n\n";
type McpStdioTransport = "newline" | "content-length";

const serializeJsonRpc = (
  message: JsonRpcResponse | JsonRpcNotification,
  transport: McpStdioTransport,
): string => {
  const body = JSON.stringify(message);
  if (transport === "content-length") {
    return `Content-Length: ${Buffer.byteLength(body, "utf8")}${MCP_CONTENT_LENGTH_SEPARATOR}${body}`;
  }
  return `${body}\n`;
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

const findContentLengthHeader = (
  buffer: Buffer,
): { end: number; separatorLength: number } | undefined => {
  const crlfEnd = buffer.indexOf(MCP_CONTENT_LENGTH_SEPARATOR);
  const lfEnd = buffer.indexOf(MCP_LF_HEADER_SEPARATOR);
  if (crlfEnd === -1 && lfEnd === -1) {
    return undefined;
  }
  if (crlfEnd !== -1 && (lfEnd === -1 || crlfEnd <= lfEnd)) {
    return {
      end: crlfEnd,
      separatorLength: MCP_CONTENT_LENGTH_SEPARATOR.length,
    };
  }
  return { end: lfEnd, separatorLength: MCP_LF_HEADER_SEPARATOR.length };
};

const startsWithContentLengthHeader = (buffer: Buffer): boolean =>
  /^Content-Length:/i.test(
    buffer.toString("ascii", 0, Math.min(buffer.length, 32)),
  );

const resolveMcpServeBaseUrl = async (
  options: { baseUrl?: string },
  command: Command,
  defaultBaseUrl: string,
): Promise<string> => {
  const configuredBaseUrl = options.baseUrl ?? defaultBaseUrl;
  const source =
    typeof command.getOptionValueSource === "function"
      ? command.getOptionValueSource("baseUrl")
      : undefined;

  if (source && source !== "default") {
    return configuredBaseUrl;
  }
  if (process.env.CLOUDEVAL_BASE_URL) {
    return configuredBaseUrl;
  }

  try {
    const profile = normalizeConfigProfile(command.optsWithGlobals?.().profile);
    const config = await loadCliConfig(profile);
    return config.baseUrl ?? configuredBaseUrl;
  } catch {
    return configuredBaseUrl;
  }
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
  let outputTransport: McpStdioTransport = "newline";
  const log = (message: string, data?: unknown) => {
    process.stderr.write(
      `[cloudeval-mcp] ${message}${data === undefined ? "" : ` ${JSON.stringify(data)}`}\n`,
    );
  };
  const debug = (message: string, data?: unknown) => {
    if (options.verbose) {
      log(message, data);
    }
  };
  log("Cloudeval MCP server started", {
    version: CLI_VERSION,
    protocolVersion: MCP_PROTOCOL_VERSION,
    transport: "stdio",
    wireFormat: "newline",
    toolset,
    profile: options.profile ?? "default",
    baseUrl: options.baseUrl,
    pid: process.pid,
  });
  const send = (message: JsonRpcResponse | JsonRpcNotification) => {
    process.stdout.write(serializeJsonRpc(message, outputTransport));
    debug("response sent", {
      id: "id" in message ? message.id : undefined,
      method: "method" in message ? message.method : undefined,
      transport: outputTransport,
    });
  };
  const progressTokenFromParams = (
    params: JsonRecord | undefined,
  ): JsonRpcId | undefined => {
    const meta = isObject(params?._meta) ? params?._meta : undefined;
    const token = meta?.progressToken;
    if (typeof token === "string") {
      return token;
    }
    if (typeof token === "number" && Number.isFinite(token)) {
      return token;
    }
    return undefined;
  };
  const sendTemplateProgress = (
    progressToken: JsonRpcId | undefined,
    event: TemplateProgressEvent,
    command: string,
  ) => {
    if (progressToken === undefined) {
      return;
    }
    const progress =
      typeof event.progress === "number"
        ? event.progress
        : typeof event.completed === "number"
          ? event.completed
          : event.phase === "result"
            ? 100
            : 0;
    const total =
      typeof event.progress === "number"
        ? 100
        : typeof event.total === "number"
          ? event.total
          : event.phase === "result"
            ? 100
            : undefined;
    send({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken,
        progress,
        ...(total === undefined ? {} : { total }),
        message: formatTemplateProgressEvent(event, command).join("\n"),
      },
    });
  };
  const handleRequest = async (
    request: JsonRpcRequest,
  ): Promise<JsonRpcResponse | undefined> => {
    debug("request received", {
      id: request.id,
      method: request.method,
      tool:
        request.method === "tools/call"
          ? stringValue(request.params?.name)
          : undefined,
    });
    try {
      if (request.method === "initialize") {
        const protocolVersion = protocolVersionFor(
          request.params?.protocolVersion,
        );
        initialized = true;
        log("initialize request accepted", {
          client: isObject(request.params?.clientInfo)
            ? request.params?.clientInfo
            : undefined,
          requestedProtocolVersion: request.params?.protocolVersion,
          negotiatedProtocolVersion: protocolVersion,
        });
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
            title: "Cloudeval CLI MCP Server",
            version: CLI_VERSION,
          },
          instructions:
            "Use Cloudeval tools for project-aware cloud evaluation, reports, billing usage, one-shot asks, and frontend deep links. Authentication comes from stored `cloudeval login` credentials or a scoped `CLOUDEVAL_ACCESS_KEY` / --access-key.",
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
        debug("listing tools", {
          toolset,
          count: availableTools.length,
        });
        return jsonRpcResult(request.id, {
          tools: availableTools,
        });
      }
      if (request.method === "tools/call") {
        const requestedName = stringValue(request.params?.name);
        const name = requestedName
          ? (MCP_TOOL_ALIASES[requestedName] ?? requestedName)
          : undefined;
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
            `Tool ${name} is not available in toolset ${toolset}.`,
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
        const progressToken = progressTokenFromParams(request.params);
        let lastProgressKey: string | undefined;
        const startedAt = Date.now();
        try {
          const envelope = await handler(args, {
            progressToken,
            sendProgress: (event, command) => {
              if (event.phase === "status") {
                const key = templateProgressEventKey(event);
                if (key === lastProgressKey) {
                  return;
                }
                lastProgressKey = key;
              }
              sendTemplateProgress(progressToken, event, command);
            },
          });
          debug("tool call completed", { tool: name, ok: envelope.ok });
          await options.telemetry?.track("cli.mcp.tool", {
            command: "mcp",
            subcommand: "serve",
            toolName: name,
            toolset,
            durationMs: Date.now() - startedAt,
            success: true,
          });
          return jsonRpcResult(
            request.id,
            toToolResult(envelope) as unknown as JsonRecord,
          );
        } catch (error) {
          log("tool call failed", {
            tool: name,
            message: error instanceof Error ? error.message : String(error),
          });
          await options.telemetry?.track("cli.mcp.tool", {
            command: "mcp",
            subcommand: "serve",
            toolName: name,
            toolset,
            durationMs: Date.now() - startedAt,
            success: false,
            errorCategory: classifyTelemetryError(error),
          });
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
  const processMessages = async () => {
    while (stdinBuffer.length) {
      while (
        stdinBuffer.length &&
        /\s/.test(stdinBuffer.toString("utf8", 0, 1))
      ) {
        stdinBuffer = stdinBuffer.subarray(1);
      }
      if (!stdinBuffer.length) {
        return;
      }
      if (startsWithContentLengthHeader(stdinBuffer)) {
        const headerBoundary = findContentLengthHeader(stdinBuffer);
        if (!headerBoundary) {
          return;
        }
        const header = stdinBuffer
          .subarray(0, headerBoundary.end)
          .toString("ascii");
        const contentLength = parseContentLength(header);
        stdinBuffer = stdinBuffer.subarray(
          headerBoundary.end + headerBoundary.separatorLength,
        );
        if (contentLength === undefined) {
          log("parse error", { message: "Missing MCP Content-Length header." });
          send(
            jsonRpcError(0, -32700, "Parse error", {
              message: "Missing MCP Content-Length header.",
            }),
          );
          continue;
        }
        if (stdinBuffer.length < contentLength) {
          stdinBuffer = Buffer.concat([
            Buffer.from(`${header}${MCP_CONTENT_LENGTH_SEPARATOR}`, "ascii"),
            stdinBuffer,
          ]);
          return;
        }
        outputTransport = "content-length";
        debug("using legacy Content-Length MCP stdio framing");
        const body = stdinBuffer.subarray(0, contentLength).toString("utf8");
        stdinBuffer = stdinBuffer.subarray(contentLength);
        try {
          await handleMessage(JSON.parse(body) as JsonValue);
        } catch (error: any) {
          log("parse error", { message: error?.message ?? String(error) });
          send(
            jsonRpcError(0, -32700, "Parse error", {
              message: error?.message ?? String(error),
            }),
          );
        }
        continue;
      }

      const lineEnd = stdinBuffer.indexOf("\n");
      if (lineEnd === -1) {
        return;
      }
      const body = stdinBuffer.subarray(0, lineEnd).toString("utf8").trim();
      stdinBuffer = stdinBuffer.subarray(lineEnd + 1);
      if (!body) {
        continue;
      }
      outputTransport = "newline";
      try {
        await handleMessage(JSON.parse(body) as JsonValue);
      } catch (error: any) {
        log("parse error", { message: error?.message ?? String(error) });
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
    await processMessages();
  }

  if (stdinBuffer.toString("utf8").trim()) {
    try {
      outputTransport = startsWithContentLengthHeader(stdinBuffer)
        ? "content-length"
        : "newline";
      await handleMessage(
        JSON.parse(stdinBuffer.toString("utf8")) as JsonValue,
      );
    } catch (error: any) {
      log("parse error", { message: error?.message ?? String(error) });
      send(
        jsonRpcError(0, -32700, "Parse error", {
          message: error?.message ?? String(error),
        }),
      );
    }
  }
  log("Cloudeval MCP server stopped");
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
    .description("Show Cloudeval MCP server capabilities")
    .option(
      "--format <format>",
      "Output format: text, json, ndjson, markdown",
      "text",
    )
    .option("--output <file>", "Output file")
    .action(
      async (options: { format?: MachineOutputFormat; output?: string }) => {
        await writeFormattedOutput({
          command: "mcp status",
          data: getMcpStatusData(),
          format: options.format,
          output: options.output,
        });
      },
    );

  mcp
    .command("setup")
    .description("Generate or install Cloudeval MCP client configuration")
    .argument("<client>", `MCP client: ${MCP_SETUP_CLIENTS.join(", ")}`)
    .option("--dry-run", "Print config without writing client files", false)
    .option(
      "--command <path>",
      "Cloudeval command path for the MCP client",
      "cloudeval",
    )
    .option(
      "--toolset <name>",
      `Toolset to expose: ${MCP_TOOLSET_NAMES.join(", ")}`,
      "readonly",
    )
    .option("--config-path <path>", "Override MCP client config path")
    .option(
      "--format <format>",
      "Output format: text, json, ndjson, markdown",
      "text",
    )
    .option("--output <file>", "Output file")
    .action(
      async (
        client: string,
        options: {
          dryRun?: boolean;
          command?: string;
          toolset?: string;
          configPath?: string;
          format?: MachineOutputFormat;
          output?: string;
        },
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
        const note =
          setup.client === "codex" && !writtenPath
            ? "Run the printed Codex command to register this MCP server."
            : setup.client === "generic" && !writtenPath
              ? "Copy the printed MCP server config into your MCP client."
              : undefined;
        const data = {
          ...setup,
          dryRun: Boolean(options.dryRun),
          writtenPath,
          note,
        };
        if (!options.format || options.format === "text") {
          const text = formatMcpClientSetupText(setup, {
            dryRun: Boolean(options.dryRun),
            writtenPath,
            note,
          });
          if (options.output) {
            await fs.writeFile(options.output, text, "utf8");
          } else {
            process.stdout.write(text);
          }
          return;
        }
        await writeFormattedOutput({
          command: "mcp setup",
          data,
          format: options.format,
          output: options.output,
        });
      },
    );

  mcp
    .command("serve")
    .description("Run Cloudeval as a stdio MCP server")
    .option("--base-url <url>", "Backend base URL", deps.defaultBaseUrl)
    .option("--frontend-url <url>", "Frontend base URL")
    .option(
      "--access-key <key>",
      "access key (prefer MCP client env or stored login)",
      process.env.CLOUDEVAL_ACCESS_KEY,
    )
    .option(
      "--toolset <name>",
      `Expose a focused MCP toolset: ${MCP_TOOLSET_NAMES.join(", ")}`,
      "readonly",
    )
    .option(
      "-v, --verbose",
      "Write detailed MCP server diagnostics to stderr",
      false,
    )
    .action(async (options, command) => {
      warnIfAccessKeyFromCliOption(options, command);
      const baseUrl = await resolveMcpServeBaseUrl(
        options,
        command,
        deps.defaultBaseUrl,
      );
      await serveMcpServer({
        baseUrl,
        frontendUrl: options.frontendUrl,
        profile: normalizeConfigProfile(command.optsWithGlobals?.().profile),
        accessKey: stringValue(options.accessKey),
        toolset: normalizeMcpToolset(options.toolset),
        verbose: Boolean(options.verbose),
        telemetry: deps.getTelemetry?.(),
      });
      await deps.finishTelemetry?.(0);
      process.exit(0);
    });
};

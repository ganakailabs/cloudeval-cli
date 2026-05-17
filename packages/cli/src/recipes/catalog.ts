export type RecipeId =
  | "cloudeval-cloud-cost-review"
  | "cloudeval-well-architected-framework-review"
  | "cloudeval-architecture-review"
  | "cloudeval-template-project-review"
  | "cloudeval-report-summary"
  | "cloudeval-report-generation-plan"
  | "cloudeval-report-export-pack"
  | "cloudeval-billing-review"
  | "cloudeval-credit-topup-readiness"
  | "cloudeval-project-inventory"
  | "cloudeval-project-healthcheck"
  | "cloudeval-connection-audit"
  | "cloudeval-agent-access-key-setup"
  | "cloudeval-credential-rotation"
  | "cloudeval-model-selection"
  | "cloudeval-session-recovery"
  | "cloudeval-cli-onboarding-check"
  | "cloudeval-frontend-workspace-links"
  | "cloudeval-diagram-export"
  | "cloudeval-graph-drift-watch"
  | "cloudeval-impact-analysis"
  | "cloudeval-template-preflight"
  | "cloudeval-template-release-gate"
  | "cloudeval-architecture-diagram-export"
  | "cloudeval-dependency-diagram-export"
  | "cloudeval-mcp-setup";

export type RecipeCategory =
  | "cost"
  | "waf"
  | "architecture"
  | "projects"
  | "reports"
  | "billing"
  | "connections"
  | "credentials"
  | "models"
  | "sessions"
  | "frontend"
  | "diagnostics"
  | "visualizations"
  | "validation"
  | "mcp";

export type RecipeMode = "ask" | "agent" | "guide";

export interface RecipeInput {
  name: string;
  description: string;
  required?: boolean;
}

export interface RecipeSafety {
  requiresAuth: boolean;
  consumesCredits: boolean;
  writesLocalFile: boolean;
  mayExposeSensitiveData: boolean;
  mutation: "none" | "explicit";
}

export interface Recipe {
  id: RecipeId;
  title: string;
  description: string;
  category: RecipeCategory;
  skill: string;
  mode: RecipeMode;
  inputs: RecipeInput[];
  commands: string[];
  mcpTools: string[];
  safety: RecipeSafety;
  expectedOutput: string[];
  failureHandling: string[];
}

export interface RecipePromptContext {
  projectId?: string;
  connectionId?: string;
  credentialId?: string;
  range?: string;
  templateFile?: string;
  templateUrl?: string;
  parametersFile?: string;
  parametersUrl?: string;
  provider?: string;
  name?: string;
  outputPath?: string;
  outputDir?: string;
  client?: string;
  model?: string;
  layout?: string;
  format?: string;
}

const authSensitiveNoMutation = {
  requiresAuth: true,
  consumesCredits: false,
  writesLocalFile: false,
  mayExposeSensitiveData: true,
  mutation: "none" as const,
};

const askSensitive = {
  requiresAuth: true,
  consumesCredits: true,
  writesLocalFile: false,
  mayExposeSensitiveData: true,
  mutation: "none" as const,
};

const explicitMutation = {
  requiresAuth: true,
  consumesCredits: false,
  writesLocalFile: false,
  mayExposeSensitiveData: true,
  mutation: "explicit" as const,
};

export const recipes: Recipe[] = [
  {
    id: "cloudeval-cloud-cost-review",
    title: "Cost Review",
    description:
      "Review latest CloudEval cost posture, usage, savings, and anomalies using existing cost reports and billing usage.",
    category: "cost",
    skill: "cloudeval-cost",
    mode: "ask",
    inputs: [
      { name: "projectId", description: "CloudEval project id.", required: true },
      { name: "range", description: "Billing usage range such as 7d, 30d, 90d, or all." },
    ],
    commands: [
      "cloudeval reports list --project <project-id> --kind cost",
      "cloudeval reports cost --project <project-id>",
      "cloudeval billing usage --range <range>",
      "cloudeval ask \"Run a CloudEval cost review\" --project <project-id>",
    ],
    mcpTools: ["reports_list", "reports_cost", "billing_usage", "ask"],
    safety: askSensitive,
    expectedOutput: [
      "Top cost drivers with evidence source",
      "Savings opportunities ranked by likely impact",
      "Anomalies and missing evidence separated from confirmed findings",
      "Concrete next actions",
    ],
    failureHandling: [
      "If reports are unavailable, ask before running report generation.",
      "If billing usage is unavailable, state the missing evidence and continue from reports.",
    ],
  },
  {
    id: "cloudeval-well-architected-framework-review",
    title: "Well-Architected Framework Review",
    description:
      "Triage Well-Architected Framework findings, rule failures, severity, and remediation order from existing reports.",
    category: "waf",
    skill: "cloudeval-waf",
    mode: "ask",
    inputs: [
      { name: "projectId", description: "CloudEval project id.", required: true },
      { name: "severity", description: "Optional severity focus." },
    ],
    commands: [
      "cloudeval reports list --project <project-id> --kind waf",
      "cloudeval reports waf --project <project-id>",
      "cloudeval reports rules --project <project-id>",
      "cloudeval ask \"Triage WAF findings\" --project <project-id>",
    ],
    mcpTools: ["reports_list", "reports_waf", "reports_rules", "ask"],
    safety: askSensitive,
    expectedOutput: [
      "Findings grouped by pillar",
      "Severity, likely blast radius, and confidence",
      "Ordered remediation plan",
      "Missing report or rule evidence called out separately",
    ],
    failureHandling: [
      "If no WAF report exists, recommend `cloudeval reports run --type waf` without running it automatically.",
    ],
  },
  {
    id: "cloudeval-architecture-review",
    title: "Architecture Review",
    description:
      "Review CloudEval project architecture across reliability, security, operations, performance, and cost using project data and reports.",
    category: "architecture",
    skill: "cloudeval-reports",
    mode: "ask",
    inputs: [{ name: "projectId", description: "CloudEval project id.", required: true }],
    commands: [
      "cloudeval projects get <project-id>",
      "cloudeval reports list --project <project-id>",
      "cloudeval open project <project-id> --view both --layout architecture --print-url --no-open",
      "cloudeval ask \"Review architecture risks\" --project <project-id>",
    ],
    mcpTools: ["projects_get", "reports_list", "open_url", "ask"],
    safety: askSensitive,
    expectedOutput: [
      "Architecture risks by domain",
      "Best-practice gaps backed by CloudEval evidence",
      "Frontend workspace link",
      "Prioritized recommendations",
    ],
    failureHandling: [
      "If project details are unavailable, ask for a project id or run `cloudeval projects list`.",
    ],
  },
  {
    id: "cloudeval-template-project-review",
    title: "Template Project Review",
    description:
      "Create or inspect a CloudEval template project using existing local JSON or URL template support.",
    category: "projects",
    skill: "cloudeval-projects",
    mode: "guide",
    inputs: [
      { name: "templateFile", description: "Local JSON template path." },
      { name: "templateUrl", description: "Template URL." },
      { name: "parametersFile", description: "Local parameters file." },
      { name: "parametersUrl", description: "Parameters URL." },
      { name: "provider", description: "Provider accepted by CloudEval project creation." },
      { name: "name", description: "Project name." },
    ],
    commands: [
      "cloudeval projects create --template-file <path> --name <name>",
      "cloudeval projects create --template-url <url> --name <name>",
      "cloudeval reports run --project <project-id> --type all",
      "cloudeval agent \"Review this CloudEval template project\" --project <project-id>",
    ],
    mcpTools: ["projects_list", "reports_run", "ask"],
    safety: explicitMutation,
    expectedOutput: [
      "Exact project creation command",
      "Follow-up report commands",
      "Review prompt for the created project",
    ],
    failureHandling: [
      "Require a template file or URL before project creation.",
      "Do not create a project unless the user explicitly runs the shown command.",
    ],
  },
  {
    id: "cloudeval-report-summary",
    title: "Report Summary",
    description:
      "Summarize latest CloudEval reports into a concise Markdown-ready review without copying raw report payloads.",
    category: "reports",
    skill: "cloudeval-reports",
    mode: "ask",
    inputs: [{ name: "projectId", description: "CloudEval project id.", required: true }],
    commands: [
      "cloudeval reports list --project <project-id>",
      "cloudeval reports download --project <project-id> --type all --view formatted",
      "cloudeval ask \"Summarize CloudEval reports\" --project <project-id>",
    ],
    mcpTools: ["reports_list", "reports_download", "ask"],
    safety: askSensitive,
    expectedOutput: [
      "Executive summary",
      "Cost and WAF highlights",
      "Action list",
      "Frontend report link",
    ],
    failureHandling: [
      "If no report exists, recommend report generation but do not run it automatically.",
    ],
  },
  {
    id: "cloudeval-report-generation-plan",
    title: "Report Generation Plan",
    description:
      "Plan an explicit CloudEval report run for cost, WAF, architecture, unit-test, or all supported report types.",
    category: "reports",
    skill: "cloudeval-reports",
    mode: "guide",
    inputs: [{ name: "projectId", description: "CloudEval project id.", required: true }],
    commands: [
      "cloudeval reports list --project <project-id>",
      "cloudeval reports run --project <project-id> --type all --wait",
      "cloudeval open reports --project <project-id> --tab overview --print-url --no-open",
    ],
    mcpTools: ["reports_list", "reports_run", "open_url"],
    safety: {
      requiresAuth: true,
      consumesCredits: true,
      writesLocalFile: false,
      mayExposeSensitiveData: true,
      mutation: "explicit",
    },
    expectedOutput: [
      "Report types to run",
      "Exact run command",
      "Wait and polling recommendation",
      "Frontend report link",
    ],
    failureHandling: [
      "Do not submit report jobs until the user explicitly confirms the command.",
    ],
  },
  {
    id: "cloudeval-report-export-pack",
    title: "Report Export Pack",
    description:
      "Export existing CloudEval cost and WAF report payloads to local JSON or Markdown files for offline review.",
    category: "reports",
    skill: "cloudeval-reports",
    mode: "guide",
    inputs: [
      { name: "projectId", description: "CloudEval project id.", required: true },
      { name: "outputPath", description: "Local output file or directory.", required: true },
    ],
    commands: [
      "cloudeval reports download --project <project-id> --type all --view formatted --output <dir>",
      "cloudeval reports download --project <project-id> --type cost --view parsed --output <file>",
      "cloudeval reports download --project <project-id> --type waf --view parsed --output <file>",
    ],
    mcpTools: ["reports_list", "reports_download"],
    safety: {
      requiresAuth: true,
      consumesCredits: false,
      writesLocalFile: true,
      mayExposeSensitiveData: true,
      mutation: "explicit",
    },
    expectedOutput: [
      "Files to be written",
      "Report type and view",
      "Redaction reminder for shared artifacts",
    ],
    failureHandling: [
      "Require an explicit output path before writing local report files.",
      "Prefer formatted or parsed views for sharing; avoid raw payloads unless requested.",
    ],
  },
  {
    id: "cloudeval-billing-review",
    title: "Billing Review",
    description:
      "Review CloudEval credits, plans, usage, ledger patterns, invoices, notifications, and top-up options.",
    category: "billing",
    skill: "cloudeval-billing",
    mode: "ask",
    inputs: [{ name: "range", description: "Billing usage range such as 7d, 30d, 90d, or all." }],
    commands: [
      "cloudeval billing summary",
      "cloudeval billing usage --range <range>",
      "cloudeval billing ledger --range <range>",
      "cloudeval billing invoices --limit 10",
      "cloudeval billing notifications --limit 10",
      "cloudeval billing topups",
      "cloudeval ask \"Review CloudEval billing usage\"",
    ],
    mcpTools: [
      "billing_summary",
      "billing_usage",
      "billing_ledger",
      "billing_invoices",
      "billing_notifications",
      "billing_topups",
      "ask",
    ],
    safety: askSensitive,
    expectedOutput: [
      "Credit status",
      "Usage trend",
      "Ledger anomalies summarized without raw identifiers",
      "Recommended billing action",
    ],
    failureHandling: [
      "Never paste full billing ledger payloads; summarize and redact identifiers.",
    ],
  },
  {
    id: "cloudeval-credit-topup-readiness",
    title: "Billing Top-up Readiness",
    description:
      "Check whether a user should buy more credits and prepare an explicit checkout command from existing top-up packs.",
    category: "billing",
    skill: "cloudeval-billing",
    mode: "guide",
    inputs: [{ name: "range", description: "Usage range to inspect before choosing a pack." }],
    commands: [
      "cloudeval billing summary",
      "cloudeval billing usage --range <range>",
      "cloudeval billing topups",
      "cloudeval billing topups buy <pack-id> --print-url --no-open",
    ],
    mcpTools: ["billing_summary", "billing_usage", "billing_topups", "billing_topup_checkout"],
    safety: {
      requiresAuth: true,
      consumesCredits: false,
      writesLocalFile: false,
      mayExposeSensitiveData: true,
      mutation: "explicit",
    },
    expectedOutput: [
      "Current credit position",
      "Suitable top-up pack candidates",
      "Explicit checkout command",
    ],
    failureHandling: [
      "Do not create checkout sessions unless the user explicitly selects a pack.",
    ],
  },
  {
    id: "cloudeval-project-inventory",
    title: "Project Inventory",
    description:
      "Inventory CloudEval projects, providers, sources, status, and direct workspace links.",
    category: "projects",
    skill: "cloudeval-projects",
    mode: "guide",
    inputs: [],
    commands: [
      "cloudeval projects list",
      "cloudeval connections list",
      "cloudeval open projects --print-url --no-open",
    ],
    mcpTools: ["projects_list", "connections_list", "open_url"],
    safety: authSensitiveNoMutation,
    expectedOutput: [
      "Project count and status spread",
      "Provider/source inventory",
      "Frontend projects link",
    ],
    failureHandling: [
      "If authentication is missing, run `cloudeval login` before listing private projects.",
    ],
  },
  {
    id: "cloudeval-project-healthcheck",
    title: "Project Healthcheck",
    description:
      "Check one CloudEval project's sync/report state, links, and next diagnostic commands.",
    category: "projects",
    skill: "cloudeval-projects",
    mode: "guide",
    inputs: [{ name: "projectId", description: "CloudEval project id.", required: true }],
    commands: [
      "cloudeval projects get <project-id>",
      "cloudeval reports list --project <project-id>",
      "cloudeval open project <project-id> --view both --layout architecture --print-url --no-open",
      "cloudeval open reports --project <project-id> --tab overview --print-url --no-open",
    ],
    mcpTools: ["projects_get", "reports_list", "open_url"],
    safety: authSensitiveNoMutation,
    expectedOutput: [
      "Project identity and provider",
      "Sync/report status",
      "Useful frontend links",
      "Missing next step if reports or sync data are absent",
    ],
    failureHandling: [
      "If the project id is missing, run `cloudeval projects list` first.",
    ],
  },
  {
    id: "cloudeval-connection-audit",
    title: "Connection Audit",
    description:
      "Review CloudEval connections and identify stale, missing, or mismatched project connection context.",
    category: "connections",
    skill: "cloudeval-connections",
    mode: "guide",
    inputs: [{ name: "connectionId", description: "Optional CloudEval connection id." }],
    commands: [
      "cloudeval connections list",
      "cloudeval connections get <connection-id>",
      "cloudeval open connections --print-url --no-open",
      "cloudeval open connection <connection-id> --print-url --no-open",
    ],
    mcpTools: ["connections_list", "connections_get", "open_url"],
    safety: authSensitiveNoMutation,
    expectedOutput: [
      "Connection list or selected connection",
      "Provider/source summary",
      "Frontend connection link",
      "Any missing project association to investigate",
    ],
    failureHandling: [
      "Do not display embedded credentials or raw provider payloads.",
    ],
  },
  {
    id: "cloudeval-agent-access-key-setup",
    title: "Agent Access Key Setup",
    description:
      "Prepare a scoped CloudEval access key workflow for automation clients using existing credential templates.",
    category: "credentials",
    skill: "cloudeval-credentials",
    mode: "guide",
    inputs: [
      { name: "projectId", description: "Project scope for the access key.", required: true },
      { name: "name", description: "Credential name." },
    ],
    commands: [
      "cloudeval credentials templates",
      "cloudeval credentials create --template ci --name <name> --project <project-id> --expires 90d",
      "cloudeval credentials list --project <project-id>",
    ],
    mcpTools: ["credentials_templates", "credentials_list", "credentials_create"],
    safety: explicitMutation,
    expectedOutput: [
      "Template choice",
      "Exact create command",
      "Secret-handling warning",
    ],
    failureHandling: [
      "Access keys are one-time secrets; never paste them into docs, logs, or shared chat.",
      "Do not create a credential until the user confirms the project and template.",
    ],
  },
  {
    id: "cloudeval-credential-rotation",
    title: "Credential Rotation",
    description:
      "Inspect and rotate CloudEval access-key credentials with explicit create and revoke steps.",
    category: "credentials",
    skill: "cloudeval-credentials",
    mode: "guide",
    inputs: [
      { name: "projectId", description: "Optional project scope." },
      { name: "credentialId", description: "Credential id to inspect or revoke." },
    ],
    commands: [
      "cloudeval credentials list --project <project-id>",
      "cloudeval credentials inspect <credential-id>",
      "cloudeval credentials create --template ci --name <new-name> --project <project-id> --expires 90d",
      "cloudeval credentials revoke <credential-id> --reason rotated",
    ],
    mcpTools: [
      "credentials_list",
      "credentials_inspect",
      "credentials_create",
      "credentials_revoke",
    ],
    safety: explicitMutation,
    expectedOutput: [
      "Credential inventory",
      "Rotation order",
      "Create command before revoke command",
      "Rollback reminder",
    ],
    failureHandling: [
      "Never revoke a credential until replacement access has been verified.",
      "Redact credential ids unless full ids are explicitly requested.",
    ],
  },
  {
    id: "cloudeval-model-selection",
    title: "Model Selection",
    description:
      "List CloudEval-supported models and set or explain the default model for a CLI profile.",
    category: "models",
    skill: "cloudeval-agent-ops",
    mode: "guide",
    inputs: [{ name: "model", description: "Optional model id to set." }],
    commands: [
      "cloudeval models list",
      "cloudeval models default get",
      "cloudeval models default set <model>",
      "cloudeval ask \"Test selected model with a short answer\" --model <model>",
    ],
    mcpTools: ["models_list", "models_default_get", "models_default_set", "ask"],
    safety: {
      requiresAuth: true,
      consumesCredits: true,
      writesLocalFile: false,
      mayExposeSensitiveData: false,
      mutation: "explicit",
    },
    expectedOutput: [
      "Available models",
      "Current default model",
      "Set command for profile default",
      "Optional smoke question",
    ],
    failureHandling: [
      "If a selected model is unavailable, list available backend models before retrying.",
    ],
  },
  {
    id: "cloudeval-session-recovery",
    title: "Session Recovery",
    description:
      "Find, inspect, resume, export, or clean local CloudEval CLI session history stored by the CLI.",
    category: "sessions",
    skill: "cloudeval-agent-ops",
    mode: "guide",
    inputs: [{ name: "name", description: "Search query or session title." }],
    commands: [
      "cloudeval sessions list",
      "cloudeval sessions search <query>",
      "cloudeval sessions get <thread-id>",
      "cloudeval chat --resume <thread-id>",
      "cloudeval sessions export --output <file>",
    ],
    mcpTools: ["sessions_list", "sessions_search", "sessions_get", "sessions_export"],
    safety: {
      requiresAuth: false,
      consumesCredits: false,
      writesLocalFile: true,
      mayExposeSensitiveData: true,
      mutation: "explicit",
    },
    expectedOutput: [
      "Matching session ids or titles",
      "Resume command",
      "Export path if requested",
    ],
    failureHandling: [
      "Do not quote full private transcripts unless the user asks for that exact local data.",
    ],
  },
  {
    id: "cloudeval-cli-onboarding-check",
    title: "CLI Onboarding Check",
    description:
      "Verify local CloudEval CLI auth, config, model defaults, MCP status, and shell setup.",
    category: "diagnostics",
    skill: "cloudeval-mcp-diagnostics",
    mode: "guide",
    inputs: [],
    commands: [
      "cloudeval status",
      "cloudeval doctor --mcp",
      "cloudeval config show",
      "cloudeval models list",
      "cloudeval mcp status",
      "cloudeval help agents",
    ],
    mcpTools: [
      "status",
      "doctor",
      "config_show",
      "models_list",
      "auth_status",
      "capabilities_get",
    ],
    safety: {
      requiresAuth: false,
      consumesCredits: false,
      writesLocalFile: false,
      mayExposeSensitiveData: true,
      mutation: "none",
    },
    expectedOutput: [
      "Auth and config status",
      "MCP readiness",
      "Model visibility",
      "Next setup command if anything is missing",
    ],
    failureHandling: [
      "Redact account and session identifiers by default.",
    ],
  },
  {
    id: "cloudeval-frontend-workspace-links",
    title: "Frontend Workspace Links",
    description:
      "Build CloudEval frontend links for overview, projects, reports, billing, chat, and connection workspaces.",
    category: "frontend",
    skill: "cloudeval-projects",
    mode: "guide",
    inputs: [{ name: "projectId", description: "Optional project id for project/report links." }],
    commands: [
      "cloudeval open overview --print-url --no-open",
      "cloudeval open projects --print-url --no-open",
      "cloudeval open project <project-id> --view both --layout dependency --print-url --no-open",
      "cloudeval open reports --project <project-id> --tab overview --print-url --no-open",
      "cloudeval open billing --tab usage --print-url --no-open",
    ],
    mcpTools: ["open_url"],
    safety: {
      requiresAuth: false,
      consumesCredits: false,
      writesLocalFile: false,
      mayExposeSensitiveData: true,
      mutation: "explicit",
    },
    expectedOutput: [
      "One or more frontend URLs",
      "Browser-open command only when explicitly requested",
    ],
    failureHandling: [
      "Prefer `--print-url --no-open` for automation and agent contexts.",
    ],
  },
  {
    id: "cloudeval-diagram-export",
    title: "Diagram Export",
    description:
      "Export CloudEval architecture or dependency diagrams using the existing project diagram command.",
    category: "visualizations",
    skill: "cloudeval-visualizations",
    mode: "guide",
    inputs: [
      { name: "projectId", description: "CloudEval project id.", required: true },
      { name: "outputPath", description: "Local output path for PNG, JPEG, or SVG.", required: true },
    ],
    commands: [
      "cloudeval projects export-diagram <project-id> --layout architecture --format png --labels all --output <file>",
      "cloudeval projects export-diagram <project-id> --layout dependency --format svg --labels all --output <file>",
    ],
    mcpTools: ["projects_export_diagram"],
    safety: {
      requiresAuth: true,
      consumesCredits: false,
      writesLocalFile: true,
      mayExposeSensitiveData: true,
      mutation: "explicit",
    },
    expectedOutput: [
      "Diagram export command",
      "Output file path",
      "Frontend project link",
    ],
    failureHandling: [
      "Require an explicit output path before writing files.",
    ],
  },
  {
    id: "cloudeval-graph-drift-watch",
    title: "Graph Drift Watch",
    description:
      "Review recent graph sync runs and compare retained topology snapshots for material changes.",
    category: "projects",
    skill: "cloudeval-graph-intelligence",
    mode: "guide",
    inputs: [{ name: "projectId", description: "CloudEval project id.", required: true }],
    commands: [
      "cloudeval projects graph sync-runs <project-id> --format json",
      "cloudeval projects graph timeline <project-id> --format json",
      "cloudeval projects graph diff <project-id> --from <sync-version> --to <sync-version> --format json",
    ],
    mcpTools: [
      "projects_graph_sync_runs",
      "projects_graph_timeline",
      "projects_graph_diff",
    ],
    safety: {
      requiresAuth: true,
      consumesCredits: false,
      writesLocalFile: false,
      mayExposeSensitiveData: true,
      mutation: "none",
    },
    expectedOutput: [
      "Recent sync runs",
      "Changed resource summary",
      "Snapshot versions to investigate",
    ],
    failureHandling: [
      "If no retained baseline exists, run a fresh project sync before expecting a diff.",
    ],
  },
  {
    id: "cloudeval-impact-analysis",
    title: "Impact Analysis",
    description:
      "Inspect graph intelligence for resource impact, critical paths, security, and cost lenses.",
    category: "projects",
    skill: "cloudeval-graph-intelligence",
    mode: "guide",
    inputs: [
      { name: "projectId", description: "CloudEval project id.", required: true },
      { name: "resourceId", description: "Resource id for impact-focused analysis." },
    ],
    commands: [
      "cloudeval projects graph insights <project-id> --focus overview --format json",
      "cloudeval projects graph insights <project-id> --focus impact --resource <resource-id> --format json",
      "cloudeval projects graph insights <project-id> --focus critical-paths --format json",
    ],
    mcpTools: ["projects_graph_insights", "projects_graph_get"],
    safety: {
      requiresAuth: true,
      consumesCredits: false,
      writesLocalFile: false,
      mayExposeSensitiveData: true,
      mutation: "none",
    },
    expectedOutput: [
      "Graph insight summaries",
      "Resource impact evidence",
      "Critical path and risk signals",
    ],
    failureHandling: [
      "Use `projects graph <project-id> --format json` to inspect resource ids before running impact analysis.",
    ],
  },
  {
    id: "cloudeval-template-preflight",
    title: "Template Preflight",
    description:
      "Validate and parse a cloud template before creating a project or promoting changes.",
    category: "validation",
    skill: "cloudeval-template-validation",
    mode: "guide",
    inputs: [
      { name: "templateFile", description: "Local template JSON file.", required: true },
      { name: "parametersFile", description: "Optional local parameters JSON file." },
    ],
    commands: [
      "cloudeval validate parse --template-file <template.json> --parameters-file <parameters.json> --format json",
      "cloudeval validate template --template-file <template.json> --parameters-file <parameters.json> --details --format json",
      "cloudeval validate tests --template-file <template.json> --parameters-file <parameters.json> --wait --format json",
      "cloudeval rules search \"public network\" --format json",
    ],
    mcpTools: ["template_parse", "template_validate", "template_test", "rules_search"],
    safety: {
      requiresAuth: true,
      consumesCredits: true,
      writesLocalFile: false,
      mayExposeSensitiveData: true,
      mutation: "none",
    },
    expectedOutput: [
      "Parsed resource inventory",
      "Validation summary and per-check details",
      "Template test-suite results with recommendations",
    ],
    failureHandling: [
      "`--parameters-file` is accepted by parse and validate but remains optional.",
      "Keep template and parameters files local unless the user explicitly asks to share them.",
    ],
  },
  {
    id: "cloudeval-template-release-gate",
    title: "Template Release Gate",
    description:
      "Use generic validation checks as an automation gate for cloud template changes.",
    category: "validation",
    skill: "cloudeval-template-validation",
    mode: "guide",
    inputs: [
      { name: "templateFile", description: "Local template JSON file.", required: true },
      { name: "parametersFile", description: "Optional local parameters JSON file." },
    ],
    commands: [
      "cloudeval validate template --template-file <template.json> --parameters-file <parameters.json> --min-severity Warning --failed-only --format json",
      "cloudeval validate tests --template-file <template.json> --parameters-file <parameters.json> --wait --format json",
      "cloudeval rules categories --format json",
      "cloudeval rules show <rule-id> --format json",
    ],
    mcpTools: ["template_validate", "template_test", "rules_categories", "rules_get"],
    safety: {
      requiresAuth: true,
      consumesCredits: true,
      writesLocalFile: false,
      mayExposeSensitiveData: true,
      mutation: "none",
    },
    expectedOutput: [
      "Gate pass/fail evidence",
      "Failed check count",
      "Rule details for remediation context",
    ],
    failureHandling: [
      "Fail the gate on high-severity or policy-selected failed checks, not on parser warnings alone.",
    ],
  },
  {
    id: "cloudeval-architecture-diagram-export",
    title: "Architecture Diagram Export",
    description:
      "Export a CloudEval architecture-view diagram image for presentations, reviews, or offline inspection.",
    category: "visualizations",
    skill: "cloudeval-visualizations",
    mode: "guide",
    inputs: [
      { name: "projectId", description: "CloudEval project id.", required: true },
      { name: "outputPath", description: "Local PNG, JPEG, or SVG output path.", required: true },
    ],
    commands: [
      "cloudeval projects export-diagram <project-id> --layout architecture --format png --labels all --output <file>",
      "cloudeval open project <project-id> --view both --layout architecture --print-url --no-open",
    ],
    mcpTools: ["projects_export_diagram", "open_url"],
    safety: {
      requiresAuth: true,
      consumesCredits: false,
      writesLocalFile: true,
      mayExposeSensitiveData: true,
      mutation: "explicit",
    },
    expectedOutput: [
      "Architecture diagram file path",
      "Image format and label mode",
      "Architecture workspace link",
    ],
    failureHandling: [
      "Use `--public` only for intentionally public/share graphs.",
      "Do not embed exported diagrams in public docs until labels and resources are reviewed.",
    ],
  },
  {
    id: "cloudeval-dependency-diagram-export",
    title: "Dependency Diagram Export",
    description:
      "Export a CloudEval dependency-view diagram image for relationship and blast-radius analysis.",
    category: "visualizations",
    skill: "cloudeval-visualizations",
    mode: "guide",
    inputs: [
      { name: "projectId", description: "CloudEval project id.", required: true },
      { name: "outputPath", description: "Local PNG, JPEG, or SVG output path.", required: true },
    ],
    commands: [
      "cloudeval projects export-diagram <project-id> --layout dependency --format svg --labels all --output <file>",
      "cloudeval open project <project-id> --view both --layout dependency --print-url --no-open",
    ],
    mcpTools: ["projects_export_diagram", "open_url"],
    safety: {
      requiresAuth: true,
      consumesCredits: false,
      writesLocalFile: true,
      mayExposeSensitiveData: true,
      mutation: "explicit",
    },
    expectedOutput: [
      "Dependency diagram file path",
      "Image format and label mode",
      "Dependency workspace link",
    ],
    failureHandling: [
      "Require an explicit output path before writing files.",
      "Review node labels before sharing externally.",
    ],
  },
  {
    id: "cloudeval-mcp-setup",
    title: "MCP Setup",
    description:
      "Configure CloudEval MCP for Codex, Cursor, Claude, VS Code, or a generic stdio client.",
    category: "mcp",
    skill: "cloudeval-mcp-diagnostics",
    mode: "guide",
    inputs: [{ name: "client", description: "codex, cursor, claude, vscode, generic, detected, or all." }],
    commands: [
      "cloudeval mcp status --format json",
      "cloudeval mcp setup codex --dry-run --toolset readonly --format json",
      "cloudeval mcp setup cursor --dry-run --toolset reports --format json",
      "cloudeval mcp setup claude --dry-run --toolset readonly --format json",
      "cloudeval mcp serve --toolset readonly",
    ],
    mcpTools: ["capabilities_get", "recipes_list", "status", "doctor"],
    safety: {
      requiresAuth: false,
      consumesCredits: false,
      writesLocalFile: false,
      mayExposeSensitiveData: false,
      mutation: "explicit",
    },
    expectedOutput: [
      "MCP config or command",
      "Selected toolset",
      "Setup instructions",
      "Validation command",
    ],
    failureHandling: [
      "Use --dry-run before writing client config files.",
      "If auth is missing, run `cloudeval login` before serving private MCP tools.",
    ],
  },
];

export const recipeIds = recipes.map((recipe) => recipe.id);

const recipeById = new Map(recipes.map((recipe) => [recipe.id, recipe]));

export const recipeAliases: Record<string, RecipeId> = {
  "cost-review": "cloudeval-cloud-cost-review",
  "waf-triage": "cloudeval-well-architected-framework-review",
  "well-architected-framework-review": "cloudeval-well-architected-framework-review",
  "cloudeval-well-architect-framework-review": "cloudeval-well-architected-framework-review",
  "architecture-review": "cloudeval-architecture-review",
  "template-project-review": "cloudeval-template-project-review",
  "report-summary": "cloudeval-report-summary",
  "report-generation-plan": "cloudeval-report-generation-plan",
  "report-export-pack": "cloudeval-report-export-pack",
  "billing-review": "cloudeval-billing-review",
  "billing-topup-readiness": "cloudeval-credit-topup-readiness",
  "project-inventory": "cloudeval-project-inventory",
  "project-healthcheck": "cloudeval-project-healthcheck",
  "connection-audit": "cloudeval-connection-audit",
  "credentials-agent-key-setup": "cloudeval-agent-access-key-setup",
  "credentials-rotation": "cloudeval-credential-rotation",
  "model-selection": "cloudeval-model-selection",
  "session-recovery": "cloudeval-session-recovery",
  "cli-onboarding-check": "cloudeval-cli-onboarding-check",
  "frontend-workspace-links": "cloudeval-frontend-workspace-links",
  "diagram-export": "cloudeval-diagram-export",
  "architecture-diagram-export": "cloudeval-architecture-diagram-export",
  "dependency-diagram-export": "cloudeval-dependency-diagram-export",
  "mcp-setup": "cloudeval-mcp-setup",
};

export const getRecipe = (id: string): Recipe | undefined => {
  const key = id.trim().toLowerCase();
  const alias = recipeAliases[key];
  return recipeById.get(key as RecipeId) ?? (alias ? recipeById.get(alias) : undefined);
};

export const recipeSummary = (recipe: Recipe) => ({
  id: recipe.id,
  title: recipe.title,
  description: recipe.description,
  category: recipe.category,
  skill: recipe.skill,
  mode: recipe.mode,
  safety: recipe.safety,
});

const contextValue = (
  context: RecipePromptContext,
  key: keyof RecipePromptContext,
  fallback: string,
): string => {
  const value = context[key];
  return typeof value === "string" && value.trim() ? value : fallback;
};

export const renderRecipeCommands = (
  recipe: Recipe,
  context: RecipePromptContext = {},
): string[] => {
  const replacements: Record<string, string> = {
    "<project-id>": contextValue(context, "projectId", "<project-id>"),
    "<connection-id>": contextValue(context, "connectionId", "<connection-id>"),
    "<credential-id>": contextValue(context, "credentialId", "<credential-id>"),
    "<range>": contextValue(context, "range", "<range>"),
    "<path>": contextValue(context, "templateFile", "<path>"),
    "<url>": contextValue(context, "templateUrl", "<url>"),
    "<file>": contextValue(context, "outputPath", "<file>"),
    "<dir>": contextValue(context, "outputDir", contextValue(context, "outputPath", "<dir>")),
    "<name>": contextValue(context, "name", "<name>"),
    "<new-name>": contextValue(context, "name", "<new-name>"),
    "<model>": contextValue(context, "model", "<model>"),
    "<client>": contextValue(context, "client", "<client>"),
  };
  return recipe.commands.map((command) => {
    let rendered = command;
    for (const [placeholder, value] of Object.entries(replacements)) {
      rendered = rendered.replaceAll(placeholder, value);
    }
    return rendered;
  });
};

const explicitCommandPrompt = (
  recipe: Recipe,
  context: RecipePromptContext,
  extra: string[] = [],
): string => [
  `${recipe.title}: ${recipe.description}`,
  "Use only existing CloudEval CLI and MCP capabilities listed in the recipe.",
  "Do not perform explicit mutations unless the user runs or confirms the shown command.",
  ...extra,
  "",
  "Commands:",
  ...renderRecipeCommands(recipe, context).map((command) => `- ${command}`),
  context.outputPath ? `Output path requested: ${context.outputPath}` : "",
].filter(Boolean).join("\n");

export const renderRecipePrompt = (
  recipe: Recipe,
  context: RecipePromptContext = {},
): string => {
  const projectId = contextValue(context, "projectId", "the default CloudEval project");
  const range = contextValue(context, "range", "30d");
  const outputPath = contextValue(context, "outputPath", "<file>");
  if (recipe.id === "cloudeval-cloud-cost-review") {
    return [
      `Run a CloudEval cost review for ${projectId} over ${range}.`,
      "Use CloudEval reports, cost report details, billing usage, and project context where available.",
      "Return top cost drivers, savings opportunities, anomalies, and concrete next actions.",
      "Separate confirmed evidence from assumptions or missing data.",
    ].join("\n");
  }
  if (recipe.id === "cloudeval-well-architected-framework-review") {
    return [
      `Triage Well-Architected findings for ${projectId}.`,
      "Use CloudEval WAF reports and rules where available.",
      "Group issues by pillar and severity, identify likely blast radius, and propose an ordered remediation plan.",
      "Do not regenerate reports unless the user explicitly asks.",
    ].join("\n");
  }
  if (recipe.id === "cloudeval-architecture-review") {
    return [
      `Review the CloudEval architecture for ${projectId}.`,
      "Focus on reliability, security, operational excellence, performance, and cost efficiency.",
      "Use project details, reports, and frontend links where available.",
      "Call out missing evidence separately from confirmed findings.",
    ].join("\n");
  }
  if (recipe.id === "cloudeval-report-summary") {
    return [
      `Summarize latest CloudEval reports for ${projectId}.`,
      "Create a concise Markdown-ready summary with cost highlights, WAF highlights, top risks, and next actions.",
      "Do not paste raw report JSON.",
    ].join("\n");
  }
  if (recipe.id === "cloudeval-billing-review") {
    return [
      `Review CloudEval billing usage over ${range}.`,
      "Use billing summary, usage, ledger, invoices, notifications, plans, and top-up context where available.",
      "Summarize credit status, usage trend, unusual charges, and recommended billing actions.",
      "Do not paste full ledger entries or sensitive identifiers.",
    ].join("\n");
  }
  if (recipe.id === "cloudeval-architecture-diagram-export") {
    return explicitCommandPrompt(recipe, context, [
      `Prepare an architecture diagram export for ${projectId} to ${outputPath}.`,
      "Use layout=architecture, labels=all by default, and include the architecture workspace URL.",
    ]);
  }
  if (recipe.id === "cloudeval-dependency-diagram-export") {
    return explicitCommandPrompt(recipe, context, [
      `Prepare a dependency diagram export for ${projectId} to ${outputPath}.`,
      "Use layout=dependency, labels=all by default, and include the dependency workspace URL.",
    ]);
  }
  if (recipe.id === "cloudeval-diagram-export") {
    return explicitCommandPrompt(recipe, context, [
      `Prepare a CloudEval diagram export for ${projectId} to ${outputPath}.`,
      "Ask whether architecture or dependency layout is preferred if the layout is not specified.",
    ]);
  }
  return explicitCommandPrompt(recipe, context);
};

export const renderRecipeMarkdown = (recipe: Recipe): string => {
  const list = (items: string[]) => items.map((item) => `- ${item}`).join("\n");
  const inputs = recipe.inputs.length
    ? recipe.inputs
        .map((input) => `- ${input.name}${input.required ? " (required)" : ""}: ${input.description}`)
        .join("\n")
    : "- None";
  return [
    `# ${recipe.title}`,
    "",
    recipe.description,
    "",
    `- ID: ${recipe.id}`,
    `- Skill: ${recipe.skill}`,
    `- Mode: ${recipe.mode}`,
    `- Category: ${recipe.category}`,
    "",
    "## Inputs",
    inputs,
    "",
    "## Commands",
    list(recipe.commands),
    "",
    "## MCP Tools",
    recipe.mcpTools.length ? list(recipe.mcpTools) : "- None",
    "",
    "## Safety",
    `- Requires auth: ${recipe.safety.requiresAuth ? "yes" : "no"}`,
    `- Consumes credits: ${recipe.safety.consumesCredits ? "yes" : "no"}`,
    `- Writes local file: ${recipe.safety.writesLocalFile ? "yes" : "no"}`,
    `- May expose sensitive data: ${recipe.safety.mayExposeSensitiveData ? "yes" : "no"}`,
    `- Mutation: ${recipe.safety.mutation}`,
    "",
    "## Expected Output",
    list(recipe.expectedOutput),
    "",
    "## Failure Handling",
    list(recipe.failureHandling),
    "",
  ].join("\n");
};

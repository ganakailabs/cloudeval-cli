export type RecipeId =
  | "cost-review"
  | "waf-triage"
  | "architecture-review"
  | "template-project-review"
  | "report-summary"
  | "billing-review"
  | "diagram-export"
  | "mcp-setup";

export type RecipeCategory =
  | "cost"
  | "waf"
  | "architecture"
  | "projects"
  | "reports"
  | "billing"
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
  range?: string;
  templateFile?: string;
  templateUrl?: string;
  parametersFile?: string;
  parametersUrl?: string;
  provider?: string;
  name?: string;
  outputPath?: string;
}

export const recipes: Recipe[] = [
  {
    id: "cost-review",
    title: "Cost Review",
    description: "Review latest CloudEval cost posture, usage, savings, and anomalies.",
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
    mcpTools: ["reports_list", "billing_usage", "ask"],
    safety: {
      requiresAuth: true,
      consumesCredits: true,
      writesLocalFile: false,
      mayExposeSensitiveData: true,
      mutation: "none",
    },
    expectedOutput: [
      "Top cost drivers",
      "Savings opportunities",
      "Anomalies or missing evidence",
      "Prioritized next actions",
    ],
    failureHandling: [
      "If reports are unavailable, ask the user before running reports.",
      "If billing usage is unavailable, state the missing evidence.",
    ],
  },
  {
    id: "waf-triage",
    title: "WAF Triage",
    description: "Triage Well-Architected Framework findings and remediation order.",
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
    mcpTools: ["reports_list", "ask"],
    safety: {
      requiresAuth: true,
      consumesCredits: true,
      writesLocalFile: false,
      mayExposeSensitiveData: true,
      mutation: "none",
    },
    expectedOutput: [
      "Findings grouped by pillar",
      "Severity and likely blast radius",
      "Remediation plan",
      "Missing evidence called out separately",
    ],
    failureHandling: [
      "If no WAF report exists, recommend `cloudeval reports run --type waf` but do not run it automatically.",
    ],
  },
  {
    id: "architecture-review",
    title: "Architecture Review",
    description: "Review CloudEval project architecture across reliability, security, operations, performance, and cost.",
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
    safety: {
      requiresAuth: true,
      consumesCredits: true,
      writesLocalFile: false,
      mayExposeSensitiveData: true,
      mutation: "none",
    },
    expectedOutput: [
      "Architecture risks",
      "Best-practice gaps",
      "Evidence-backed recommendations",
    ],
    failureHandling: [
      "If project details are unavailable, ask for a project id or run `cloudeval projects list`.",
    ],
  },
  {
    id: "template-project-review",
    title: "Template Project Review",
    description: "Create or inspect a CloudEval template project using existing local JSON or URL template support.",
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
    safety: {
      requiresAuth: true,
      consumesCredits: false,
      writesLocalFile: false,
      mayExposeSensitiveData: true,
      mutation: "explicit",
    },
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
    id: "report-summary",
    title: "Report Summary",
    description: "Summarize latest CloudEval reports into a concise Markdown-ready review.",
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
    safety: {
      requiresAuth: true,
      consumesCredits: true,
      writesLocalFile: false,
      mayExposeSensitiveData: true,
      mutation: "none",
    },
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
    id: "billing-review",
    title: "Billing Review",
    description: "Review CloudEval credits, plans, usage, ledger patterns, invoices, and top-up options.",
    category: "billing",
    skill: "cloudeval-billing",
    mode: "ask",
    inputs: [{ name: "range", description: "Billing usage range such as 7d, 30d, 90d, or all." }],
    commands: [
      "cloudeval billing summary",
      "cloudeval billing usage --range <range>",
      "cloudeval billing ledger --range <range>",
      "cloudeval billing topups",
      "cloudeval ask \"Review CloudEval billing usage\"",
    ],
    mcpTools: ["billing_summary", "billing_usage", "billing_ledger", "billing_topups", "ask"],
    safety: {
      requiresAuth: true,
      consumesCredits: true,
      writesLocalFile: false,
      mayExposeSensitiveData: true,
      mutation: "none",
    },
    expectedOutput: [
      "Credit status",
      "Usage trend",
      "Ledger anomalies",
      "Recommended billing action",
    ],
    failureHandling: [
      "Never paste full billing ledger payloads; summarize and redact identifiers.",
    ],
  },
  {
    id: "diagram-export",
    title: "Diagram Export",
    description: "Export CloudEval architecture or dependency diagrams using the existing project diagram command.",
    category: "projects",
    skill: "cloudeval-projects",
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
    id: "mcp-setup",
    title: "MCP Setup",
    description: "Configure CloudEval MCP for Codex, Cursor, Claude, or a generic stdio client.",
    category: "mcp",
    skill: "cloudeval-mcp-diagnostics",
    mode: "guide",
    inputs: [{ name: "client", description: "codex, cursor, claude, or generic." }],
    commands: [
      "cloudeval mcp status --format json",
      "cloudeval mcp setup codex --dry-run --toolset readonly --format json",
      "cloudeval mcp setup cursor --dry-run --toolset reports --format json",
      "cloudeval mcp serve --toolset readonly",
    ],
    mcpTools: ["capabilities_get", "recipes_list"],
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
    ],
    failureHandling: [
      "Use --dry-run before writing client config files.",
      "If auth is missing, run `cloudeval login` before serving MCP.",
    ],
  },
];

export const recipeIds = recipes.map((recipe) => recipe.id);

const recipeById = new Map(recipes.map((recipe) => [recipe.id, recipe]));

export const getRecipe = (id: string): Recipe | undefined =>
  recipeById.get(id as RecipeId);

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

export const renderRecipePrompt = (
  recipe: Recipe,
  context: RecipePromptContext = {},
): string => {
  const projectId = contextValue(context, "projectId", "the default CloudEval project");
  const range = contextValue(context, "range", "30d");
  if (recipe.id === "cost-review") {
    return [
      `Run a CloudEval cost review for ${projectId} over ${range}.`,
      "Use CloudEval reports, billing usage, and project context where available.",
      "Return top cost drivers, savings opportunities, anomalies, and concrete next actions.",
      "Separate confirmed evidence from assumptions or missing data.",
    ].join("\n");
  }
  if (recipe.id === "waf-triage") {
    return [
      `Triage Well-Architected findings for ${projectId}.`,
      "Use CloudEval WAF reports and rules where available.",
      "Group issues by pillar and severity, identify likely blast radius, and propose an ordered remediation plan.",
      "Do not regenerate reports unless the user explicitly asks.",
    ].join("\n");
  }
  if (recipe.id === "architecture-review") {
    return [
      `Review the CloudEval architecture for ${projectId}.`,
      "Focus on reliability, security, operational excellence, performance, and cost efficiency.",
      "Use project details, reports, and frontend links where available.",
      "Call out missing evidence separately from confirmed findings.",
    ].join("\n");
  }
  if (recipe.id === "report-summary") {
    return [
      `Summarize latest CloudEval reports for ${projectId}.`,
      "Create a concise Markdown-ready summary with cost highlights, WAF highlights, top risks, and next actions.",
      "Do not paste raw report JSON.",
    ].join("\n");
  }
  if (recipe.id === "billing-review") {
    return [
      `Review CloudEval billing usage over ${range}.`,
      "Use billing summary, usage, ledger, plans, and top-up context where available.",
      "Summarize credit status, usage trend, unusual charges, and recommended billing actions.",
      "Do not paste full ledger entries or sensitive identifiers.",
    ].join("\n");
  }
  return [
    `${recipe.title}: ${recipe.description}`,
    "Use only existing CloudEval CLI and MCP capabilities listed in the recipe.",
    "Do not perform explicit mutations unless the user runs the shown command.",
  ].join("\n");
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

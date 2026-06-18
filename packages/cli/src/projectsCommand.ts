import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import type { Command } from "commander";
import {
  addAuthOptions,
  requireAuthUser,
  resolveAuthContext,
  type AuthGuardDeps,
  type AuthGuardOptions,
} from "./authGuard.js";
import {
  buildFrontendUrl,
  openExternalUrl,
  resolveFrontendBaseUrl,
} from "./frontendLinks.js";
import {
  formatOutput,
  writeFormattedOutput,
  type MachineOutputFormat,
} from "./outputFormatter.js";
import {
  downloadProjectDiagramImage,
  normalizeProjectDiagramImageFormat,
  normalizeProjectDiagramImageLabels,
  normalizeProjectDiagramImageLayout,
  resolveProjectDiagramImageFrontendUrl,
} from "./projectDiagramImage.js";
import {
  getProjectGraph,
  getProjectGraphDiff,
  getProjectGraphInsights,
  getProjectGraphTimeline,
  listProjectSyncRuns,
} from "./graphClient.js";

export interface RegisterProjectsCommandOptions extends AuthGuardDeps {
  defaultBaseUrl: string;
}

type CommonOptions = AuthGuardOptions & {
  format?: MachineOutputFormat;
  output?: string;
  open?: boolean;
  printUrl?: boolean;
  frontendUrl?: string;
};

type DiagramImageCommandOptions = AuthGuardOptions & {
  frontendUrl?: string;
  layout?: string;
  format?: string;
  labels?: string;
  output: string;
  headersOutput?: string;
  public?: boolean;
  syncVersion?: string;
  json?: boolean;
};

type GraphCommandOptions = CommonOptions & {
  syncVersion?: string;
  asOf?: string;
  includeDiff?: boolean;
  from?: string;
  to?: string;
  focus?: string;
  resource?: string;
  limit?: string;
};

type WorkspaceFile = {
  path: string;
  blob: Blob;
};

type WorkspaceConfig = {
  entry?: string;
  parameters?: string;
};

type ProjectCreateOptions = CommonOptions & {
  templateUrl?: string;
  templateFile?: string;
  parametersFile?: string;
  parametersUrl?: string;
  workspaceDir?: string;
  workspaceEntry?: string;
  workspaceParameters?: string;
  cloudSync?: boolean;
  azureTenantId?: string;
  azureClientId?: string;
  azureClientSecret?: string;
  azureClientSecretStdin?: boolean;
  azureSubscriptionId?: string;
  resourceGroup?: string[];
  resourceGroups?: string;
  name?: string;
  description?: string;
  provider?: string;
};

const addCommon = <T extends Command>(command: T): T =>
  command
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file")
    .option("--open", "Open the matching frontend page", false)
    .option("--print-url", "Print the matching frontend URL", false)
    .option("--no-open", "Do not launch the browser when a URL is printed")
    .option("--frontend-url <url>", "Frontend base URL") as T;

const frontendBase = (
  context: { baseUrl: string },
  options: { frontendUrl?: string }
): string =>
  resolveFrontendBaseUrl({
    frontendUrl: options.frontendUrl,
    apiBaseUrl: context.baseUrl,
  });

const maybeOpen = async (url: string, options: CommonOptions) => {
  if (options.printUrl) {
    process.stdout.write(`${url}\n`);
  }
  if (options.open !== false && (options.open || options.printUrl)) {
    await openExternalUrl(url);
  }
};

const stringifyProjectScalar = (value: unknown, fallback = "-"): string => {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
};

const projectStatus = (project: Record<string, unknown>): string => {
  const status = project.status;
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return stringifyProjectScalar(project.type);
  }
  const record = status as Record<string, any>;
  const sync = stringifyProjectScalar(record.sync?.status);
  const architecture = stringifyProjectScalar(record.architecture?.status);
  const cost = stringifyProjectScalar(record.cost?.status);
  const compact = (value: string): string =>
    value === "completed" ? "done" : value === "not_started" ? "new" : value;
  return `sync:${compact(sync)} arch:${compact(architecture)} cost:${compact(cost)}`;
};

const renderProjectListText = (projects: unknown[]): string => {
  if (!projects.length) {
    return "No projects found.\n";
  }

  const rows = projects.map((project) => {
    const record =
      project && typeof project === "object" && !Array.isArray(project)
        ? (project as Record<string, unknown>)
        : {};
    return {
      id: stringifyProjectScalar(record.id),
      name: stringifyProjectScalar(record.name),
      provider: stringifyProjectScalar(record.cloud_provider),
      source: stringifyProjectScalar(record.project_data_source, stringifyProjectScalar(record.type)),
      status: projectStatus(record),
      updated: stringifyProjectScalar(record.updated_at ?? record.created_at),
    };
  });

  const headers = ["ID", "Name", "Provider", "Source", "Status", "Updated"];
  const widths = [36, 24, 10, 14, 34, 19];
  const formatRow = (values: string[]) =>
    values
      .map((value, index) => value.padEnd(widths[index]).slice(0, widths[index]))
      .join("  ")
      .trimEnd();

  return [
    formatRow(headers),
    formatRow(widths.map((width) => "-".repeat(width))),
    ...rows.map((row) =>
      formatRow([row.id, row.name, row.provider, row.source, row.status, row.updated])
    ),
  ].join("\n") + "\n";
};

const renderProjectListMarkdown = (projects: unknown[]): string => {
  if (!projects.length) {
    return "# Projects\n\nNo projects found.\n";
  }
  const rows = projects.map((project) => {
    const record =
      project && typeof project === "object" && !Array.isArray(project)
        ? (project as Record<string, unknown>)
        : {};
    return `| ${stringifyProjectScalar(record.id)} | ${stringifyProjectScalar(record.name)} | ${stringifyProjectScalar(record.cloud_provider)} | ${projectStatus(record)} |`;
  });
  return `# Projects\n\n| ID | Name | Provider | Status |\n| --- | --- | --- | --- |\n${rows.join("\n")}\n`;
};

const writeProjectListOutput = async ({
  data,
  options,
  frontendUrl,
}: {
  data: unknown[];
  options: CommonOptions;
  frontendUrl: string;
}) => {
  const format = options.format ?? "text";
  let text: string;
  if (format === "text") {
    text = renderProjectListText(data);
  } else if (format === "markdown") {
    text = renderProjectListMarkdown(data);
  } else {
    text = formatOutput({
      command: "projects list",
      data,
      format,
      frontendUrl,
    });
  }

  if (options.output) {
    await fs.writeFile(options.output, text, "utf8");
    return;
  }
  process.stdout.write(text);
};

const fileBlob = async (filePath?: string): Promise<{ blob: Blob; name: string } | undefined> => {
  if (!filePath) {
    return undefined;
  }
  const bytes = await fs.readFile(filePath);
  return {
    blob: new Blob([bytes], { type: "application/json" }),
    name: path.basename(filePath),
  };
};

const normalizeWorkspacePath = (value: string): string =>
  value
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^\.\//, "")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");

const SENSITIVE_WORKSPACE_DIR_NAMES = new Set([
  ".aws",
  ".azure",
  ".kube",
  ".terraform",
]);

const SENSITIVE_WORKSPACE_FILENAMES = new Set([
  ".env",
  "credentials",
  "id_rsa",
  "id_ed25519",
  "kubeconfig",
]);

const isSensitiveWorkspacePath = (relativePath: string): boolean => {
  const normalized = normalizeWorkspacePath(relativePath);
  const parts = normalized.split("/");
  if (parts.some((part) => SENSITIVE_WORKSPACE_DIR_NAMES.has(part))) {
    return true;
  }
  const basename = parts.at(-1) ?? "";
  return (
    SENSITIVE_WORKSPACE_FILENAMES.has(basename) ||
    /^\.env\./i.test(basename) ||
    /\.(?:pem|key|pfx|p12)$/i.test(basename) ||
    /\.tfstate(?:\..*)?$/i.test(basename)
  );
};

const isIgnoredWorkspacePath = (relativePath: string): boolean => {
  const normalized = normalizeWorkspacePath(relativePath);
  return (
    normalized === ".DS_Store" ||
    normalized.endsWith("/.DS_Store") ||
    normalized.startsWith(".git/") ||
    normalized.startsWith("node_modules/") ||
    normalized.startsWith(".cloudeval/bundles/") ||
    normalized.startsWith(".cloudeval/connections/") ||
    normalized.startsWith(".cloudeval/reports/") ||
    normalized.startsWith(".cloudeval/share/") ||
    normalized.startsWith(".cloudeval/shares/") ||
    normalized.startsWith(".cloudeval/snapshots/") ||
    normalized.startsWith(".cloudeval/template-cache/") ||
    normalized === ".cloudeval/ps-rule.yaml"
  );
};

const readWorkspaceConfig = (content: string): WorkspaceConfig => {
  const entryMatch = content.match(/^\s*entry:\s*["']?([^"'\n#]+)["']?\s*(?:#.*)?$/m);
  const parametersMatch = content.match(
    /^\s*parameters:\s*["']?([^"'\n#]+)["']?\s*(?:#.*)?$/m
  );
  return {
    entry: entryMatch ? normalizeWorkspacePath(entryMatch[1].trim()) : undefined,
    parameters: parametersMatch ? normalizeWorkspacePath(parametersMatch[1].trim()) : undefined,
  };
};

const generateWorkspaceConfig = (
  entry: string,
  parameters?: string,
  sourceEntry?: string
): string => {
  const parameterLine = parameters ? `    parameters: ${parameters}` : "";
  const sourceEntryLine = sourceEntry ? `    source_entry: ${sourceEntry}` : "";
  return [
    "# CloudEval config v1. Paths are relative to this workspace root.",
    "# Visualization source for diagrams and reports.",
    "version: 1",
    "stacks:",
    "  - id: primary-architecture",
    "    name: Primary architecture",
    `    entry: ${entry}`,
    sourceEntryLine,
    parameterLine,
    "resolve:",
    "  # Follow relative ARM templateLink files when building the analysis bundle.",
    "  linked_templates: true",
    "analysis:",
    "  # Run the normal import -> resolve -> report refresh pipeline after upload.",
    "  auto_resolve_on_import: true",
    "  auto_refresh_on_resolve: true",
    "",
    "# Optional CI gates for `cloudeval review` and GitHub Actions.",
    "# Uncomment and tune these when pull requests should be blocked by CloudEval.",
    "# ci:",
    "#   gates:",
    "#     enforcement: block_pull_request",
    "#     minimum_well_architected_score: 80",
    "#     minimum_pillar_score: 75",
    "#     fail_when_high_risk_findings_exist: true",
    "#     fail_when_validation_fails: true",
    "#     max_monthly_cost_usd: 500",
    "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
};

const runCommand = (
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("exit", (code) => {
      const output = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}${
            output.stderr ? `: ${output.stderr.trim()}` : ""
          }`
        )
      );
    });
  });

const isBicepPath = (filePath: string): boolean => /\.bicep$/i.test(filePath);

const compiledBicepPathFor = (entry: string): string => {
  const parsed = path.posix.parse(entry);
  return normalizeWorkspacePath(
    path.posix.join(
      ".cloudeval/template-cache/compiled",
      parsed.dir,
      `${parsed.name}.json`
    )
  );
};

const compileBicepEntry = async (
  root: string,
  entry: string
): Promise<WorkspaceFile> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-bicep-"));
  const outputPath = path.join(tempDir, "compiled.json");
  try {
    await runCommand("az", [
      "bicep",
      "build",
      "--file",
      path.join(root, entry),
      "--outfile",
      outputPath,
    ]);
    const bytes = await fs.readFile(outputPath);
    return {
      path: compiledBicepPathFor(entry),
      blob: new Blob([bytes], { type: "application/json" }),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Bicep compilation failed.";
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(
        "Bicep workspace entries require Azure CLI with `az bicep` available. Install Azure CLI or upload a compiled ARM JSON entry."
      );
    }
    throw new Error(`Failed to compile Bicep workspace entry '${entry}': ${message}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

const collectWorkspacePaths = async (
  root: string,
  allowedSensitivePaths: Set<string> = new Set()
): Promise<string[]> => {
  const paths: string[] = [];
  const visit = async (directory: string) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = normalizeWorkspacePath(path.relative(root, absolute));
      if (
        !relative ||
        isIgnoredWorkspacePath(relative) ||
        (isSensitiveWorkspacePath(relative) && !allowedSensitivePaths.has(relative))
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        paths.push(relative);
      }
    }
  };
  await visit(root);
  return paths.sort((left, right) => left.localeCompare(right));
};

const findFirstPath = (paths: string[], candidates: string[]): string | undefined => {
  const lowerToPath = new Map(paths.map((filePath) => [filePath.toLowerCase(), filePath]));
  for (const candidate of candidates) {
    const found = lowerToPath.get(candidate.toLowerCase());
    if (found) {
      return found;
    }
  }
  return undefined;
};

const detectWorkspaceEntry = (
  paths: string[],
  explicitEntry?: string,
  config?: WorkspaceConfig
): string => {
  if (explicitEntry) {
    const normalized = normalizeWorkspacePath(explicitEntry);
    if (!paths.includes(normalized)) {
      throw new Error(`--workspace-entry '${explicitEntry}' was not found in --workspace-dir.`);
    }
    return normalized;
  }
  if (config?.entry && paths.includes(config.entry)) {
    return config.entry;
  }
  const rootCandidate = findFirstPath(paths, ["azuredeploy.json", "main.json", "deploy.json"]);
  if (rootCandidate) {
    return rootCandidate;
  }
  const recursiveAzureDeploy = paths.find((filePath) =>
    /(^|\/)azuredeploy\.json$/i.test(filePath)
  );
  if (recursiveAzureDeploy) {
    return recursiveAzureDeploy;
  }
  const armCandidate = paths.find((filePath) => /\.json$/i.test(filePath));
  if (armCandidate) {
    return armCandidate;
  }
  throw new Error(
    "Could not detect a workspace entry file. Pass --workspace-entry or add .cloudeval/config.yaml."
  );
};

const resolveWorkspaceParameters = (
  paths: string[],
  explicitParameters?: string,
  config?: WorkspaceConfig
): string | undefined => {
  if (explicitParameters) {
    const normalized = normalizeWorkspacePath(explicitParameters);
    if (!paths.includes(normalized)) {
      throw new Error(`--workspace-parameters '${explicitParameters}' was not found in --workspace-dir.`);
    }
    return normalized;
  }
  if (config?.parameters && paths.includes(config.parameters)) {
    return config.parameters;
  }
  return findFirstPath(paths, ["azuredeploy.parameters.json", "parameters.json"]);
};

const collectWorkspaceFiles = async (
  workspaceDir: string,
  options: Pick<ProjectCreateOptions, "workspaceEntry" | "workspaceParameters">
): Promise<{ files: WorkspaceFile[]; entry: string }> => {
  const root = path.resolve(workspaceDir);
  const stat = await fs.stat(root).catch(() => undefined);
  if (!stat?.isDirectory()) {
    throw new Error(`--workspace-dir '${workspaceDir}' is not a directory.`);
  }

  const allowedSensitivePaths = new Set(
    [options.workspaceEntry, options.workspaceParameters]
      .filter((value): value is string => Boolean(value))
      .map((value) => normalizeWorkspacePath(value))
  );
  const paths = await collectWorkspacePaths(root, allowedSensitivePaths);
  const existingConfigPath = paths.find(
    (filePath) => filePath.toLowerCase() === ".cloudeval/config.yaml"
  );
  const config = existingConfigPath
    ? readWorkspaceConfig(await fs.readFile(path.join(root, existingConfigPath), "utf8"))
    : undefined;
  if (
    config?.parameters &&
    isSensitiveWorkspacePath(config.parameters) &&
    !paths.includes(config.parameters)
  ) {
    const parameterStat = await fs
      .stat(path.join(root, config.parameters))
      .catch(() => undefined);
    if (parameterStat?.isFile()) {
      paths.push(config.parameters);
      paths.sort((left, right) => left.localeCompare(right));
    }
  }
  const entry = detectWorkspaceEntry(paths, options.workspaceEntry, config);
  const parameters = resolveWorkspaceParameters(paths, options.workspaceParameters, config);
  const compiledEntry = isBicepPath(entry)
    ? await compileBicepEntry(root, entry)
    : undefined;
  const analysisEntry = compiledEntry?.path ?? entry;
  const finalPaths = [...paths];
  const generatedConfig = existingConfigPath && !compiledEntry
    ? undefined
    : generateWorkspaceConfig(analysisEntry, parameters, compiledEntry ? entry : undefined);
  if (generatedConfig) {
    finalPaths.push(".cloudeval/config.yaml");
  }

  const files: WorkspaceFile[] = [];
  if (compiledEntry) {
    files.push(compiledEntry);
  }
  for (const relativePath of finalPaths.sort((left, right) => left.localeCompare(right))) {
    if (relativePath === ".cloudeval/config.yaml" && generatedConfig) {
      files.push({
        path: relativePath,
        blob: new Blob([generatedConfig], { type: "text/yaml" }),
      });
      continue;
    }
    const bytes = await fs.readFile(path.join(root, relativePath));
    files.push({
      path: relativePath,
      blob: new Blob([bytes], {
        type: /\.ya?ml$/i.test(relativePath) ? "text/yaml" : "application/octet-stream",
      }),
    });
  }
  return { files, entry: analysisEntry };
};

const collectResourceGroups = (options: ProjectCreateOptions): string[] => {
  const repeated = Array.isArray(options.resourceGroup) ? options.resourceGroup : [];
  const commaSeparated = options.resourceGroups
    ? options.resourceGroups.split(",").map((value) => value.trim())
    : [];
  return [...repeated, ...commaSeparated].map((value) => value.trim()).filter(Boolean);
};

const readSecretFromStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
};

const resolveAzureCloudSyncInput = async (options: ProjectCreateOptions) => {
  if (!options.cloudSync) {
    return undefined;
  }
  const tenantId = options.azureTenantId || process.env.AZURE_TENANT_ID;
  const clientId = options.azureClientId || process.env.AZURE_CLIENT_ID;
  if (options.azureClientSecret && options.azureClientSecretStdin) {
    throw new Error("Use either --azure-client-secret or --azure-client-secret-stdin, not both.");
  }
  let clientSecret = process.env.AZURE_CLIENT_SECRET;
  if (options.azureClientSecretStdin) {
    clientSecret = await readSecretFromStdin();
  } else if (options.azureClientSecret) {
    process.stderr.write(
      "Warning: --azure-client-secret can be exposed in shell history. Prefer AZURE_CLIENT_SECRET or --azure-client-secret-stdin.\n"
    );
    clientSecret = options.azureClientSecret;
  }
  const subscriptionId = options.azureSubscriptionId || process.env.AZURE_SUBSCRIPTION_ID;
  const missing = [
    ["--azure-tenant-id or AZURE_TENANT_ID", tenantId],
    ["--azure-client-id or AZURE_CLIENT_ID", clientId],
    ["--azure-client-secret or AZURE_CLIENT_SECRET", clientSecret],
    ["--azure-subscription-id or AZURE_SUBSCRIPTION_ID", subscriptionId],
  ]
    .filter(([, value]) => !value)
    .map(([label]) => label);
  if (missing.length) {
    throw new Error(`Missing Cloud sync credential value(s): ${missing.join(", ")}.`);
  }
  return {
    tenantId: tenantId!,
    clientId: clientId!,
    clientSecret: clientSecret!,
    subscriptionId: subscriptionId!,
    resourceGroups: collectResourceGroups(options),
  };
};

const assertSingleProjectSource = (options: ProjectCreateOptions) => {
  const sources = [
    options.templateUrl ? "--template-url" : undefined,
    options.templateFile ? "--template-file" : undefined,
    options.workspaceDir ? "--workspace-dir" : undefined,
    options.cloudSync ? "--cloud-sync" : undefined,
  ].filter(Boolean);
  if (sources.length > 1) {
    throw new Error(`Choose one project source: ${sources.join(", ")} cannot be combined.`);
  }
  if ((options.parametersFile || options.parametersUrl) && !options.templateFile && !options.templateUrl) {
    throw new Error("--parameters-file and --parameters-url require --template-file or --template-url.");
  }
  if (options.cloudSync && options.provider && options.provider !== "azure") {
    throw new Error("--cloud-sync currently supports --provider azure.");
  }
};

const appendOptionValue = (value: string, previous: string[] = []): string[] => [
  ...previous,
  value,
];

const writeDiagramImageHeaders = async (
  outputPath: string,
  headers: Record<string, string>
) => {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const text = Object.entries(headers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  await fs.writeFile(outputPath, `${text}\n`, "utf8");
};

const listProjectsForContext = async (
  core: typeof import("@cloudeval/core"),
  context: { baseUrl: string; token: string; user?: { id: string } }
) => {
  if (context.user?.id) {
    return core.getProjects(context.baseUrl, context.token, context.user.id);
  }
  return core.getAccessibleProjects(context.baseUrl, context.token);
};

const parseLimit = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--limit must be a positive integer.");
  }
  return parsed;
};

const resolveGraphAuth = async (
  options: AuthGuardOptions,
  command: Command,
  deps: RegisterProjectsCommandOptions
) => {
  const parentOptions = (command.parent?.opts?.() ?? {}) as AuthGuardOptions;
  const mergedOptions: AuthGuardOptions = {
    ...options,
    baseUrl: options.baseUrl || parentOptions.baseUrl,
    accessKey: options.accessKey || parentOptions.accessKey,
    accessKeyStdin: options.accessKeyStdin || parentOptions.accessKeyStdin,
    nonInteractive: options.nonInteractive || parentOptions.nonInteractive,
  };
  return requireAuthUser(await resolveAuthContext(mergedOptions, command, deps));
};

const writeProjectGraphOutput = async (
  command: string,
  data: unknown,
  options: GraphCommandOptions
) =>
  writeFormattedOutput({
    command,
    data,
    format: options.format,
    output: options.output,
  });

const configureGraphCommands = (
  projects: Command,
  deps: RegisterProjectsCommandOptions
) => {
  const graph = addCommon(
    addAuthOptions(
      projects
        .command("graph")
        .description("Inspect project graph intelligence")
        .argument("<target>", "Project id, or one of: get, timeline, diff, insights, sync-runs")
        .argument("[id]", "Project id when using a graph action"),
      deps.defaultBaseUrl
    )
  )
    .option("--sync-version <version>", "Optional project sync version")
    .option("--as-of <timestamp>", "Replay graph as of a timestamp")
    .option("--include-diff", "Include diff metadata when available", false)
    .option("--limit <count>", "Maximum runs to return", "20")
    .option("--from <version>", "Baseline sync version")
    .option("--to <version>", "Target sync version")
    .option("--focus <focus>", "Insight focus: overview, impact, critical-paths, security, cost, changes", "overview")
    .option("--resource <id>", "Resource id for impact analysis");

  graph.action(async (target: string, id: string | undefined, options: GraphCommandOptions, command) => {
    const actions = new Set(["get", "show", "timeline", "diff", "insights", "sync-runs"]);
    const action = actions.has(target) ? target : "get";
    const projectId = actions.has(target) ? id : target;
    if (!projectId) {
      command.help({ error: true });
      return;
    }
    const resolvedProjectId = projectId;
    try {
      const context = await resolveGraphAuth(options, command, deps);
      if (action === "timeline") {
        const data = await getProjectGraphTimeline({
          baseUrl: context.baseUrl,
          authToken: context.token,
          userId: context.user.id,
          projectId: resolvedProjectId,
          limit: parseLimit(options.limit),
        });
        await writeProjectGraphOutput("projects graph timeline", data, options);
        return;
      }
      if (action === "diff") {
        const data = await getProjectGraphDiff({
          baseUrl: context.baseUrl,
          authToken: context.token,
          userId: context.user.id,
          projectId: resolvedProjectId,
          fromSyncVersion: options.from,
          toSyncVersion: options.to,
        });
        await writeProjectGraphOutput("projects graph diff", data, options);
        return;
      }
      if (action === "insights") {
        const data = await getProjectGraphInsights({
          baseUrl: context.baseUrl,
          authToken: context.token,
          userId: context.user.id,
          projectId: resolvedProjectId,
          focus: options.focus,
          resourceId: options.resource,
          syncVersion: options.syncVersion,
          limit: parseLimit(options.limit),
        });
        await writeProjectGraphOutput("projects graph insights", data, options);
        return;
      }
      if (action === "sync-runs") {
        const data = await listProjectSyncRuns({
          baseUrl: context.baseUrl,
          authToken: context.token,
          userId: context.user.id,
          projectId: resolvedProjectId,
          limit: parseLimit(options.limit),
        });
        await writeProjectGraphOutput("projects graph sync-runs", data, options);
        return;
      }
      const data = await getProjectGraph({
        baseUrl: context.baseUrl,
        authToken: context.token,
        userId: context.user.id,
        projectId: resolvedProjectId,
        syncVersion: options.syncVersion,
        asOf: options.asOf,
        includeDiff: options.includeDiff,
      });
      await writeProjectGraphOutput("projects graph", data, options);
    } catch (error: any) {
      console.error(`Failed to fetch project graph: ${error?.message ?? "Unknown error"}`);
      process.exit(1);
    }
  });
};

const configureDiagramExportCommand = (
  command: Command,
  deps: RegisterProjectsCommandOptions
) =>
  addAuthOptions(command, deps.defaultBaseUrl)
    .option(
      "--frontend-url <url>",
      "Frontend base URL (defaults to https://cloudeval.ai; set for local/dev frontends)"
    )
    .option("--layout <layout>", "Diagram layout: architecture, dependency", "architecture")
    .option("--format <format>", "Image format: png, jpeg, jpg, svg", "png")
    .option("--labels <labels>", "Label mode: all, viewport", "all")
    .requiredOption("--output <file>", "Image output file")
    .option("--headers-output <file>", "Optional response headers output file")
    .option("--public", "Download the explicit public/share graph without authentication", false)
    .option("--sync-version <version>", "Optional project sync version")
    .option("--json", "Print machine-readable metadata to stdout", false)
    .action(async (id: string, options: DiagramImageCommandOptions, actionCommand) => {
      try {
        const publicGraph = Boolean(options.public);
        const layout = normalizeProjectDiagramImageLayout(options.layout);
        const imageFormat = normalizeProjectDiagramImageFormat(options.format);
        const labels = normalizeProjectDiagramImageLabels(options.labels);

        let token: string | undefined;
        let userId: string | undefined;
        if (publicGraph) {
          await deps.resolveBaseUrl(options, actionCommand);
        } else {
          const context = requireAuthUser(
            await resolveAuthContext(options, actionCommand, deps)
          );
          const core = await import("@cloudeval/core");
          const projects = await core.getProjects(
            context.baseUrl,
            context.token,
            context.user.id
          );
          if (!projects.some((project: any) => project.id === id)) {
            throw new Error(
              `Project ${id} was not found for authenticated user ${context.user.id}. ` +
                "Run `cloudeval projects list` to choose a visible project, or use --public only for explicit public/share graph exports."
            );
          }
          token = context.token;
          userId = context.user.id;
        }

        const frontendUrl = resolveProjectDiagramImageFrontendUrl({
          frontendUrl: options.frontendUrl,
        });
        const result = await downloadProjectDiagramImage({
          frontendUrl,
          projectId: id,
          layout,
          format: imageFormat,
          labels,
          token,
          userId,
          publicGraph,
          syncVersion: options.syncVersion,
        });

        const outputPath = path.resolve(options.output);
        const headersOutputPath = options.headersOutput
          ? path.resolve(options.headersOutput)
          : undefined;
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, result.bytes);
        const filesWritten = [outputPath];
        if (headersOutputPath) {
          await writeDiagramImageHeaders(headersOutputPath, result.headers);
          filesWritten.push(headersOutputPath);
        }

        const data = {
          projectId: id,
          layout,
          format: imageFormat,
          labels,
          public: publicGraph,
          output: outputPath,
          headersOutput: headersOutputPath,
          contentType: result.contentType,
          bytes: result.bytes.length,
          authMode: result.headers["x-cloudeval-diagram-auth-mode"],
          graphPrivate: result.headers["x-cloudeval-diagram-graph-private"],
          graphSource: result.headers["x-cloudeval-diagram-graph-source"],
        };

        if (options.json) {
          process.stdout.write(
            formatOutput({
              command: "projects export-diagram",
              data,
              format: "json",
              frontendUrl: result.url,
              filesWritten,
            })
          );
          return;
        }

        process.stdout.write(
          `Downloaded ${layout} diagram to ${outputPath} (${result.contentType}, ${result.bytes.length} bytes)\n`
        );
      } catch (error: any) {
        console.error(`Failed to export project diagram: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });

export const registerProjectsCommand = (
  program: Command,
  deps: RegisterProjectsCommandOptions
) => {
  const projects = program.command("projects").description("Project utilities");

  addCommon(addAuthOptions(projects.command("list").description("List projects"), deps.defaultBaseUrl))
    .action(async (options: CommonOptions, command) => {
      try {
        const context = await resolveAuthContext(options, command, deps);
        const core = await import("@cloudeval/core");
        const data = await listProjectsForContext(core, context);
        const url = buildFrontendUrl({ baseUrl: frontendBase(context, options), target: "projects" });
        await writeProjectListOutput({ data, options, frontendUrl: url });
        await maybeOpen(url, options);
      } catch (error: any) {
        console.error(`Failed to list projects: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });

  addCommon(
    addAuthOptions(
      projects.command("get").description("Show a project").argument("<id>", "Project id"),
      deps.defaultBaseUrl
    )
  ).action(async (id: string, options: CommonOptions, command) => {
    try {
      const context = await resolveAuthContext(options, command, deps);
      const core = await import("@cloudeval/core");
      const list = await listProjectsForContext(core, context);
      const data = list.find((project: any) => project.id === id);
      if (!data) {
        throw new Error(`Project ${id} was not found.`);
      }
      const url = buildFrontendUrl({
        baseUrl: frontendBase(context, options),
        target: "project",
        projectId: id,
      });
      await writeFormattedOutput({
        command: "projects get",
        data,
        format: options.format,
        output: options.output,
        frontendUrl: url,
      });
      await maybeOpen(url, options);
    } catch (error: any) {
      console.error(`Failed to show project: ${error?.message ?? "Unknown error"}`);
      process.exit(1);
    }
  });

  addCommon(
    addAuthOptions(
      projects.command("open").description("Open a project").argument("<id>", "Project id"),
      deps.defaultBaseUrl
    )
  )
    .option("--view <view>", "View mode: preview, code, both")
    .option("--layout <layout>", "Preview layout: architecture, dependency")
    .action(async (id: string, options: CommonOptions & { view?: string; layout?: string }, command) => {
      try {
        const context = await resolveAuthContext(options, command, deps);
        const url = buildFrontendUrl({
          baseUrl: frontendBase(context, options),
          target: "project",
          projectId: id,
          view: options.view,
          layout: options.layout,
        });
        await writeFormattedOutput({
          command: "projects open",
          data: { url },
          format: options.format,
          output: options.output,
          frontendUrl: url,
        });
        await maybeOpen(url, { ...options, open: options.open || true });
      } catch (error: any) {
        console.error(`Failed to open project: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });

  configureDiagramExportCommand(
    projects
      .command("export-diagram")
      .description("Export a project diagram image")
      .argument("<id>", "Project id"),
    deps
  );

  configureDiagramExportCommand(
    projects
      .command("diagram-image", { hidden: true })
      .description("Export a project diagram image")
      .argument("<id>", "Project id"),
    deps
  );

  configureGraphCommands(projects, deps);

  addCommon(addAuthOptions(projects.command("create").description("Create a CloudEval project"), deps.defaultBaseUrl))
    .option("--template-url <url>", "Template URL")
    .option("--template-file <path>", "Local JSON template file")
    .option("--parameters-file <path>", "Local JSON parameters file")
    .option("--parameters-url <url>", "Parameters file URL")
    .option("--workspace-dir <path>", "Upload an Infrastructure as code folder")
    .option("--workspace-entry <path>", "Workspace visualization entry file")
    .option("--workspace-parameters <path>", "Workspace parameters file")
    .option("--cloud-sync", "Create a Cloud sync project from Azure credentials", false)
    .option("--azure-tenant-id <id>", "Azure tenant id for Cloud sync")
    .option("--azure-client-id <id>", "Azure service principal client id for Cloud sync")
    .option("--azure-client-secret <secret>", "Azure service principal client secret for Cloud sync")
    .option(
      "--azure-client-secret-stdin",
      "Read Azure service principal client secret for Cloud sync from stdin",
      false
    )
    .option("--azure-subscription-id <id>", "Azure subscription id for Cloud sync")
    .option("--resource-group <name>", "Azure resource group scope for Cloud sync", appendOptionValue, [])
    .option("--resource-groups <list>", "Comma-separated Azure resource group scopes for Cloud sync")
    .option("--name <name>", "Project name")
    .option("--description <text>", "Project description")
    .option("--provider <provider>", "Cloud provider: azure, aws, gcp")
    .action(async (options: ProjectCreateOptions, command) => {
      try {
        assertSingleProjectSource(options);
        const context = requireAuthUser(await resolveAuthContext(options, command, deps));
        const core = await import("@cloudeval/core");
        const template = await fileBlob(options.templateFile);
        const parameters = await fileBlob(options.parametersFile);
        const workspace = options.workspaceDir
          ? await collectWorkspaceFiles(options.workspaceDir, options)
          : undefined;
        const cloudSync = await resolveAzureCloudSyncInput(options);
        const inferredName =
          options.name ||
          (options.workspaceDir ? path.basename(path.resolve(options.workspaceDir)) : undefined) ||
          (cloudSync ? "Cloud sync" : undefined) ||
          (options.templateFile ? path.basename(options.templateFile, path.extname(options.templateFile)) : undefined);
        const result = await core.createQuickProject({
          baseUrl: context.baseUrl,
          authToken: context.token,
          userId: context.user.id,
          templateUrl: options.templateUrl,
          templateFile: template?.blob,
          templateFileName: template?.name,
          parametersFile: parameters?.blob,
          parametersFileName: parameters?.name,
          parametersUrl: options.parametersUrl,
          workspaceFiles: workspace?.files,
          workspaceEntry: workspace?.entry,
          cloudSync,
          name: inferredName,
          description: options.description,
          provider: (options.provider as any) ?? "azure",
        });
        const projectId = String(result.project.id);
        const url = buildFrontendUrl({
          baseUrl: frontendBase(context, options),
          target: "project",
          projectId,
        });
        await writeFormattedOutput({
          command: "projects create",
          data: {
            project: result.project,
            connection: result.connection,
            syncStatus: result.syncStatus,
            normalizedTemplateUrl: result.normalizedTemplateUrl,
            inferred: result.inferred,
            iacPipeline: result.iacPipeline,
          },
          format: options.format,
          output: options.output,
          frontendUrl: url,
        });
        await maybeOpen(url, options);
      } catch (error: any) {
        console.error(`Failed to create project: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });
};

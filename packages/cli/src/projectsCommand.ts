import path from "node:path";
import fs from "node:fs/promises";
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

export const registerProjectsCommand = (
  program: Command,
  deps: RegisterProjectsCommandOptions
) => {
  const projects = program.command("projects").description("Project utilities");

  addCommon(addAuthOptions(projects.command("list").description("List projects"), deps.defaultBaseUrl))
    .action(async (options: CommonOptions, command) => {
      try {
        const context = requireAuthUser(await resolveAuthContext(options, command, deps));
        const core = await import("@cloudeval/core");
        const data = await core.getProjects(context.baseUrl, context.token, context.user.id);
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
      const context = requireAuthUser(await resolveAuthContext(options, command, deps));
      const core = await import("@cloudeval/core");
      const list = await core.getProjects(context.baseUrl, context.token, context.user.id);
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

  addCommon(addAuthOptions(projects.command("create").description("Create a quick template project"), deps.defaultBaseUrl))
    .option("--template-url <url>", "Template URL")
    .option("--template-file <path>", "Local JSON template file")
    .option("--parameters-file <path>", "Local JSON parameters file")
    .option("--parameters-url <url>", "Parameters file URL")
    .option("--name <name>", "Project name")
    .option("--description <text>", "Project description")
    .option("--provider <provider>", "Cloud provider: azure, aws, gcp")
    .action(async (options: CommonOptions & any, command) => {
      try {
        const context = requireAuthUser(await resolveAuthContext(options, command, deps));
        const core = await import("@cloudeval/core");
        const template = await fileBlob(options.templateFile);
        const parameters = await fileBlob(options.parametersFile);
        const inferredName =
          options.name ||
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
          name: inferredName,
          description: options.description,
          provider: options.provider,
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

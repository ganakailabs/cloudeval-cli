import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import {
  addAuthOptions,
  resolveAuthContext,
  type AuthContext,
  type AuthGuardDeps,
  type AuthGuardOptions,
} from "./authGuard.js";
import {
  buildFrontendUrl,
  resolveFrontendBaseUrl,
} from "./frontendLinks.js";
import {
  formatTextTable,
  writeFormattedOutput,
  type MachineOutputFormat,
} from "./outputFormatter.js";
import { createAskProgressWriter, normalizeAskProgressMode } from "./askProgress.js";
import {
  getRecipe,
  recipes,
  recipeSummary,
  renderRecipeCommands,
  renderRecipeMarkdown,
  renderRecipePrompt,
  type Recipe,
  type RecipePromptContext,
} from "./recipes/catalog.js";
import { getActiveConfigProfile, loadCliConfig } from "./cliConfig.js";
import type { CliConfig } from "./cliConfig.js";
import { getFirstNameForDisplay } from "./ui/userDisplayName.js";
import { recordSessionTurn } from "./sessionsStore.js";

export interface RegisterRecipesCommandOptions extends AuthGuardDeps {
  defaultBaseUrl: string;
}

type RecipeFormat = MachineOutputFormat | "table";

interface CommonRecipeOptions extends AuthGuardOptions {
  format?: RecipeFormat;
  output?: string;
  frontendUrl?: string;
}

interface RecipeRunOptions extends CommonRecipeOptions {
  project?: string;
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
  layout?: string;
  model?: string;
  thread?: string;
  progress?: string;
  quiet?: boolean;
  open?: boolean;
  printUrl?: boolean;
}

const STREAM_OUTPUT_NODES = new Set([
  "generate_response",
  "handle_social_interaction",
  "response_compose",
]);

const recipeContext = (options: RecipeRunOptions): RecipePromptContext => ({
  projectId: options.project,
  connectionId: options.connectionId,
  credentialId: options.credentialId,
  range: options.range,
  templateFile: options.templateFile,
  templateUrl: options.templateUrl,
  parametersFile: options.parametersFile,
  parametersUrl: options.parametersUrl,
  provider: options.provider,
  name: options.name,
  outputPath: options.outputPath,
  outputDir: options.outputDir,
  client: options.client,
  layout: options.layout,
});

const renderRecipesTable = (): string =>
  formatTextTable(
    recipes.map((recipe) => ({
      id: recipe.id,
      title: recipe.title,
      mode: recipe.mode,
      category: recipe.category,
      safety: [
        recipe.safety.consumesCredits ? "credits" : undefined,
        recipe.safety.writesLocalFile ? "file" : undefined,
        recipe.safety.mutation === "explicit" ? "explicit" : undefined,
      ].filter(Boolean).join(", ") || "read",
    })),
    [
      { key: "id", header: "ID", width: 43 },
      { key: "title", header: "Title", maxWidth: 36 },
      { key: "mode", header: "Mode", width: 6 },
      { key: "category", header: "Category", width: 14 },
      { key: "safety", header: "Safety", maxWidth: 18 },
    ],
    { emptyMessage: "No Cloudeval recipes found." },
  );

const renderRecipesMarkdown = (): string =>
  [
    "# Cloudeval Recipes",
    "",
    ...recipes.map((recipe) => [
      `## ${recipe.title}`,
      "",
      `- ID: ${recipe.id}`,
      `- Skill: ${recipe.skill}`,
      `- Mode: ${recipe.mode}`,
      `- Category: ${recipe.category}`,
      "",
      recipe.description,
      "",
    ].join("\n")),
  ].join("\n");

const writeRecipeList = async (options: CommonRecipeOptions) => {
  const format = options.format ?? "table";
  if (format === "table" || format === "text") {
    const text = renderRecipesTable();
    if (options.output) {
      await fs.writeFile(options.output, text, "utf8");
      return;
    }
    process.stdout.write(text);
    return;
  }
  if (format === "markdown") {
    const text = renderRecipesMarkdown();
    if (options.output) {
      await fs.writeFile(options.output, text, "utf8");
      return;
    }
    process.stdout.write(text);
    return;
  }
  await writeFormattedOutput({
    command: "recipes list",
    data: { recipes: recipes.map(recipeSummary) },
    format,
    output: options.output,
  });
};

const writeRecipeShow = async (recipe: Recipe, options: CommonRecipeOptions) => {
  const format = options.format ?? "markdown";
  if (format === "markdown" || format === "text") {
    const text = renderRecipeMarkdown(recipe);
    if (options.output) {
      await fs.writeFile(options.output, text, "utf8");
      return;
    }
    process.stdout.write(text);
    return;
  }
  await writeFormattedOutput({
    command: "recipes show",
    data: recipe,
    format: format === "table" ? "text" : format,
    output: options.output,
  });
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

const resolveProject = async (
  core: typeof import("@cloudeval/core"),
  baseUrl: string,
  token: string,
  context: AuthContext,
  requestedProjectId?: string,
) => {
  if (requestedProjectId) {
    return {
      id: requestedProjectId,
      name: "Selected Project",
      user_id: context.user?.id,
      cloud_provider: "azure",
    };
  }
  if (!context.user?.id) {
    throw new Error("Authenticated user id is unavailable. Provide --project or run `cloudeval login`.");
  }
  const projects = await core.getProjects(baseUrl, token, context.user.id);
  const selected = projects.find((project: any) => project.name === "Playground") ?? projects[0];
  if (!selected) {
    throw new Error("No project is available. Provide --project or create a Cloudeval project.");
  }
  return selected;
};

const runChatRecipe = async (
  recipe: Recipe,
  prompt: string,
  options: RecipeRunOptions,
  command: Command,
  deps: RegisterRecipesCommandOptions,
) => {
  const selectedProfile = getActiveConfigProfile(command);
  const cliConfig: CliConfig = await loadCliConfig(selectedProfile).catch(() => ({}));
  const selectedModel = options.model ?? cliConfig.model;
  const selectedProjectId = options.project ?? cliConfig.defaultProjectId;
  const selectedFrontendUrl = options.frontendUrl ?? cliConfig.frontendUrl;
  const outputFormat = (options.format ?? "text") === "table" ? "text" : (options.format ?? "text");
  const progressWriter = createAskProgressWriter({
    mode: normalizeAskProgressMode(options.progress),
    format: outputFormat,
    quiet: Boolean(options.quiet),
    output: options.output,
  });

  progressWriter.write({ type: "auth", step: "auth", message: "Resolving authentication" });
  const context = await resolveAuthContext(options, command, deps);
  const core = await import("@cloudeval/core");

  progressWriter.write({
    type: "request",
    step: "project",
    message: selectedProjectId ? `Using project ${selectedProjectId}` : "Resolving project",
  });
  const project = await resolveProject(core, context.baseUrl, context.token, context, selectedProjectId);
  const threadId = options.thread ?? randomUUID();
  const userName = getFirstNameForDisplay({ email: context.user?.email });
  let chatState: any = { ...core.initialChatState, threadId };
  let responseText = "";

  progressWriter.write({
    type: "request",
    step: "stream",
    message: "Sending recipe request",
    threadId,
    projectId: project.id,
  });

  for await (const chunk of core.streamChat({
    baseUrl: context.baseUrl,
    authToken: context.token,
    message: prompt,
    threadId,
    user: {
      id: project.user_id ?? context.user?.id ?? "cli-user",
      name: userName,
    },
    project,
    settings: {
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(recipe.mode === "agent" ? { mode: "agent" } : { mode: "ask" }),
    },
    completeAfterResponse: true,
    responseCompletionGraceMs: 5000,
  })) {
    chatState = core.reduceChunk(chatState, chunk);
    if (chunk.type === "thinking") {
      progressWriter.write({
        type: "thinking",
        step: (chunk as any).node,
        status: (chunk as any).status,
        message: String((chunk as any).description ?? (chunk as any).message ?? "Working"),
      });
    }
    if (
      chunk.type === "responding" &&
      (chunk as any).content &&
      (!(chunk as any).node || STREAM_OUTPUT_NODES.has((chunk as any).node))
    ) {
      const latestMessage = [...chatState.messages]
        .reverse()
        .find((message: any) => message.role === "assistant");
      responseText = latestMessage?.content || (chunk as any).content;
    }
    if (chunk.type === "error") {
      throw new Error((chunk as any).message || (chunk as any).description || "Cloudeval recipe failed.");
    }
  }

  const finalMessage = [...chatState.messages]
    .reverse()
    .find((message: any) => message.role === "assistant");
  const finalResponse = collapseRepeatedAssistantText(finalMessage?.content || responseText || "");
  if (!finalResponse.trim()) {
    throw new Error("No final response returned by Cloudeval for this recipe.");
  }

  const frontendUrl = buildFrontendUrl({
    baseUrl: resolveFrontendBaseUrl({
      frontendUrl: selectedFrontendUrl,
      apiBaseUrl: context.baseUrl,
    }),
    target: "chat",
    threadId: chatState.threadId,
  });

  await recordSessionTurn({
    threadId: chatState.threadId,
    question: prompt,
    response: finalResponse,
    project: { id: project.id, name: project.name },
    model: selectedModel,
    profile: selectedProfile,
  }).catch(() => undefined);

  progressWriter.clear();
  return {
    recipeId: recipe.id,
    title: recipe.title,
    mode: recipe.mode,
    prompt,
    response: finalResponse,
    threadId: chatState.threadId,
    project: { id: project.id, name: project.name },
    commands: renderRecipeCommands(recipe, recipeContext(options)),
    safety: recipe.safety,
    frontendUrl,
  };
};

const buildGuideResult = (recipe: Recipe, context: RecipePromptContext) => ({
  recipeId: recipe.id,
  title: recipe.title,
  mode: recipe.mode,
  prompt: renderRecipePrompt(recipe, context),
  commands: renderRecipeCommands(recipe, context),
  inputs: context,
  safety: recipe.safety,
  expectedOutput: recipe.expectedOutput,
  note: "This recipe requires explicit user-run commands for side effects; no project, file, billing, or MCP config mutation was performed.",
});

export const registerRecipesCommand = (
  program: Command,
  deps: RegisterRecipesCommandOptions,
) => {
  const command = program.command("recipes").description("Cloudeval reusable recipes and agent skills");

  command
    .command("list")
    .description("List Cloudeval recipes")
    .option("--format <format>", "Output format: table, text, json, ndjson, markdown", "table")
    .option("--output <file>", "Output file")
    .action((options: CommonRecipeOptions) => writeRecipeList(options));

  command
    .command("show")
    .description("Show a Cloudeval recipe")
    .argument("<id>", "Recipe id")
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "markdown")
    .option("--output <file>", "Output file")
    .action(async (id: string, options: CommonRecipeOptions) => {
      const recipe = getRecipe(id);
      if (!recipe) {
        console.error(`Unknown recipe '${id}'. Run 'cloudeval recipes list' to see available recipes.`);
        process.exit(1);
      }
      await writeRecipeShow(recipe, options);
    });

  addAuthOptions(
    command
      .command("run")
      .description("Run a Cloudeval recipe or print explicit commands for side-effecting recipes")
      .argument("<id>", "Recipe id"),
    deps.defaultBaseUrl,
  )
    .option("--project <id>", "Project ID to use")
    .option("--connection-id <id>", "Connection id for connection recipes")
    .option("--credential-id <id>", "Credential id for credential recipes")
    .option("--range <range>", "Usage/report range such as 7d, 30d, 90d, all", "30d")
    .option("--template-file <path>", "Local JSON template file")
    .option("--template-url <url>", "Template URL")
    .option("--parameters-file <path>", "Local parameters file")
    .option("--parameters-url <url>", "Parameters URL")
    .option("--provider <provider>", "Cloud provider accepted by projects create")
    .option("--name <name>", "Project or recipe display name")
    .option("--output-path <path>", "Side-effect output path for guide recipes")
    .option("--output-dir <path>", "Side-effect output directory for guide recipes")
    .option("--client <name>", "MCP client name for setup recipes")
    .option("--layout <layout>", "Visualization layout such as architecture or dependency")
    .option("--model <name>", "Model name")
    .option("--thread <id>", "Thread id to reuse")
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file")
    .option("--progress <mode>", "Progress events: auto, stderr, ndjson, none", "auto")
    .option("--quiet", "Suppress progress and warning messages", false)
    .option("--frontend-url <url>", "Frontend base URL")
    .action(async (id: string, options: RecipeRunOptions, actionCommand) => {
      const recipe = getRecipe(id);
      if (!recipe) {
        console.error(`Unknown recipe '${id}'. Run 'cloudeval recipes list' to see available recipes.`);
        process.exit(1);
      }
      try {
        const context = recipeContext(options);
        const prompt = renderRecipePrompt(recipe, context);
        const result = recipe.mode === "guide"
          ? buildGuideResult(recipe, context)
          : await runChatRecipe(recipe, prompt, options, actionCommand, deps);
        const frontendUrl = "frontendUrl" in result ? result.frontendUrl : undefined;
        await writeFormattedOutput({
          command: "recipes run",
          data: result,
          format: options.format === "table" ? "text" : options.format,
          output: options.output,
          frontendUrl,
        });
      } catch (error: any) {
        console.error(`Failed to run recipe: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });
};

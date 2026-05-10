import type { Command } from "commander";
import { addAuthOptions, warnIfAccessKeyFromCliOption } from "./authGuard.js";
import {
  getActiveConfigProfile,
  loadCliConfig,
  saveCliConfig,
} from "./cliConfig.js";
import {
  formatTextTable,
  writeFormattedOutput,
  type MachineOutputFormat,
} from "./outputFormatter.js";

interface ModelsDeps {
  defaultBaseUrl: string;
  resolveBaseUrl: (
    options: { baseUrl?: string },
    command?: Command
  ) => Promise<string>;
  readStdinValue: () => Promise<string>;
}

interface ModelListOptions {
  baseUrl?: string;
  accessKey?: string;
  accessKeyStdin?: boolean;
  nonInteractive?: boolean;
  format?: MachineOutputFormat;
  output?: string;
}

const fallbackModels = [
  { id: "gpt-5-nano", name: "GPT-5 Nano", source: "fallback" },
  { id: "gpt-5-mini", name: "GPT-5 Mini", source: "fallback" },
  { id: "gpt-5", name: "GPT-5", source: "fallback" },
];

const normalizeModel = (raw: unknown): Record<string, unknown> | null => {
  if (typeof raw === "string") {
    return { id: raw, name: raw };
  }
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const id = value.id ?? value.name ?? value.model ?? value.slug ?? value.deployment_name;
  if (typeof id !== "string" || !id.trim()) {
    return null;
  }
  return {
    ...value,
    id,
    name: typeof value.name === "string" ? value.name : id,
  };
};

const normalizeModelsPayload = (payload: unknown): Array<Record<string, unknown>> => {
  const list: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as any)?.models)
      ? (payload as any).models
      : Array.isArray((payload as any)?.data)
        ? (payload as any).data
        : Array.isArray((payload as any)?.all)
          ? (payload as any).all
        : [];
  return list.map(normalizeModel).filter((model): model is Record<string, unknown> => Boolean(model));
};

const resolveToken = async (
  options: ModelListOptions,
  deps: ModelsDeps,
  baseUrl: string,
  command?: Command
) => {
  warnIfAccessKeyFromCliOption(options, command);
  if (options.accessKeyStdin) {
    return deps.readStdinValue();
  }
  if (options.accessKey) {
    return options.accessKey;
  }
  try {
    const core = await import("@cloudeval/core");
    return await core.getAuthToken({
      baseUrl,
    });
  } catch {
    return undefined;
  }
};

const modelScalar = (value: unknown, fallback = "-"): string => {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
};

const renderModelsListText = (
  models: Array<Record<string, unknown>>,
  context: { source: string; defaultModel?: string | null }
): string => {
  const table = formatTextTable(
    models.map((model) => ({
      id: modelScalar(model.id),
      name: modelScalar(model.name),
      provider: modelScalar(model.provider),
      availability: modelScalar(model.availability, model.disabled ? "disabled" : "available"),
      category: modelScalar(model.category),
      default: context.defaultModel && context.defaultModel === model.id ? "yes" : "",
    })),
    [
      { key: "id", header: "ID", maxWidth: 28 },
      { key: "name", header: "Name", maxWidth: 28 },
      { key: "provider", header: "Provider", maxWidth: 12 },
      { key: "availability", header: "Availability", maxWidth: 14 },
      { key: "category", header: "Category", maxWidth: 10 },
      { key: "default", header: "Default", width: 7 },
    ],
    { emptyMessage: "No models found." }
  );
  const meta = formatTextTable(
    [
      { field: "Source", value: context.source },
      { field: "Default model", value: context.defaultModel || "-" },
    ],
    [
      { key: "field", header: "Field" },
      { key: "value", header: "Value" },
    ]
  );
  return `${table}\n${meta}`;
};

const writeModelsListOutput = async (input: {
  models: Array<Record<string, unknown>>;
  source: string;
  defaultModel?: string | null;
  options: ModelListOptions;
}) => {
  const format = input.options.format ?? "text";
  if (format === "text") {
    const text = renderModelsListText(input.models, {
      source: input.source,
      defaultModel: input.defaultModel,
    });
    if (input.options.output) {
      const fs = await import("node:fs/promises");
      await fs.writeFile(input.options.output, text, "utf8");
      return;
    }
    process.stdout.write(text);
    return;
  }
  await writeFormattedOutput({
    command: "models list",
    data: {
      models: input.models,
      source: input.source,
      defaultModel: input.defaultModel ?? null,
    },
    format,
    output: input.options.output,
  });
};

export const registerModelsCommand = (program: Command, deps: ModelsDeps) => {
  const models = program.command("models").description("List models and manage the default model");

  addAuthOptions(models.command("list").description("List backend-supported models"), deps.defaultBaseUrl)
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file")
    .action(async (options: ModelListOptions, command) => {
      const baseUrl = await deps.resolveBaseUrl(options, command);
      const token = await resolveToken(options, deps, baseUrl, command);
      let source = "fallback";
      let modelList: Array<Record<string, unknown>> = fallbackModels;
      try {
        const core = await import("@cloudeval/core");
        const response = await fetch(`${core.normalizeApiBase(baseUrl)}/models`, {
          headers: {
            Accept: "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        if (response.ok) {
          const normalized = normalizeModelsPayload(await response.json());
          if (normalized.length) {
            modelList = normalized;
            source = "backend";
          }
        }
      } catch {
        source = "fallback";
      }
      const profile = getActiveConfigProfile(command);
      const config = await loadCliConfig(profile);
      await writeModelsListOutput({
        models: modelList,
        source,
        defaultModel: config.model ?? null,
        options,
      });
    });

  const defaultCommand = models.command("default").description("Manage the default model");

  defaultCommand
    .command("get")
    .description("Show the configured default model")
    .option("--profile <name>", "Configuration profile")
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file")
    .action(async (options: { profile?: string; format?: MachineOutputFormat; output?: string }, command) => {
      const profile = options.profile || getActiveConfigProfile(command);
      const config = await loadCliConfig(profile);
      await writeFormattedOutput({
        command: "models default get",
        data: { profile, model: config.model ?? null },
        format: options.format,
        output: options.output,
      });
    });

  defaultCommand
    .command("set")
    .description("Set the default model")
    .argument("<model>", "Model name")
    .option("--profile <name>", "Configuration profile")
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file")
    .action(async (model: string, options: { profile?: string; format?: MachineOutputFormat; output?: string }, command) => {
      const profile = options.profile || getActiveConfigProfile(command);
      const config = await loadCliConfig(profile);
      const next = { ...config, model };
      const path = await saveCliConfig(next, profile);
      await writeFormattedOutput({
        command: "models default set",
        data: { profile, path, model },
        format: options.format,
        output: options.output,
      });
    });
};

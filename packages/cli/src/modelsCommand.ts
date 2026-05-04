import type { Command } from "commander";
import { addAuthOptions } from "./authGuard.js";
import {
  getActiveConfigProfile,
  loadCliConfig,
  saveCliConfig,
} from "./cliConfig.js";
import {
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
  apiKey?: string;
  apiKeyStdin?: boolean;
  machine?: boolean;
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

const resolveToken = async (options: ModelListOptions, deps: ModelsDeps, baseUrl: string) => {
  if (options.apiKeyStdin) {
    return deps.readStdinValue();
  }
  if (options.apiKey) {
    return options.apiKey;
  }
  try {
    const core = await import("@cloudeval/core");
    return await core.getAuthToken({
      baseUrl,
      allowMachineAuth: !!options.machine,
    });
  } catch {
    return undefined;
  }
};

export const registerModelsCommand = (program: Command, deps: ModelsDeps) => {
  const models = program.command("models").description("List models and manage the default model");

  addAuthOptions(models.command("list").description("List backend-supported models"), deps.defaultBaseUrl)
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file")
    .action(async (options: ModelListOptions, command) => {
      const baseUrl = await deps.resolveBaseUrl(options, command);
      const token = await resolveToken(options, deps, baseUrl);
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
      await writeFormattedOutput({
        command: "models list",
        data: {
          models: modelList,
          source,
          defaultModel: config.model ?? null,
        },
        format: options.format,
        output: options.output,
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

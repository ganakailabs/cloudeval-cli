import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import type { MachineOutputFormat } from "./outputFormatter.js";

export type CliMode = "ask" | "agent";
export type LocalHookEvent =
  | "cli.command.before"
  | "cli.command.after"
  | "cli.command.error"
  | "agent_profile.run.before"
  | "agent_profile.run.after"
  | "agent_profile.run.error";

export interface LocalHookDefinition {
  id: string;
  command: string;
  cwd?: string;
  timeoutSeconds?: number;
  continueOnError?: boolean;
}

export interface LocalHooksConfig {
  enabled?: boolean;
  events?: Partial<Record<LocalHookEvent, LocalHookDefinition[]>>;
}

export interface CliConfig {
  baseUrl?: string;
  frontendUrl?: string;
  defaultProjectId?: string;
  model?: string;
  mode?: CliMode;
  outputFormat?: MachineOutputFormat;
  hooks?: LocalHooksConfig;
}

const CONFIG_PROFILE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SETTINGS_FILE = "settings.json";

export const normalizeConfigProfile = (profile?: string): string => {
  const normalized = (profile || process.env.CLOUDEVAL_PROFILE || "default").trim() || "default";
  if (!CONFIG_PROFILE_PATTERN.test(normalized)) {
    throw new Error(
      `Invalid profile '${normalized}'. Use letters, numbers, dashes, or underscores.`
    );
  }
  return normalized;
};

export const getActiveConfigProfile = (command?: Command): string => {
  const opts =
    typeof command?.optsWithGlobals === "function"
      ? command.optsWithGlobals()
      : command?.opts();
  return normalizeConfigProfile(opts?.profile);
};

export const getCloudevalConfigDir = (): string =>
  path.join(os.homedir(), ".config", "cloudeval");

export const getCliConfigPath = (profile?: string): string => {
  const normalized = normalizeConfigProfile(profile);
  if (normalized === "default") {
    return path.join(getCloudevalConfigDir(), SETTINGS_FILE);
  }
  return path.join(getCloudevalConfigDir(), "profiles", normalized, SETTINGS_FILE);
};

const ensureConfigParent = async (filePath: string) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
};

export const loadCliConfig = async (profile?: string): Promise<CliConfig> => {
  const filePath = getCliConfigPath(profile);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw error;
  }
};

export const saveCliConfig = async (
  config: CliConfig,
  profile?: string
): Promise<string> => {
  const filePath = getCliConfigPath(profile);
  await ensureConfigParent(filePath);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tempPath, filePath);
  return filePath;
};

export const listCliConfigProfiles = async (): Promise<string[]> => {
  const profiles = new Set<string>(["default"]);
  const profilesDir = path.join(getCloudevalConfigDir(), "profiles");
  try {
    const entries = await fs.readdir(profilesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && CONFIG_PROFILE_PATTERN.test(entry.name)) {
        profiles.add(entry.name);
      }
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return [...profiles].sort();
};

const keyAliases: Record<string, keyof CliConfig> = {
  project: "defaultProjectId",
  projectId: "defaultProjectId",
  defaultProject: "defaultProjectId",
  defaultProjectId: "defaultProjectId",
  model: "model",
  mode: "mode",
  chatMode: "mode",
  defaultMode: "mode",
  baseUrl: "baseUrl",
  frontendUrl: "frontendUrl",
  outputFormat: "outputFormat",
  format: "outputFormat",
};

export const normalizeCliMode = (value?: string): CliMode | undefined => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "ask" || normalized === "agent") {
    return normalized;
  }
  throw new Error("mode must be one of: ask, agent");
};

export const normalizeConfigKey = (key: string): keyof CliConfig => {
  const normalized = key.trim();
  const mapped = keyAliases[normalized];
  if (!mapped) {
    throw new Error(
      `Unsupported config key '${key}'. Supported keys: baseUrl, frontendUrl, defaultProjectId, model, mode, outputFormat.`
    );
  }
  return mapped;
};

export const readCliConfigValue = (
  config: CliConfig,
  key: string
): string | undefined => {
  const normalized = normalizeConfigKey(key);
  const value = config[normalized];
  return typeof value === "string" ? value : undefined;
};

export const writeCliConfigValue = (
  config: CliConfig,
  key: string,
  value: string
): CliConfig => {
  const normalized = normalizeConfigKey(key);
  const normalizedValue =
    normalized === "mode" ? normalizeCliMode(value) : value;
  return {
    ...config,
    [normalized]: normalizedValue,
  };
};

export const unsetCliConfigValue = (config: CliConfig, key: string): CliConfig => {
  const normalized = normalizeConfigKey(key);
  const next = { ...config };
  delete next[normalized];
  return next;
};

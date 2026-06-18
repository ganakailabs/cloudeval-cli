import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CliConfig, LocalHookDefinition, LocalHookEvent } from "./cliConfig.js";

export interface LocalHookRunInput {
  event: LocalHookEvent;
  config: CliConfig;
  profile: string;
  commandName: string;
  projectId?: string;
  agentProfileId?: string;
  threadId?: string;
  argv?: string[];
  noHooks?: boolean;
  extra?: Record<string, unknown>;
}

export interface LocalHookWarning {
  hookId: string;
  event: LocalHookEvent;
  message: string;
  exitCode?: number | null;
}

const normalizeHooks = (
  config: CliConfig,
  event: LocalHookEvent
): LocalHookDefinition[] => {
  if (config.hooks?.enabled !== true) {
    return [];
  }
  const hooks = config.hooks.events?.[event];
  return Array.isArray(hooks)
    ? hooks.filter(
        (hook) =>
          hook &&
          typeof hook.id === "string" &&
          typeof hook.command === "string" &&
          hook.id.trim() &&
          hook.command.trim()
      )
    : [];
};

const HOOK_SECRET_ENV_KEY_PATTERN =
  /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|ACCESS_KEY|API_KEY|PRIVATE_KEY|SESSION|COOKIE|AUTH|AZURE_CLIENT_SECRET|CLOUDEVAL_ACCESS_KEY)/i;

export const buildLocalHookBaseEnv = (
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || HOOK_SECRET_ENV_KEY_PATTERN.test(key)) {
      continue;
    }
    env[key] = value;
  }
  return env;
};

const writeHookPayload = async (
  input: LocalHookRunInput,
  hook: LocalHookDefinition
): Promise<string> => {
  const filePath = path.join(
    os.tmpdir(),
    `cloudeval-hook-${process.pid}-${randomUUID()}.json`
  );
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        event: input.event,
        hook: { id: hook.id },
        profile: input.profile,
        command: input.commandName,
        projectId: input.projectId,
        agentProfileId: input.agentProfileId,
        threadId: input.threadId,
        argv: input.argv ?? process.argv.slice(2),
        timestamp: new Date().toISOString(),
        ...(input.extra ? { extra: input.extra } : {}),
      },
      null,
      2
    ),
    { encoding: "utf8", mode: 0o600 }
  );
  return filePath;
};

const runShellHook = async (
  hook: LocalHookDefinition,
  input: LocalHookRunInput,
  payloadPath: string
): Promise<void> => {
  const timeoutSeconds = Number.isFinite(hook.timeoutSeconds)
    ? Math.max(1, Number(hook.timeoutSeconds))
    : 30;
  await new Promise<void>((resolve, reject) => {
    const child = exec(hook.command, {
      cwd: hook.cwd || process.cwd(),
      timeout: timeoutSeconds * 1000,
      env: {
        ...buildLocalHookBaseEnv(),
        CLOUDEVAL_HOOK_EVENT: input.event,
        CLOUDEVAL_HOOK_EVENT_FILE: payloadPath,
        CLOUDEVAL_PROFILE: input.profile,
        CLOUDEVAL_COMMAND: input.commandName,
        ...(input.projectId ? { CLOUDEVAL_PROJECT_ID: input.projectId } : {}),
        ...(input.agentProfileId
          ? { CLOUDEVAL_AGENT_PROFILE_ID: input.agentProfileId }
          : {}),
        ...(input.threadId ? { CLOUDEVAL_THREAD_ID: input.threadId } : {}),
      },
    });
    child.stdout?.on("data", (chunk) => process.stderr.write(String(chunk)));
    child.stderr?.on("data", (chunk) => process.stderr.write(String(chunk)));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code && code !== 0) {
        const error = new Error(`Hook '${hook.id}' exited with code ${code}`);
        (error as Error & { exitCode?: number | null }).exitCode = code;
        reject(error);
        return;
      }
      resolve();
    });
  });
};

export const runLocalHooks = async (
  input: LocalHookRunInput
): Promise<LocalHookWarning[]> => {
  if (input.noHooks) {
    return [];
  }
  const hooks = normalizeHooks(input.config, input.event);
  const warnings: LocalHookWarning[] = [];
  for (const hook of hooks) {
    const payloadPath = await writeHookPayload(input, hook);
    try {
      await runShellHook(hook, input, payloadPath);
    } catch (error: any) {
      const warning = {
        hookId: hook.id,
        event: input.event,
        message: error?.message || `Hook '${hook.id}' failed`,
        exitCode: error?.exitCode ?? null,
      };
      if (!input.event.endsWith(".before") || hook.continueOnError === true) {
        warnings.push(warning);
      } else {
        throw error;
      }
    } finally {
      await fs.rm(payloadPath, { force: true }).catch(() => undefined);
    }
  }
  return warnings;
};

export const writeHookWarnings = (warnings: LocalHookWarning[]): void => {
  for (const warning of warnings) {
    process.stderr.write(
      `Warning: local hook ${warning.hookId} failed for ${warning.event}: ${warning.message}\n`
    );
  }
};

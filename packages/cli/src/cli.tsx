#!/usr/bin/env node
import "./runtime/prepareInk.js";
import React from "react";
import { Command } from "commander";
import { isSensitiveSecretKey, redactSensitiveSecrets } from "@cloudeval/shared";
import type { WriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCompletionScript,
  normalizeCompletionShell,
} from "./shellCompletion.js";
import { completeCliWords } from "./completionEngine.js";
import { registerReportsCommand } from "./reports/reportCommand.js";
import { registerRecipesCommand } from "./recipesCommand.js";
import { getFirstNameForDisplay } from "./ui/userDisplayName.js";
import { registerOpenCommand } from "./openCommand.js";
import { registerProjectsCommand } from "./projectsCommand.js";
import { registerConnectionsCommand } from "./connectionsCommand.js";
import { registerBillingCommands } from "./billingCommand.js";
import { registerCapabilitiesCommand } from "./agentCapabilities.js";
import { registerCredentialsCommand, registerIdentityCommand } from "./credentialsCommand.js";
import { registerAgentsCommand } from "./agentsCommand.js";
import { registerValidateCommand } from "./validateCommand.js";
import { registerRulesCommand } from "./rulesCommand.js";
import { registerConfigCommand } from "./configCommand.js";
import { registerDiagnosticsCommands } from "./diagnosticsCommand.js";
import { registerModelsCommand } from "./modelsCommand.js";
import { registerSessionsCommand } from "./sessionsCommand.js";
import { registerSetupCommand } from "./setupCommand.js";
import { registerMcpCommand } from "./mcpCommand.js";
import { maybeShowUpdateNudge, registerUpdateCommand } from "./updateCommand.js";
import { buildFrontendUrl, openExternalUrl, resolveFrontendBaseUrl } from "./frontendLinks.js";
import {
  setShowSensitiveIds,
  writeFormattedOutput,
  type MachineOutputFormat,
} from "./outputFormatter.js";
import { CLI_VERSION } from "./version.js";
import { getDefaultBaseUrl, shouldUseStoredBaseUrl } from "./baseUrl.js";
import { getActiveConfigProfile, loadCliConfig, normalizeCliMode } from "./cliConfig.js";
import { listSessions, recordSessionTurn, resolveSessionReference } from "./sessionsStore.js";
import {
  createAskProgressWriter,
  normalizeAskProgressMode,
} from "./askProgress.js";
import {
  HITL_REQUIRED_EXIT_CODE,
  promptForHitlResponses,
  summarizeHitlRequest,
} from "./hitlPrompt.js";
import { resolveLoginOnboardingMode } from "./loginOnboardingMode.js";
import { warnIfAccessKeyFromCliOption } from "./authGuard.js";
import { runLocalHooks, writeHookWarnings } from "./localHooks.js";

const DEFAULT_BASE_URL = getDefaultBaseUrl();
const ASK_STREAM_IDLE_TIMEOUT_MS = 90_000;
const LEGACY_API_KEY_MESSAGE =
  "API key auth was renamed in beta. Use --access-key or CLOUDEVAL_ACCESS_KEY.";
const STREAM_OUTPUT_NODES = new Set([
  "generate_response",
  "handle_social_interaction",
  "response_compose",
]);
type CliChatMode = "ask" | "agent";

// Verbose logging utility
let verboseEnabled = false;

const enableCliDebugLogging = () => {
  process.env.CLOUDEVAL_CLI_DEBUG = "1";
};

const redactSensitive = (value: unknown): unknown => redactSensitiveSecrets(value);

const isHeadlessEnvironment = (): boolean =>
  Boolean(process.env.SSH_TTY || process.env.CI || process.env.CLOUDEVAL_HEADLESS_LOGIN);

const assertNoLegacyApiKeyUsage = () => {
  const legacyArg = process.argv
    .slice(2)
    .some((arg) => arg === "--api-key" || arg === "--api-key-stdin" || arg.startsWith("--api-key="));
  if (legacyArg || process.env.CLOUDEVAL_API_KEY) {
    process.stderr.write(`${LEGACY_API_KEY_MESSAGE}\n`);
    process.exit(1);
  }
};

assertNoLegacyApiKeyUsage();

const completionScriptPath = (shell: "bash" | "zsh" | "fish" | "powershell"): string => {
  const home = os.homedir();
  switch (shell) {
    case "bash":
      return path.join(home, ".local", "share", "bash-completion", "completions", "cloudeval");
    case "zsh":
      return path.join(home, ".zsh", "completions", "_cloudeval");
    case "fish":
      return path.join(home, ".config", "fish", "completions", "cloudeval.fish");
    case "powershell":
      return path.join(home, ".config", "powershell", "cloudeval-completion.ps1");
  }
};

const ZSH_FPATH_MARKER = "CloudEval CLI completions";

const ensureZshCompletionFpath = async (): Promise<void> => {
  const zshrc = path.join(os.homedir(), ".zshrc");
  let existing = "";
  try {
    existing = await fs.readFile(zshrc, "utf8");
  } catch {
    existing = "";
  }
  if (existing.includes(ZSH_FPATH_MARKER)) {
    return;
  }
  const snippet = `\n# ${ZSH_FPATH_MARKER}\nfpath=("$HOME/.zsh/completions" $fpath)\n`;
  await fs.appendFile(zshrc, snippet, "utf8");
};

const installCompletionScript = async (
  shell: "bash" | "zsh" | "fish" | "powershell",
  binaryName: string
): Promise<string> => {
  const scriptPath = completionScriptPath(shell);
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(scriptPath, buildCompletionScript(shell, binaryName), "utf8");
  if (shell === "zsh") {
    await ensureZshCompletionFpath();
  }
  return scriptPath;
};

const uninstallCompletionScript = async (
  shell: "bash" | "zsh" | "fish" | "powershell"
): Promise<string> => {
  const scriptPath = completionScriptPath(shell);
  await fs.rm(scriptPath, { force: true });
  return scriptPath;
};

const runInteractiveLoginOnboarding = async (
  baseUrl: string,
  token: string
): Promise<void> => {
  const [{ render }, { Onboarding }] = await Promise.all([
    import("ink"),
    import("./ui/components/Onboarding.js"),
  ]);

  await new Promise<void>((resolve) => {
    let app: { unmount: () => void } | undefined;
    app = render(
      <Onboarding
        baseUrl={baseUrl}
        token={token}
        onComplete={() => {
          app?.unmount();
          resolve();
        }}
      />
    );
  });
};

const readStdinValue = async (): Promise<string> => {
  if (process.stdin.isTTY) {
    throw new Error("No stdin available. Pipe a value into --access-key-stdin.");
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (!value) {
    throw new Error("Received empty stdin input for --access-key-stdin.");
  }
  return value;
};

const truncateProgressText = (value: string, maxLength = 180): string => {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
};

const humanizeStreamNode = (node?: string): string | undefined => {
  if (!node) {
    return undefined;
  }
  return node
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
};

const isOutputRespondingChunk = (chunk: any): boolean =>
  chunk?.type === "responding" &&
  Boolean(chunk.content) &&
  (!chunk.node || STREAM_OUTPUT_NODES.has(chunk.node));

const progressEventFromChunk = (
  chunk: any,
  options: { verbose?: boolean }
): Record<string, unknown> | null => {
  if (!chunk || typeof chunk !== "object") {
    return null;
  }

  if (chunk.type === "thinking") {
    const label =
      chunk.description ||
      chunk.message ||
      (options.verbose ? chunk.content : undefined) ||
      humanizeStreamNode(chunk.node) ||
      "Working";
    const message =
      options.verbose && chunk.node
        ? `${humanizeStreamNode(chunk.node)}: ${label}`
        : label;
    return {
      type: "thinking",
      step: chunk.node,
      node: chunk.node,
      status: chunk.status,
      message: truncateProgressText(String(message)),
    };
  }

  if (chunk.type === "responding" && !isOutputRespondingChunk(chunk)) {
    const label =
      chunk.description ||
      chunk.message ||
      (options.verbose ? chunk.content : undefined) ||
      humanizeStreamNode(chunk.node) ||
      "Processing response";
    return {
      type: "progress",
      step: chunk.node,
      node: chunk.node,
      status: chunk.status,
      message: truncateProgressText(String(label)),
    };
  }

  if (chunk.type === "hitl_request") {
    const firstQuestion = Array.isArray(chunk.questions) ? chunk.questions[0] : undefined;
    return {
      type: "action",
      step: "hitl",
      message: truncateProgressText(firstQuestion?.text || "Human input required"),
    };
  }

  if (chunk.type === "hitl_resume") {
    return {
      type: "action",
      step: "hitl_resume",
      status: chunk.status,
      message: truncateProgressText(chunk.message || "Resuming with supplied input"),
    };
  }

  return null;
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

const normalizeModelEntry = (raw: unknown): Record<string, unknown> | null => {
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
  return { ...value, id, name: typeof value.name === "string" ? value.name : id };
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
  return list
    .map(normalizeModelEntry)
    .filter((model): model is Record<string, unknown> => Boolean(model));
};

const availableModelId = (model: Record<string, unknown>): string | undefined => {
  if (model.disabled === true) {
    return undefined;
  }
  const availability = typeof model.availability === "string" ? model.availability.toLowerCase() : "";
  if (availability && availability !== "available") {
    return undefined;
  }
  return typeof model.id === "string" ? model.id : undefined;
};

const assertModelAvailable = async (input: {
  baseUrl: string;
  authToken?: string;
  model?: string;
  normalizeApiBase: (baseUrl?: string) => string;
}) => {
  if (!input.model) {
    return;
  }
  try {
    const response = await fetch(`${input.normalizeApiBase(input.baseUrl)}/models`, {
      headers: {
        Accept: "application/json",
        ...(input.authToken ? { Authorization: `Bearer ${input.authToken}` } : {}),
      },
    });
    if (!response.ok) {
      return;
    }
    const available = normalizeModelsPayload(await response.json())
      .map(availableModelId)
      .filter((id): id is string => Boolean(id));
    if (!available.length || available.includes(input.model)) {
      return;
    }
    throw new Error(
      `Model '${input.model}' is not available for this backend/account. Available models: ${available.join(", ")}.`
    );
  } catch (error: any) {
    if (error?.message?.startsWith(`Model '${input.model}' is not available`)) {
      throw error;
    }
  }
};

export const setVerbose = (enabled: boolean) => {
  verboseEnabled = enabled;
  if (enabled) {
    enableCliDebugLogging();
  }
};

export const isVerbose = () => verboseEnabled;

export const verboseLog = (message: string, data?: any) => {
  if (verboseEnabled) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [VERBOSE]`;
    if (data !== undefined) {
      // Format data nicely
      try {
        const formatted = JSON.stringify(redactSensitive(data), null, 2);
        console.error(`${prefix} ${message}\n${formatted}`);
      } catch {
        // If JSON.stringify fails, just use console.error with the object
        console.error(`${prefix} ${message}`, redactSensitive(data));
      }
    } else {
      console.error(`${prefix} ${message}`);
    }
  }
};

// Helper to log HTTP requests/responses
export const verboseLogRequest = (method: string, url: string, options?: RequestInit) => {
  if (verboseEnabled) {
    verboseLog(`HTTP ${method} ${url}`, {
      headers: options?.headers ? sanitizeHeaders(options.headers as Record<string, string>) : undefined,
      hasBody: !!options?.body,
      bodySize: options?.body ? (typeof options.body === 'string' ? options.body.length : 'unknown') : undefined,
    });
  }
};

export const verboseLogResponse = (url: string, response: Response, error?: any) => {
  if (verboseEnabled) {
    if (error) {
      verboseLog(`HTTP Response Error for ${url}`, {
        status: response?.status,
        statusText: response?.statusText,
        error: error.message,
        stack: error.stack,
      });
    } else {
      verboseLog(`HTTP Response for ${url}`, {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        headers: Object.fromEntries((response.headers as any).entries()),
      });
    }
  }
};

// Sanitize headers to remove sensitive data
const sanitizeHeaders = (headers: Record<string, string>): Record<string, string> => {
  const sanitized: Record<string, string> = { ...headers };
  for (const key of Object.keys(sanitized)) {
    if (isSensitiveSecretKey(key)) {
      sanitized[key] = "[REDACTED]";
    }
  }
  return sanitized;
};

const program = new Command();

const resolveBaseUrl = async (
  options: { baseUrl?: string },
  command?: Command
): Promise<string> => {
  const configuredBaseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const source =
    typeof command?.getOptionValueSource === "function"
      ? command.getOptionValueSource("baseUrl")
      : undefined;

  if (source && source !== "default") {
    return configuredBaseUrl;
  }
  if (process.env.CLOUDEVAL_BASE_URL) {
    return configuredBaseUrl;
  }

  try {
    const config = await loadCliConfig(getActiveConfigProfile(command));
    if (config.baseUrl) {
      return config.baseUrl;
    }
  } catch (error: any) {
    verboseLog("Ignoring CLI config while resolving base URL", {
      message: error?.message,
    });
  }

  try {
    const { getAuthStatus } = await import("@cloudeval/core");
    const status = await getAuthStatus();
    const storedBaseUrl = status.baseUrl;
    if (storedBaseUrl && shouldUseStoredBaseUrl(storedBaseUrl)) {
      return storedBaseUrl;
    }
    if (storedBaseUrl) {
      verboseLog("Ignoring stored local auth base URL. Use --base-url or CLOUDEVAL_BASE_URL for local backend testing.", {
        storedBaseUrl,
        selectedBaseUrl: configuredBaseUrl,
      });
    }
  } catch {
    // Fall back to the packaged default when no prior auth state exists.
  }

  return configuredBaseUrl;
};

const resolveCliConfig = async (command?: Command) => {
  try {
    return await loadCliConfig(getActiveConfigProfile(command));
  } catch {
    return {};
  }
};

program
  .name("cloudeval")
  .description("CloudEval CLI. Run without arguments to open the Terminal UI; use subcommands for pipeable CLI workflows.")
  .version(CLI_VERSION)
  .addHelpText(
    "after",
    `

Examples:
  cloudeval
  cloudeval tui --tab billing
  cloudeval ask "Summarize project risk" --format json
  cloudeval agent "Find cost and architecture risks" --format json
  cloudeval setup --mode agent --non-interactive
  cloudeval projects create --template-url https://example.com/template.json --format json
  cloudeval projects export-diagram <id> --layout architecture --format png --labels all --output architecture.png
  cloudeval reports download --project <id> --type all --output ./reports
  cloudeval open project <id> --view both --layout dependency --print-url --no-open
  cloudeval capabilities --format json
  cloudeval update --check
`
  )
  .option("--profile <name>", "Configuration profile", process.env.CLOUDEVAL_PROFILE)
  .option("-v, --verbose", "Enable verbose logging", false)
  .option("--show-sensitive-ids", "Show full account/session identifiers in command output", false)
  .hook("preAction", async (thisCommand, actionCommand) => {
    const opts =
      typeof actionCommand.optsWithGlobals === "function"
        ? actionCommand.optsWithGlobals()
        : thisCommand.opts();
    setShowSensitiveIds(Boolean(opts.showSensitiveIds || opts.verbose));
    if (opts.verbose) {
      setVerbose(true);
      verboseLog("Verbose logging enabled");
    }
    await maybeShowUpdateNudge({
      commandName: actionCommand.name(),
      args: process.argv.slice(2),
      options: opts,
    });
  });

program.addHelpCommand(false);

program
  .command("login")
  .description("Authenticate with Cloudeval")
  .option(
    "--base-url <url>",
    "Backend base URL",
    DEFAULT_BASE_URL
  )
  .option("--headless", "Use device-code login flow (for SSH/headless terminals)", false)
  .option("-v, --verbose", "Enable verbose logging", false)
  .action(async (options) => {
    if (options.verbose) {
      setVerbose(true);
      verboseLog("Login command started");
      verboseLog("Base URL:", options.baseUrl);
      verboseLog("Environment CLOUDEVAL_BASE_URL:", process.env.CLOUDEVAL_BASE_URL);
    }

    try {
      const {
        assertSecureBaseUrl,
        checkUserStatus,
        ensurePlaygroundProject,
        login,
      } = await import("@cloudeval/core");
      assertSecureBaseUrl(options.baseUrl);
      const headlessEnvironment = isHeadlessEnvironment();
      const headlessLogin = options.headless || headlessEnvironment;
      const token = await login(options.baseUrl, {
        headless: headlessLogin,
      });
      const userStatus = await checkUserStatus(options.baseUrl, token);
      if (userStatus.user?.id && userStatus.user.email) {
        const shouldRunQuickOnboard = !userStatus.onboardingCompleted;
        if (shouldRunQuickOnboard) {
          const onboardingMode = resolveLoginOnboardingMode({
            headlessRequested: Boolean(options.headless),
            headlessEnvironment,
            stdinIsTTY: process.stdin.isTTY,
            stdoutIsTTY: process.stdout.isTTY,
          });
          if (onboardingMode === "interactive_steps") {
            console.log("Complete CLI onboarding to set up your Playground project.");
            await runInteractiveLoginOnboarding(options.baseUrl, token);
            console.log("✅ Onboarding complete. Playground project ready.");
          } else {
            console.log("Setting up your Playground project...");
            await ensurePlaygroundProject(
              options.baseUrl,
              token,
              {
                id: userStatus.user.id,
                email: userStatus.user.email,
                full_name: userStatus.user.full_name,
                name: userStatus.user.name,
              },
              { forceQuickOnboard: true }
            );
            console.log("✅ Playground project ready.");
          }
        } else {
          await ensurePlaygroundProject(
            options.baseUrl,
            token,
            {
              id: userStatus.user.id,
              email: userStatus.user.email,
              full_name: userStatus.user.full_name,
              name: userStatus.user.name,
            }
          );
        }
      } else {
        verboseLog("Skipping Playground setup because authenticated user details were unavailable");
      }
      console.log("✅ Login successful.");
      process.exit(0);
    } catch (error: any) {
      console.error(`❌ Login failed: ${error?.message || "Unknown error"}`);
      process.exit(1);
    }
  });

program
  .command("logout")
  .description("Log out and clear stored authentication state")
  .option(
    "--base-url <url>",
    "Backend base URL",
    DEFAULT_BASE_URL
  )
  .option("--all-devices", "Revoke sessions on all devices", false)
  .action(async (options) => {
    try {
      const { assertSecureBaseUrl, logout } = await import("@cloudeval/core");
      assertSecureBaseUrl(options.baseUrl);
      const result = await logout({
        baseUrl: options.baseUrl,
        allDevices: options.allDevices,
      });
      if (result.revoked) {
        console.log("✅ Logged out and server session revoked.");
      } else {
        console.log("✅ Logged out locally.");
      }
      process.exit(0);
    } catch (error: any) {
      console.error("❌ Logout failed:", error.message);
      process.exit(1);
    }
  });

const authCommand = program.command("auth").description("Authentication utilities");

authCommand
  .command("status")
  .description("Show current authentication status")
  .option(
    "--base-url <url>",
    "Backend base URL",
    DEFAULT_BASE_URL
  )
  .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
  .option("--show-sensitive-ids", "Show full account/session identifiers in command output", false)
  .option("-v, --verbose", "Enable verbose logging and show full non-token identifiers", false)
  .action(async (options, command) => {
    try {
      const { assertSecureBaseUrl, getAuthStatus } = await import("@cloudeval/core");
      const effectiveBaseUrl = await resolveBaseUrl(options, command);
      assertSecureBaseUrl(effectiveBaseUrl);
      const status = await getAuthStatus(effectiveBaseUrl, { validate: true });

      const accessTokenExpiresAt = status.accessTokenExpiresAt
        ? new Date(status.accessTokenExpiresAt).toISOString()
        : undefined;
      const textData = {
        Authenticated: status.authenticated ? "yes" : "no",
        "Authentication checked": status.validationAttempted ? "yes" : "no",
        "Cached access token": status.accessTokenCached ? "yes" : "no",
        "Refresh token available": status.hasRefreshToken ? "yes" : "no",
        "Storage backend": status.storageBackend,
        ...(status.authError ? { "Auth error": status.authError } : {}),
        "CLI API URL": effectiveBaseUrl,
        ...(accessTokenExpiresAt ? { "Access token expires": accessTokenExpiresAt } : {}),
        ...(status.sessionId ? { "Session ID": status.sessionId } : {}),
        ...(status.accountId ? { "Account ID": status.accountId } : {}),
        ...(status.baseUrl && status.baseUrl !== effectiveBaseUrl
          ? { "Stored auth URL": status.baseUrl }
          : {}),
      };
      const machineData = {
        authenticated: status.authenticated,
        validationAttempted: status.validationAttempted,
        accessTokenCached: status.accessTokenCached,
        hasRefreshToken: status.hasRefreshToken,
        storageBackend: status.storageBackend,
        authError: status.authError,
        cliApiUrl: effectiveBaseUrl,
        accessTokenExpiresAt,
        sessionId: status.sessionId,
        accountId: status.accountId,
        storedAuthUrl: status.baseUrl && status.baseUrl !== effectiveBaseUrl ? status.baseUrl : undefined,
      };
      await writeFormattedOutput({
        command: "auth status",
        data: options.format === "text" || !options.format ? textData : machineData,
        format: options.format as MachineOutputFormat,
      });
    } catch (error: any) {
      console.error(`❌ Failed to fetch auth status: ${error?.message || "Unknown error"}`);
      process.exit(1);
    }
  });

registerReportsCommand(program, {
  defaultBaseUrl: DEFAULT_BASE_URL,
  resolveBaseUrl,
  readStdinValue,
});

registerRecipesCommand(program, {
  defaultBaseUrl: DEFAULT_BASE_URL,
  resolveBaseUrl,
  readStdinValue,
  isHeadlessEnvironment,
});

registerOpenCommand(program, {
  defaultBaseUrl: DEFAULT_BASE_URL,
  resolveBaseUrl,
});

registerProjectsCommand(program, {
  defaultBaseUrl: DEFAULT_BASE_URL,
  resolveBaseUrl,
  readStdinValue,
  isHeadlessEnvironment,
});

registerConnectionsCommand(program, {
  defaultBaseUrl: DEFAULT_BASE_URL,
  resolveBaseUrl,
  readStdinValue,
  isHeadlessEnvironment,
});

registerValidateCommand(program, {
  defaultBaseUrl: DEFAULT_BASE_URL,
  resolveBaseUrl,
  readStdinValue,
  isHeadlessEnvironment,
});

registerRulesCommand(program, {
  defaultBaseUrl: DEFAULT_BASE_URL,
  resolveBaseUrl,
  readStdinValue,
  isHeadlessEnvironment,
});

registerBillingCommands(program, {
  defaultBaseUrl: DEFAULT_BASE_URL,
  resolveBaseUrl,
  readStdinValue,
  isHeadlessEnvironment,
});

registerConfigCommand(program);

registerSetupCommand(program, DEFAULT_BASE_URL);

registerDiagnosticsCommands(program, {
  defaultBaseUrl: DEFAULT_BASE_URL,
  resolveBaseUrl,
});

registerModelsCommand(program, {
  defaultBaseUrl: DEFAULT_BASE_URL,
  resolveBaseUrl,
  readStdinValue,
});

registerSessionsCommand(program);

registerCredentialsCommand(program, {
  defaultBaseUrl: DEFAULT_BASE_URL,
  resolveBaseUrl,
  readStdinValue,
  isHeadlessEnvironment,
});

registerAgentsCommand(program, {
  defaultBaseUrl: DEFAULT_BASE_URL,
  resolveBaseUrl,
  readStdinValue,
  isHeadlessEnvironment,
});

registerIdentityCommand(program, {
  defaultBaseUrl: DEFAULT_BASE_URL,
  resolveBaseUrl,
  readStdinValue,
  isHeadlessEnvironment,
});

registerCapabilitiesCommand(program, {
  defaultBaseUrl: DEFAULT_BASE_URL,
  resolveBaseUrl,
  readStdinValue,
});

registerMcpCommand(program, {
  defaultBaseUrl: DEFAULT_BASE_URL,
  resolveBaseUrl,
});

registerUpdateCommand(program);

program
  .command("__complete")
  .description("Internal completion endpoint")
  .argument("[words...]", "Completion words")
  .action((words: string[] = []) => {
    const candidates = completeCliWords(words);
    for (const candidate of candidates) {
      process.stdout.write(
        `${candidate.value}\t${candidate.kind}\t${candidate.description ?? ""}\n`
      );
    }
  });

const completionCommand = program
  .command("completion")
  .description("Print or install shell completion scripts")
  .argument("[shell]", "Shell to generate completions for: bash, zsh, fish, powershell")
  .option("--bin <name>", "Primary binary name", "cloudeval")
  .action((shellName, options) => {
    const detectedShell = process.env.SHELL?.split("/").pop();
    const shell = normalizeCompletionShell(shellName || detectedShell);
    if (!shell) {
      console.error(
        "Unsupported shell. Usage: cloudeval completion <bash|zsh|fish|powershell>"
      );
      process.exit(1);
    }
    process.stdout.write(buildCompletionScript(shell, options.bin));
  });

completionCommand
  .command("install")
  .description("Install shell completion script to a standard user path")
  .option("--shell <shell>", "Shell: bash|zsh|fish|powershell")
  .option("--bin <name>", "Primary binary name", "cloudeval")
  .action(async (options) => {
    const detectedShell = process.env.SHELL?.split("/").pop();
    const shell = normalizeCompletionShell(options.shell || detectedShell);
    if (!shell) {
      console.error(
        "Unsupported shell. Usage: cloudeval completion install --shell <bash|zsh|fish|powershell>"
      );
      process.exit(1);
    }
    const scriptPath = await installCompletionScript(shell, options.bin);
    process.stdout.write(`Installed ${shell} completion at ${scriptPath}\n`);
  });

completionCommand
  .command("uninstall")
  .description("Remove installed shell completion script")
  .option("--shell <shell>", "Shell: bash|zsh|fish|powershell")
  .action(async (options) => {
    const detectedShell = process.env.SHELL?.split("/").pop();
    const shell = normalizeCompletionShell(options.shell || detectedShell);
    if (!shell) {
      console.error(
        "Unsupported shell. Usage: cloudeval completion uninstall --shell <bash|zsh|fish|powershell>"
      );
      process.exit(1);
    }
    const scriptPath = await uninstallCompletionScript(shell);
    process.stdout.write(`Removed ${shell} completion at ${scriptPath}\n`);
  });

program
  .command("tui")
  .description("Open the CloudEval Terminal UI")
  .option(
    "--base-url <url>",
    "Backend base URL",
    DEFAULT_BASE_URL
  )
  .option("--tab <tab>", "Initial tab: chat, overview, reports, projects, connections, billing, options, help", "chat")
  .option("--project <id>", "Initial project id")
  .option("--frontend-url <url>", "Frontend base URL")
  .option("--mode <mode>", "Initial chat mode: ask, agent")
  .option(
    "--access-key <key>",
    "Access key for automation",
    process.env.CLOUDEVAL_ACCESS_KEY
  )
  .option("--access-key-stdin", "Read access key from stdin (recommended for automation)", false)
  .option("--model <name>", "Model name")
  .option("--debug", "Log raw chunks", false)
  .option("--health-check", "Enable health check (disabled by default)")
  .option("--no-banner", "Disable ASCII banner")
  .option("--animate", "Enable TUI animations")
  .option("--no-anim", "Disable TUI animations")
  .option("-v, --verbose", "Enable verbose logging", false)
  .action(async (options, command) => {
    const { assertSecureBaseUrl } = await import("@cloudeval/core");
    const [{ render }, { App }] = await Promise.all([
      import("ink"),
      import("./ui/App.js"),
    ]);
    const baseUrl = await resolveBaseUrl(options, command);
    assertSecureBaseUrl(baseUrl);
    const cliConfig = await resolveCliConfig(command);
    const initialMode = normalizeCliMode(options.mode ?? cliConfig.mode) ?? "ask";

    let accessKey: string | undefined = options.accessKey;
    if (options.accessKeyStdin) {
      accessKey = await readStdinValue();
    }
    warnIfAccessKeyFromCliOption(options, command);

    if (options.tab && options.tab !== "chat") {
      process.stderr.write(
        `Opening Terminal UI with requested tab '${options.tab}'. Rich non-chat tabs load real API data where supported.\n`
      );
    }

    render(
      <App
        baseUrl={baseUrl}
        accessKey={accessKey}
        conversationId={undefined}
        model={options.model ?? cliConfig.model}
        initialMode={initialMode}
        initialTab={options.tab}
        initialProjectId={options.project ?? cliConfig.defaultProjectId}
        frontendUrl={options.frontendUrl ?? cliConfig.frontendUrl}
        debug={options.debug}
        disableBanner={options.banner === false}
        disableAnim={options.anim === false}
        forceAnim={options.animate === true}
        skipHealthCheck={!options.healthCheck}
      />
    );
  });

program
  .command("chat")
  .description("Start an interactive chat session")
  .option(
    "--base-url <url>",
    "Backend base URL",
    DEFAULT_BASE_URL
  )
  .option(
    "--access-key <key>",
    "Access key for automation",
    process.env.CLOUDEVAL_ACCESS_KEY
  )
  .option("--access-key-stdin", "Read access key from stdin (recommended for automation)", false)
  .option("--conversation <id>", "Conversation/thread id to resume")
  .option("--continue", "Resume the most recent local chat session", false)
  .option("--resume <id-or-title>", "Resume a local chat session by thread id or title")
  .option("--model <name>", "Model name")
  .option("--mode <mode>", "Initial chat mode: ask, agent")
  .option("--debug", "Log raw chunks", false)
  .option("--health-check", "Enable health check (disabled by default)")
  .option("--no-banner", "Disable ASCII banner")
  .option("--animate", "Enable TUI animations")
  .option("--no-anim", "Disable TUI animations")
  .option("-v, --verbose", "Enable verbose logging", false)
  .action(async (options, command) => {
    const { assertSecureBaseUrl } = await import("@cloudeval/core");
    const [{ render }, { App }] = await Promise.all([
      import("ink"),
      import("./ui/App.js"),
    ]);
    const baseUrl = await resolveBaseUrl(options, command);
    assertSecureBaseUrl(baseUrl);
    const selectedProfile = getActiveConfigProfile(command);
    const cliConfig = await resolveCliConfig(command);
    const initialMode = normalizeCliMode(options.mode ?? cliConfig.mode) ?? "ask";

    let accessKey: string | undefined = options.accessKey;
    if (options.accessKeyStdin) {
      accessKey = await readStdinValue();
    }
    warnIfAccessKeyFromCliOption(options, command);

    if (options.verbose) {
      setVerbose(true);
      verboseLog("Chat command started");
      verboseLog("Options:", {
        baseUrl,
        hasAccessKey: !!accessKey,
        conversationId: options.conversation,
        model: options.model ?? cliConfig.model,
        debug: options.debug,
      });
    }
    let conversationId = options.conversation;
    if (!conversationId && options.resume) {
      conversationId = (await resolveSessionReference(options.resume, selectedProfile))?.threadId;
      if (!conversationId) {
        throw new Error(`Session '${options.resume}' was not found.`);
      }
    }
    if (!conversationId && options.continue) {
      conversationId = (await listSessions(1, selectedProfile))[0]?.threadId;
      if (!conversationId) {
        throw new Error("No local sessions are available to continue.");
      }
    }

    render(
      <App
        baseUrl={baseUrl}
        accessKey={accessKey}
        conversationId={conversationId}
        model={options.model ?? cliConfig.model}
        initialMode={initialMode}
        initialProjectId={cliConfig.defaultProjectId}
        frontendUrl={cliConfig.frontendUrl}
        debug={options.debug}
        disableBanner={options.banner === false}
        disableAnim={options.anim === false}
        forceAnim={options.animate === true}
        skipHealthCheck={!options.healthCheck}
      />
    );
  });

program
  .command("ask")
  .alias("agent")
  .description("Ask a single question or run an agent task (non-interactive)")
  .argument("<question...>", "The question to ask")
  .option(
    "--base-url <url>",
    "Backend base URL",
    DEFAULT_BASE_URL
  )
  .option(
    "--access-key <key>",
    "Access key for automation",
    process.env.CLOUDEVAL_ACCESS_KEY
  )
  .option("--access-key-stdin", "Read access key from stdin (recommended for automation)", false)
  .option("--project <id>", "Project ID to use")
  .option("--model <name>", "Model name")
  .option("--thread <id>", "Thread id to reuse")
  .option("--output <file>", "Output file (default: stdout)")
  .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
  .option("--json", "Output as JSON")
  .option("--progress <mode>", "Progress events: auto, stderr, ndjson, none", "auto")
  .option("--quiet", "Suppress progress and warning messages", false)
  .option("--no-color", "Disable colorized progress output")
  .option("--open", "Open the frontend chat thread after completion", false)
  .option("--print-url", "Print the frontend chat thread URL", false)
  .option("--no-open", "Do not launch the browser when a URL is printed")
  .option("--frontend-url <url>", "Frontend base URL")
  .option("--non-interactive", "Disable prompts and browser login", false)
  .option("--debug", "Log raw chunks", false)
  .option("-v, --verbose", "Enable verbose logging", false)
  .option("--no-hooks", "Disable local CLI hooks for this command")
  .action(async (questionParts, options, command) => {
    const question = Array.isArray(questionParts) ? questionParts.join(" ") : String(questionParts);
    const commandName = command.parent?.args?.[0] === "agent" ? "agent" : "ask";
    const selectedMode: CliChatMode = commandName === "agent" ? "agent" : "ask";
    const { assertSecureBaseUrl } = await import("@cloudeval/core");
    const baseUrl = await resolveBaseUrl(options, command);
    assertSecureBaseUrl(baseUrl);
    const selectedProfile = getActiveConfigProfile(command);
    const cliConfig = await resolveCliConfig(command);
    const selectedProjectId = options.project ?? cliConfig.defaultProjectId;
    const selectedModel = options.model ?? cliConfig.model;
    const selectedFrontendUrl = options.frontendUrl ?? cliConfig.frontendUrl;
    const progressMode = normalizeAskProgressMode(options.progress);
    const outputFormat = options.json ? "json" : String(options.format ?? "text").toLowerCase();
    const jsonOutput = outputFormat === "json";
    const ndjsonOutput = outputFormat === "ndjson";
    const streamTextOutput = outputFormat === "text";
    const hooksDisabled = options.hooks === false || options.noHooks === true;

    let providedAccessKey: string | undefined = options.accessKey;
    if (options.accessKeyStdin) {
      providedAccessKey = await readStdinValue();
    }
    if (!options.quiet) {
      warnIfAccessKeyFromCliOption(options, command);
    }

    if (options.verbose) {
      setVerbose(true);
      verboseLog(`${commandName} command started`);
      verboseLog("Question:", question);
      verboseLog("Options:", {
        baseUrl,
        hasAccessKey: !!providedAccessKey,
        project: selectedProjectId,
        model: selectedModel,
        mode: selectedMode,
        output: options.output,
        json: options.json,
        format: options.format,
        debug: options.debug,
      });
    }

    try {
      const fs = await import("node:fs");
      const fsPromises = await import("node:fs/promises");
      const { randomUUID } = await import("node:crypto");
      const core = await import("@cloudeval/core");
      const {
        streamChat,
        reduceChunk,
        getAuthToken,
        getProjects,
        ensurePlaygroundProject,
        checkUserStatus,
        extractEmailFromToken,
        initialChatState,
        normalizeApiBase,
      } = core;

      // Import types - use any to avoid type conflicts for now
      type Project = any;
      type ChatState = any;
      const progressWriter = createAskProgressWriter({
        mode: progressMode,
        format: outputFormat,
        quiet: Boolean(options.quiet),
        output: options.output,
        live: !options.verbose && !options.debug,
      });

      writeHookWarnings(
        await runLocalHooks({
          event: "cli.command.before",
          config: cliConfig,
          profile: selectedProfile,
          commandName,
          projectId: selectedProjectId,
          threadId: options.thread,
          noHooks: hooksDisabled,
        })
      );

      // Get auth token
      verboseLog("Attempting to get authentication token");
      progressWriter.write({
        type: "auth",
        step: "auth",
        message: "Resolving authentication",
      });
      let token = providedAccessKey;
      if (!token) {
        try {
          verboseLog("No access key provided, fetching stored token");
          token = await getAuthToken({
            accessKey: providedAccessKey,
            baseUrl,
          });
          verboseLog("Token retrieved successfully", { hasToken: !!token });
        } catch (error: any) {
          verboseLog("Failed to get auth token:", {
            message: error.message,
            stack: error.stack,
          });
          // If no access key and no stored token, automatically trigger login
          if (
            !providedAccessKey &&
            !options.nonInteractive &&
            process.stdin.isTTY &&
            process.stdout.isTTY &&
            !process.env.CI &&
            error?.message?.includes("No authentication available")
          ) {
              verboseLog("No authentication available, initiating login flow");
            if (!options.quiet) {
              progressWriter.clear();
              console.error("Authentication required. Starting login process...\n");
            }
            try {
              const { login } = await import("@cloudeval/core");
              verboseLog("Calling interactive login", { baseUrl });
              token = await login(baseUrl, {
                headless: isHeadlessEnvironment(),
              });
              verboseLog("Login successful, proceeding with question");
              if (!options.quiet) {
                progressWriter.clear();
                console.error("\nAuthentication successful. Proceeding with your question...\n");
              }
            } catch (loginError: any) {
              verboseLog("Login failed:", {
                message: loginError.message,
                stack: loginError.stack,
              });
              progressWriter.clear();
              console.error(`Login failed: ${loginError.message}`);
              process.exit(1);
            }
          } else {
            verboseLog("Authentication error (not recoverable):", {
              message: error.message,
              hasAccessKey: !!providedAccessKey,
            });
            progressWriter.clear();
            console.error(`Authentication failed: ${error.message}`);
            process.exit(1);
          }
        }
      } else {
        verboseLog("Using provided access key for authentication");
      }

      await assertModelAvailable({
        baseUrl,
        authToken: token,
        model: selectedModel,
        normalizeApiBase,
      });

      // Get project
      verboseLog("Determining project to use");
      progressWriter.write({
        type: "request",
        step: "project",
        message: selectedProjectId ? `Using project ${selectedProjectId}` : "Resolving project",
      });
      let project: Project | undefined;
      let authenticatedUserId: string | undefined;
      if (selectedProjectId) {
        verboseLog("Using provided project ID:", selectedProjectId);
        try {
          const userStatus = await checkUserStatus(baseUrl, token);
          authenticatedUserId = userStatus.user?.id;
        } catch {
          // Best effort; stream scope validation will fail safely if this is wrong.
        }
        // If project ID provided, we'd need to fetch it
        // For now, use a basic project object
        project = {
          id: selectedProjectId,
          name: "Selected Project",
          user_id: authenticatedUserId,
          cloud_provider: "azure",
        };
      } else {
        verboseLog("No project ID provided, attempting to fetch user projects");
        // Try to get user and fetch projects
        try {
          verboseLog("Checking user status", { baseUrl });
          const userStatus = await checkUserStatus(baseUrl, token);
          authenticatedUserId = userStatus.user?.id;
          verboseLog("User status:", {
            hasUser: !!userStatus.user,
            userId: userStatus.user?.id,
            onboardingCompleted: userStatus.onboardingCompleted,
          });
          if (authenticatedUserId) {
            verboseLog("Fetching projects for user", { userId: authenticatedUserId });
            const projects = await getProjects(baseUrl, token, authenticatedUserId);
            verboseLog("Projects fetched:", { count: projects.length, names: projects.map((p: any) => p.name) });
            const playgroundProject = projects.find((p: any) => p.name === "Playground");
            if (playgroundProject) {
              project = playgroundProject;
            } else if (userStatus.user?.email) {
              verboseLog("Playground project missing; running shared onboarding repair");
              project = await ensurePlaygroundProject(baseUrl, token, {
                id: authenticatedUserId,
                email: userStatus.user.email,
                full_name: userStatus.user.full_name,
                name: userStatus.user.name,
              });
            } else {
              project = projects[0] || undefined;
            }
            verboseLog("Selected project:", project ? { id: project.id, name: project.name } : "none");
          }
        } catch (error: any) {
          verboseLog("Failed to fetch projects, using default:", {
            message: error.message,
            stack: error.stack,
          });
          // Fallback to default project
        }

      if (!project) {
          process.stderr.write(
            "No project is available for this account. Run `cloudeval chat` to complete onboarding, then retry."
          );
          process.stderr.write("\n");
          process.exit(1);
        }
      }

      // Get user name from token
      let userName = "You";
      try {
        const email = extractEmailFromToken(token);
        userName = getFirstNameForDisplay({ email: email ?? undefined });
      } catch {
        // Use default
      }

      // Stream the chat response
      const threadId = options.thread ?? randomUUID();
      verboseLog("Starting chat stream", {
        threadId,
        projectId: project.id,
        projectName: project.name,
        model: selectedModel,
      });
      let chatState: ChatState = { ...initialChatState, threadId };
      let responseText = "";
      let emittedTextLength = 0;
      let outputStream: NodeJS.WritableStream = process.stdout;
      let fileOutputStream: WriteStream | null = null;
      let ndjsonOutputStream: WriteStream | null = null;
      const emittedProgressKeys = new Set<string>();

      if (options.debug) {
        console.error(`[${commandName}] Question: ${question}`);
        console.error(`[${commandName}] Project: ${project.id} (${project.name})`);
        console.error(`[${commandName}] Thread ID: ${threadId}`);
      }

      // Set up output stream
      if (streamTextOutput && options.output) {
        fileOutputStream = fs.createWriteStream(options.output, { encoding: "utf-8" });
        outputStream = fileOutputStream;
      }
      if (ndjsonOutput && options.output) {
        ndjsonOutputStream = fs.createWriteStream(options.output, { encoding: "utf-8" });
      }

      const writeAskDataEvent = (event: Record<string, unknown>) => {
        const line = `${JSON.stringify(event)}\n`;
        if (ndjsonOutputStream) {
          ndjsonOutputStream.write(line);
          return;
        }
        process.stdout.write(line);
      };

      const closeOutputStream = async () => {
        const streams = [fileOutputStream, ndjsonOutputStream].filter(
          (stream): stream is WriteStream => Boolean(stream)
        );
        fileOutputStream = null;
        ndjsonOutputStream = null;
        for (const stream of streams) {
          await new Promise<void>((resolve, reject) => {
            stream.once("error", reject);
            stream.end(resolve);
          });
        }
      };

      const writeChunkProgressEvent = (event: Record<string, unknown> | null) => {
        if (!event) {
          return;
        }
        const key = [
          event.type,
          event.step,
          event.status,
          event.message,
        ].join(":");
        if (emittedProgressKeys.has(key)) {
          return;
        }
        emittedProgressKeys.add(key);
        progressWriter.write(event);
      };

      const streamUrl = `${normalizeApiBase(baseUrl)}/chat/stream`;
      const streamSettings = {
        ...(selectedModel ? { model: selectedModel } : {}),
        mode: selectedMode,
      };
      verboseLog("Initiating streamChat", {
        baseUrl,
        streamUrl,
        hasAuthToken: !!token,
        messageLength: question.length,
        threadId,
        userName,
        projectId: project.id,
        projectName: project.name,
        settings: streamSettings,
      });

      const logHeaders: Record<string, string> = {
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
      };
      if (token) {
          logHeaders["Authorization"] = `Bearer [REDACTED]`;
      }

      verboseLogRequest("POST", streamUrl, {
        method: "POST",
        headers: logHeaders,
        hasBody: true,
      } as any);

      const frontendUrl = buildFrontendUrl({
        baseUrl: resolveFrontendBaseUrl({
          frontendUrl: selectedFrontendUrl,
          apiBaseUrl: baseUrl,
        }),
        target: "chat",
        threadId: chatState.threadId,
      });

      try {
        let totalChunkCount = 0;
        let hitlResume: any | undefined;
        while (true) {
          let pendingHitlRequest: any | undefined;
          progressWriter.write({
            type: "request",
            step: hitlResume ? "hitl_resume" : "stream",
            message: hitlResume ? "Resuming with human input" : "Sending chat request",
            threadId,
            projectId: project.id,
          });
          for await (const chunk of streamChat({
            baseUrl,
            authToken: token,
            message: hitlResume ? "" : question,
            threadId,
            user: { id: project.user_id ?? authenticatedUserId ?? "cli-user", name: userName },
            project,
            settings: streamSettings,
            debug: options.debug,
            completeAfterResponse: true,
            responseCompletionGraceMs: 5000,
            streamIdleTimeoutMs: ASK_STREAM_IDLE_TIMEOUT_MS,
            hitlResume,
          })) {
            totalChunkCount++;
            if (options.verbose && totalChunkCount % 10 === 0) {
              verboseLog(`Received ${totalChunkCount} chunks`);
            }
            if (options.debug || options.verbose) {
              verboseLog("Chunk received:", {
                type: chunk.type,
                node: (chunk as any).node,
                hasContent: !!(chunk as any).content,
                contentLength: (chunk as any).content?.length || 0,
              });
            }
            chatState = reduceChunk(chatState, chunk);
            writeChunkProgressEvent(progressEventFromChunk(chunk, { verbose: options.verbose }));

            if (chunk.type === "hitl_request") {
              pendingHitlRequest = chunk;
              if (ndjsonOutput) {
                writeAskDataEvent({
                  type: "hitl_request",
                  threadId,
                  checkpointId: (chunk as any).checkpoint_id,
                  pendingIntentId: (chunk as any).pending_intent_id,
                  questions: (chunk as any).questions ?? [],
                  frontendUrl,
                });
              }
              break;
            }

            // Get the latest assistant message
            const latestMessage = [...chatState.messages]
              .reverse()
              .find((m) => m.role === "assistant");

            if (
              ndjsonOutput &&
              chunk.type === "responding" &&
              chunk.content &&
              (!chunk.node || STREAM_OUTPUT_NODES.has(chunk.node))
            ) {
              writeAskDataEvent({
                type: "chunk",
                content: chunk.content,
                node: chunk.node,
                threadId,
              });
            }

            // Stream responding text in real-time. Some backends send incremental
            // content and others send cumulative assistant content, so derive the
            // emitted delta from reducer state to avoid duplicate stdout.
            if (
              streamTextOutput &&
              chunk.type === "responding" &&
              chunk.content &&
              (!chunk.node || STREAM_OUTPUT_NODES.has(chunk.node))
            ) {
              if (latestMessage?.content) {
                responseText = latestMessage.content;
                const delta = responseText.slice(emittedTextLength);
                if (delta) {
                  progressWriter.clear();
                  if (!responseText.slice(0, emittedTextLength).endsWith(delta)) {
                    outputStream.write(delta);
                  }
                  emittedTextLength = responseText.length;
                }
              }
            }

            // Handle errors
            if (chunk.type === "error") {
              const errorMsg = chunk.message || chunk.description || "Unknown error";
              verboseLog("Error chunk received:", {
                message: errorMsg,
                node: (chunk as any).node,
                status: (chunk as any).status,
                stack: (chunk as any).stacktrace,
              });
              progressWriter.clear();
              if (jsonOutput) {
                // For JSON mode, we'll include error in final output
                responseText = `Error: ${errorMsg}`;
              } else if (ndjsonOutput) {
                writeAskDataEvent({ type: "error", error: { message: errorMsg }, threadId });
              } else {
                // For streaming mode, output error immediately
                outputStream.write(`\nError: ${errorMsg}\n`);
              }
              break;
            }
          }

          if (!pendingHitlRequest) {
            break;
          }

          progressWriter.clear();
          const questions = pendingHitlRequest.questions ?? [];
          const checkpointId = pendingHitlRequest.checkpoint_id ?? chatState.threadId;
          const canPromptForHitl =
            !options.nonInteractive &&
            Boolean(process.stdin.isTTY) &&
            Boolean(process.stderr.isTTY) &&
            questions.length > 0 &&
            Boolean(checkpointId);

          if (!canPromptForHitl) {
            const hitl = {
              checkpointId,
              pendingIntentId: pendingHitlRequest.pending_intent_id,
              runId: pendingHitlRequest.run_id,
              langsmithTraceId: pendingHitlRequest.langsmith_trace_id,
              questions,
            };
            const message = "Human input required by CloudEval.";
            const summary = summarizeHitlRequest({ questions, checkpointId, frontendUrl });
            if (jsonOutput) {
              const output = {
                ok: false,
                command: commandName,
                question,
                error: { code: "HITL_REQUIRED", message },
                data: {
                  threadId: chatState.threadId,
                  project: {
                    id: project.id,
                    name: project.name,
                  },
                  hitl,
                },
                frontendUrl,
              };
              const outputText = JSON.stringify(output, null, 2) + "\n";
              if (options.output) {
                await fsPromises.writeFile(options.output, outputText, "utf-8");
              } else {
                process.stdout.write(outputText);
              }
            } else if (ndjsonOutput) {
              writeAskDataEvent({
                type: "hitl_required",
                ok: false,
                command: commandName,
                error: { code: "HITL_REQUIRED", message },
                data: { threadId: chatState.threadId, project: { id: project.id, name: project.name }, hitl },
                frontendUrl,
              });
              await closeOutputStream();
            } else {
              await closeOutputStream();
              process.stderr.write(summary);
            }
            process.exit(HITL_REQUIRED_EXIT_CODE);
          }

          const responses = await promptForHitlResponses(questions);
          if (responses.length === 0) {
            throw new Error("No HITL response was provided.");
          }
          hitlResume = {
            checkpointId,
            responses,
            runId: pendingHitlRequest.run_id,
            langsmithTraceId: pendingHitlRequest.langsmith_trace_id,
          };
        }

        verboseLog("Stream completed", { totalChunks: totalChunkCount });

        if (streamTextOutput && emittedTextLength > 0) {
          progressWriter.clear();
          outputStream.write("\n");
        }
      } catch (error: any) {
        const errorMsg = error.message || "Streaming failed";
        progressWriter.clear();
        if (jsonOutput) {
          responseText = `Error: ${errorMsg}`;
        } else if (ndjsonOutput) {
          writeAskDataEvent({ type: "error", error: { message: errorMsg }, threadId });
        } else {
          outputStream.write(`\nError: ${errorMsg}\n`);
        }
        await closeOutputStream();
        throw error;
      }

      const finalMessage = [...chatState.messages]
        .reverse()
        .find((m) => m.role === "assistant");
      const finalResponse = collapseRepeatedAssistantText(finalMessage?.content || responseText || "");

      if (!finalResponse.trim()) {
        const noResponseMessage = `No final response returned by CloudEval (last stream status: ${chatState.status ?? "unknown"}). Retry with --verbose or --format ndjson to inspect stream progress.`;
        progressWriter.clear();
        if (jsonOutput) {
          const output = {
            ok: false,
            command: commandName,
            question,
            error: { message: noResponseMessage },
            data: {
              threadId: chatState.threadId,
              project: {
                id: project.id,
                name: project.name,
              },
            },
            frontendUrl,
          };
          const outputText = JSON.stringify(output, null, 2) + "\n";
          if (options.output) {
            await fsPromises.writeFile(options.output, outputText, "utf-8");
          } else {
            process.stdout.write(outputText);
          }
        } else if (ndjsonOutput) {
          writeAskDataEvent({
            type: "error",
            error: { message: noResponseMessage },
            threadId: chatState.threadId,
            frontendUrl,
          });
          await closeOutputStream();
        } else {
          await closeOutputStream();
          process.stderr.write(`Error: ${noResponseMessage}\n`);
        }
        process.exit(1);
      }

      if (streamTextOutput) {
        if (emittedTextLength === 0) {
          outputStream.write(`${finalResponse}\n`);
        }
        await closeOutputStream();
      }

      try {
        await recordSessionTurn({
          threadId: chatState.threadId,
          question,
          response: finalResponse,
          project: {
            id: project.id,
            name: project.name,
          },
          model: selectedModel,
          profile: selectedProfile,
        });
      } catch (error: any) {
        verboseLog("Failed to record local session history", {
          message: error?.message,
        });
      }

      if (jsonOutput) {
        const output = {
          ok: true,
          command: commandName,
          question,
          data: {
            response: finalResponse,
            threadId: chatState.threadId,
            project: {
              id: project.id,
              name: project.name,
            },
          },
          frontendUrl,
        };
        const outputText = JSON.stringify(output, null, 2) + "\n";

        if (options.output) {
          await fsPromises.writeFile(options.output, outputText, "utf-8");
        } else {
          process.stdout.write(outputText);
        }
        if (options.printUrl) {
          process.stderr.write(`${frontendUrl}\n`);
        }
        if (options.open !== false && (options.open || options.printUrl)) {
          await openExternalUrl(frontendUrl);
        }
      }

      if (ndjsonOutput) {
        writeAskDataEvent({
          type: "result",
          ok: true,
          command: commandName,
          data: {
            response: finalResponse,
            threadId: chatState.threadId,
            project: {
              id: project.id,
              name: project.name,
            },
          },
          frontendUrl,
        });
        await closeOutputStream();
      }

      if (outputFormat === "markdown") {
        const outputText = finalResponse ? `${finalResponse}\n` : "";
        if (options.output) {
          await fsPromises.writeFile(options.output, outputText, "utf-8");
        } else {
          process.stdout.write(outputText);
        }
      }

      if (!jsonOutput && !ndjsonOutput && (options.printUrl || options.open)) {
        if (options.printUrl) {
          process.stderr.write(`${frontendUrl}\n`);
        }
        if (options.open !== false) {
          await openExternalUrl(frontendUrl);
        }
      }

      writeHookWarnings(
        await runLocalHooks({
          event: "cli.command.after",
          config: cliConfig,
          profile: selectedProfile,
          commandName,
          projectId: project.id,
          threadId: chatState.threadId,
          noHooks: hooksDisabled,
          extra: { ok: true },
        })
      );

      verboseLog("Command completed successfully");
      process.exit(0);
    } catch (error: any) {
      try {
        writeHookWarnings(
          await runLocalHooks({
            event: "cli.command.error",
            config: cliConfig,
            profile: selectedProfile,
            commandName,
            projectId: selectedProjectId,
            threadId: options.thread,
            noHooks: hooksDisabled,
            extra: { error: error?.message },
          })
        );
      } catch {
        // Keep the original command failure visible.
      }
      verboseLog("Command failed with error:", {
        message: error.message,
        stack: error.stack,
        name: error.name,
        cause: error.cause,
      });
      console.error("Error:", error.message);
      if (options.debug || options.verbose) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

program
  .command("banner")
  .description("Preview the startup banner and terminal capabilities")
  .action(async () => {
    const { render } = await import("ink");
    const BannerPreview = React.lazy(async () => ({
      default: (await import("./ui/components/Banner")).Banner,
    }));
    render(
      <React.Suspense fallback={null}>
        <BannerPreview disable={false} />
      </React.Suspense>
    );
  });

const argv = !process.argv.slice(2).length
  ? ["node", "cloudeval", "tui", ...process.argv.slice(2)]
  : process.argv;

void program.parseAsync(argv).catch((error: Error) => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});

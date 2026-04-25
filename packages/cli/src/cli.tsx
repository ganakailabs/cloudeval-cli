#!/usr/bin/env node
import "./runtime/prepareInk.js";
import React from "react";
import { Command } from "commander";
import type { WriteStream } from "node:fs";
import {
  buildCompletionScript,
  normalizeCompletionShell,
} from "./shellCompletion.js";
import { registerReportsCommand } from "./reports/reportCommand.js";
import { getFirstNameForDisplay } from "./ui/userDisplayName.js";
import { registerOpenCommand } from "./openCommand.js";
import { registerProjectsCommand } from "./projectsCommand.js";
import { registerConnectionsCommand } from "./connectionsCommand.js";
import { registerBillingCommands } from "./billingCommand.js";
import { registerCapabilitiesCommand } from "./agentCapabilities.js";
import { buildFrontendUrl, openExternalUrl, resolveFrontendBaseUrl } from "./frontendLinks.js";

const DEFAULT_BASE_URL = process.env.CLOUDEVAL_BASE_URL ?? "https://cloudeval.ai/api/v1";
const SENSITIVE_KEY_PATTERN = /token|authorization|cookie|secret|password|api[_-]?key/i;
const STREAM_OUTPUT_NODES = new Set([
  "generate_response",
  "handle_social_interaction",
  "response_compose",
]);

// Verbose logging utility
let verboseEnabled = false;

const redactSensitive = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item));
  }
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      redacted[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? "[REDACTED]"
        : redactSensitive(item);
    }
    return redacted;
  }
  return value;
};

const isHeadlessEnvironment = (): boolean =>
  Boolean(process.env.SSH_TTY || process.env.CI || process.env.CLOUDEVAL_HEADLESS_LOGIN);

const readStdinValue = async (): Promise<string> => {
  if (process.stdin.isTTY) {
    throw new Error("No stdin available. Pipe a value into --api-key-stdin.");
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (!value) {
    throw new Error("Received empty stdin input for --api-key-stdin.");
  }
  return value;
};

export const setVerbose = (enabled: boolean) => {
  verboseEnabled = enabled;
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
    if (SENSITIVE_KEY_PATTERN.test(key)) {
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
    const { getAuthStatus } = await import("@cloudeval/core");
    const status = await getAuthStatus();
    if (status.baseUrl) {
      return status.baseUrl;
    }
  } catch {
    // Fall back to the packaged default when no prior auth state exists.
  }

  return configuredBaseUrl;
};

program
  .name("cloudeval")
  .description("CloudEval CLI. Run without arguments to open the Terminal UI; use subcommands for pipeable CLI workflows.")
  .version("0.1.0")
  .addHelpText(
    "after",
    `

Examples:
  cloudeval
  cloudeval tui --tab billing
  cloudeval ask "Summarize project risk" --format json
  cloudeval projects create --template-url https://example.com/template.json --format json
  cloudeval reports download --project <id> --type all --output ./reports
  cloudeval open project <id> --view both --layout dependency --print-url --no-open
  cloudeval capabilities --format json
`
  )
  .option("-v, --verbose", "Enable verbose logging", false)
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.verbose) {
      setVerbose(true);
      verboseLog("Verbose logging enabled");
    }
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
      const { assertSecureBaseUrl, login } = await import("@cloudeval/core");
      assertSecureBaseUrl(options.baseUrl);
      await login(options.baseUrl, {
        headless: options.headless || isHeadlessEnvironment(),
      });
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
  .action(async (options) => {
    try {
      const { assertSecureBaseUrl, getAuthStatus } = await import("@cloudeval/core");
      assertSecureBaseUrl(options.baseUrl);
      const status = await getAuthStatus(options.baseUrl);

      console.log(`Authenticated: ${status.authenticated ? "yes" : "no"}`);
      console.log(`Cached access token: ${status.accessTokenCached ? "yes" : "no"}`);
      console.log(`Refresh token available: ${status.hasRefreshToken ? "yes" : "no"}`);
      console.log(`Storage backend: ${status.storageBackend}`);
      if (status.accessTokenExpiresAt) {
        console.log(`Access token expires: ${new Date(status.accessTokenExpiresAt).toISOString()}`);
      }
      if (status.sessionId) {
        console.log(`Session ID: ${status.sessionId}`);
      }
      if (status.accountId) {
        console.log(`Account ID: ${status.accountId}`);
      }
      if (status.baseUrl) {
        console.log(`Base URL: ${status.baseUrl}`);
      }
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

registerBillingCommands(program, {
  defaultBaseUrl: DEFAULT_BASE_URL,
  resolveBaseUrl,
  readStdinValue,
  isHeadlessEnvironment,
});

registerCapabilitiesCommand(program);

program
  .command("completion")
  .description("Print a shell completion script for bash, zsh, or fish")
  .argument("[shell]", "Shell to generate completions for: bash, zsh, fish")
  .option("--bin <name>", "Primary binary name", "cloudeval")
  .action((shellName, options) => {
    const detectedShell = process.env.SHELL?.split("/").pop();
    const shell = normalizeCompletionShell(shellName || detectedShell);
    if (!shell) {
      console.error(
        "Unsupported shell. Usage: cloudeval completion <bash|zsh|fish>"
      );
      process.exit(1);
    }

    process.stdout.write(buildCompletionScript(shell, options.bin));
  });

program
  .command("tui")
  .description("Open the CloudEval Terminal UI")
  .option(
    "--base-url <url>",
    "Backend base URL",
    DEFAULT_BASE_URL
  )
  .option("--tab <tab>", "Initial tab: chat, overview, reports, projects, connections, billing, options", "chat")
  .option("--project <id>", "Initial project id")
  .option("--frontend-url <url>", "Frontend base URL")
  .option(
    "--api-key <key>",
    "API key (machine workflows only; deprecated for interactive human auth)",
    process.env.CLOUDEVAL_API_KEY
  )
  .option("--api-key-stdin", "Read API key from stdin (recommended for automation)", false)
  .option("--machine", "Allow machine credential fallback (service principal)", false)
  .option("--model <name>", "Model name")
  .option("--debug", "Log raw chunks", false)
  .option("--health-check", "Enable health check (disabled by default)")
  .option("--no-banner", "Disable ASCII banner")
  .option("--no-anim", "Disable loader animation")
  .option("-v, --verbose", "Enable verbose logging", false)
  .action(async (options, command) => {
    const { assertSecureBaseUrl } = await import("@cloudeval/core");
    const [{ render }, { App }] = await Promise.all([
      import("ink"),
      import("./ui/App.js"),
    ]);
    const baseUrl = await resolveBaseUrl(options, command);
    assertSecureBaseUrl(baseUrl);

    let apiKey: string | undefined = options.apiKey;
    if (options.apiKeyStdin) {
      apiKey = await readStdinValue();
    }

    if (options.tab && options.tab !== "chat") {
      process.stderr.write(
        `Opening Terminal UI with requested tab '${options.tab}'. Rich non-chat tabs load real API data where supported.\n`
      );
    }

    render(
      <App
        baseUrl={baseUrl}
        apiKey={apiKey}
        allowMachineAuth={!!options.machine}
        conversationId={undefined}
        model={options.model}
        initialTab={options.tab}
        initialProjectId={options.project}
        frontendUrl={options.frontendUrl}
        debug={options.debug}
        disableBanner={options.banner === false}
        disableAnim={options.anim === false}
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
    "--api-key <key>",
    "API key (machine workflows only; deprecated for interactive human auth)",
    process.env.CLOUDEVAL_API_KEY
  )
  .option("--api-key-stdin", "Read API key from stdin (recommended for automation)", false)
  .option("--machine", "Allow machine credential fallback (service principal)", false)
  .option("--conversation <id>", "Conversation/thread id to resume")
  .option("--model <name>", "Model name")
  .option("--debug", "Log raw chunks", false)
  .option("--health-check", "Enable health check (disabled by default)")
  .option("--no-banner", "Disable ASCII banner")
  .option("--no-anim", "Disable loader animation")
  .option("-v, --verbose", "Enable verbose logging", false)
  .action(async (options, command) => {
    const { assertSecureBaseUrl } = await import("@cloudeval/core");
    const [{ render }, { App }] = await Promise.all([
      import("ink"),
      import("./ui/App.js"),
    ]);
    const baseUrl = await resolveBaseUrl(options, command);
    assertSecureBaseUrl(baseUrl);

    let apiKey: string | undefined = options.apiKey;
    if (options.apiKeyStdin) {
      apiKey = await readStdinValue();
    }
    if (options.apiKey) {
      console.warn(
        "Warning: --api-key can leak via shell history/process listing. Prefer --api-key-stdin."
      );
    }

    if (options.verbose) {
      setVerbose(true);
      verboseLog("Chat command started");
      verboseLog("Options:", {
        baseUrl,
        hasApiKey: !!apiKey,
        machineMode: options.machine,
        conversationId: options.conversation,
        model: options.model,
        debug: options.debug,
      });
    }
    render(
      <App
        baseUrl={baseUrl}
        apiKey={apiKey}
        allowMachineAuth={!!options.machine}
        conversationId={options.conversation}
        model={options.model}
        debug={options.debug}
        disableBanner={options.banner === false}
        disableAnim={options.anim === false}
        skipHealthCheck={!options.healthCheck}
      />
    );
  });

program
  .command("ask")
  .description("Ask a single question (non-interactive)")
  .argument("<question>", "The question to ask")
  .option(
    "--base-url <url>",
    "Backend base URL",
    DEFAULT_BASE_URL
  )
  .option(
    "--api-key <key>",
    "API key (machine workflows only; deprecated for interactive human auth)",
    process.env.CLOUDEVAL_API_KEY
  )
  .option("--api-key-stdin", "Read API key from stdin (recommended for automation)", false)
  .option("--machine", "Allow machine credential fallback (service principal)", false)
  .option("--project <id>", "Project ID to use")
  .option("--model <name>", "Model name")
  .option("--output <file>", "Output file (default: stdout)")
  .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
  .option("--json", "Output as JSON")
  .option("--open", "Open the frontend chat thread after completion", false)
  .option("--print-url", "Print the frontend chat thread URL", false)
  .option("--no-open", "Do not launch the browser when a URL is printed")
  .option("--frontend-url <url>", "Frontend base URL")
  .option("--non-interactive", "Disable prompts and browser login", false)
  .option("--debug", "Log raw chunks", false)
  .option("-v, --verbose", "Enable verbose logging", false)
  .action(async (question, options, command) => {
    const { assertSecureBaseUrl } = await import("@cloudeval/core");
    const baseUrl = await resolveBaseUrl(options, command);
    assertSecureBaseUrl(baseUrl);

    let providedApiKey: string | undefined = options.apiKey;
    if (options.apiKeyStdin) {
      providedApiKey = await readStdinValue();
    }
    if (options.apiKey) {
      console.warn(
        "Warning: --api-key can leak via shell history/process listing. Prefer --api-key-stdin."
      );
    }

    if (options.verbose) {
      setVerbose(true);
      verboseLog("Ask command started");
      verboseLog("Question:", question);
      verboseLog("Options:", {
        baseUrl,
        hasApiKey: !!providedApiKey,
        machineMode: options.machine,
        project: options.project,
        model: options.model,
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
      const jsonOutput = options.json || options.format === "json";

      // Get auth token
      verboseLog("Attempting to get authentication token");
      let token = providedApiKey;
      if (!token) {
        try {
          verboseLog("No API key provided, fetching stored token");
          token = await getAuthToken({
            apiKey: providedApiKey,
            baseUrl,
            allowMachineAuth: !!options.machine,
          });
          verboseLog("Token retrieved successfully", { hasToken: !!token });
        } catch (error: any) {
          verboseLog("Failed to get auth token:", {
            message: error.message,
            stack: error.stack,
          });
          // If no API key and no stored token, automatically trigger login
          if (
            !providedApiKey &&
            !options.machine &&
            !options.nonInteractive &&
            process.stdin.isTTY &&
            process.stdout.isTTY &&
            !process.env.CI &&
            error?.message?.includes("No authentication available")
          ) {
            verboseLog("No authentication available, initiating login flow");
            console.error("Authentication required. Starting login process...\n");
            try {
              const { login } = await import("@cloudeval/core");
              verboseLog("Calling interactive login", { baseUrl });
              token = await login(baseUrl, {
                headless: isHeadlessEnvironment(),
              });
              verboseLog("Login successful, proceeding with question");
              console.error("\nAuthentication successful. Proceeding with your question...\n");
            } catch (loginError: any) {
              verboseLog("Login failed:", {
                message: loginError.message,
                stack: loginError.stack,
              });
              console.error(`❌ Login failed: ${loginError.message}`);
              process.exit(1);
            }
          } else {
            verboseLog("Authentication error (not recoverable):", {
              message: error.message,
              hasApiKey: !!providedApiKey,
            });
            console.error(`❌ Authentication failed: ${error.message}`);
            process.exit(1);
          }
        }
      } else {
        verboseLog("Using provided API key for authentication");
      }

      // Get project
      verboseLog("Determining project to use");
      let project: Project | undefined;
      let authenticatedUserId: string | undefined;
      if (options.project) {
        verboseLog("Using provided project ID:", options.project);
        try {
          const userStatus = await checkUserStatus(baseUrl, token);
          authenticatedUserId = userStatus.user?.id;
        } catch {
          // Best effort; stream scope validation will fail safely if this is wrong.
        }
        // If project ID provided, we'd need to fetch it
        // For now, use a basic project object
        project = {
          id: options.project,
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
          console.error(
            "No project is available for this account. Run `cloudeval chat` to complete onboarding, then retry."
          );
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
      const threadId = randomUUID();
      verboseLog("Starting chat stream", {
        threadId,
        projectId: project.id,
        projectName: project.name,
        model: options.model,
      });
      let chatState: ChatState = { ...initialChatState, threadId };
      let responseText = "";
      let outputStream: NodeJS.WritableStream = process.stdout;
      let fileOutputStream: WriteStream | null = null;

      if (options.debug) {
        console.error(`[ask] Question: ${question}`);
        console.error(`[ask] Project: ${project.id} (${project.name})`);
        console.error(`[ask] Thread ID: ${threadId}`);
      }

      // Set up output stream
      if (!jsonOutput && options.output) {
        fileOutputStream = fs.createWriteStream(options.output, { encoding: "utf-8" });
        outputStream = fileOutputStream;
      }

      const closeOutputStream = async () => {
        if (!fileOutputStream) {
          return;
        }

        const stream = fileOutputStream;
        fileOutputStream = null;

        await new Promise<void>((resolve, reject) => {
          stream.once("error", reject);
          stream.end(resolve);
        });
      };

      const streamUrl = `${normalizeApiBase(baseUrl)}/chat/stream`;
      verboseLog("Initiating streamChat", {
        baseUrl,
        streamUrl,
        hasAuthToken: !!token,
        messageLength: question.length,
        threadId,
        userName,
        projectId: project.id,
        projectName: project.name,
        settings: options.model ? { model: options.model } : undefined,
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

      try {
        let chunkCount = 0;
        for await (const chunk of streamChat({
          baseUrl,
          authToken: token,
          message: question,
          threadId,
          user: { id: project.user_id ?? authenticatedUserId ?? "cli-user", name: userName },
          project,
          settings: options.model ? { model: options.model } : undefined,
          debug: options.debug,
          completeAfterResponse: true,
          responseCompletionGraceMs: 5000,
        })) {
          chunkCount++;
          if (options.verbose && chunkCount % 10 === 0) {
            verboseLog(`Received ${chunkCount} chunks`);
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

          // Get the latest assistant message
          const latestMessage = [...chatState.messages]
            .reverse()
            .find((m) => m.role === "assistant");

          // Stream responding chunks in real-time (for non-JSON mode)
          // chunk.content is incremental (just the new part), so output it directly
          if (
            !jsonOutput &&
            chunk.type === "responding" &&
            chunk.content &&
            (!chunk.node || STREAM_OUTPUT_NODES.has(chunk.node))
          ) {
            // Output the incremental content directly
            outputStream.write(chunk.content);
            // Track cumulative content for final output
            if (latestMessage?.content) {
              responseText = latestMessage.content;
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
            if (jsonOutput) {
              // For JSON mode, we'll include error in final output
              responseText = `Error: ${errorMsg}`;
            } else {
              // For streaming mode, output error immediately
              outputStream.write(`\n❌ Error: ${errorMsg}\n`);
            }
            break;
          }
        }

        verboseLog("Stream completed", { totalChunks: chunkCount });

        // Cleanup (no thinking steps for ask command)

        // Ensure we output everything (in case we missed some content)
        if (!jsonOutput) {
          // Add newline at the end for non-JSON output
          outputStream.write("\n");
          await closeOutputStream();
        }
      } catch (error: any) {
        const errorMsg = error.message || "Streaming failed";
        if (jsonOutput) {
          responseText = `Error: ${errorMsg}`;
        } else {
          outputStream.write(`\n❌ Error: ${errorMsg}\n`);
        }
        await closeOutputStream();
        throw error;
      }

      // For JSON mode, output the complete response as JSON
      if (jsonOutput) {
        const finalMessage = [...chatState.messages]
          .reverse()
          .find((m) => m.role === "assistant");

        const finalResponse = finalMessage?.content || responseText || "";
        const frontendUrl = buildFrontendUrl({
          baseUrl: resolveFrontendBaseUrl({
            frontendUrl: options.frontendUrl,
            apiBaseUrl: baseUrl,
          }),
          target: "chat",
          threadId: chatState.threadId,
        });
        const output = {
          ok: true,
          command: "ask",
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

      if (!jsonOutput && (options.printUrl || options.open)) {
        const frontendUrl = buildFrontendUrl({
          baseUrl: resolveFrontendBaseUrl({
            frontendUrl: options.frontendUrl,
            apiBaseUrl: baseUrl,
          }),
          target: "chat",
          threadId: chatState.threadId,
        });
        if (options.printUrl) {
          process.stderr.write(`${frontendUrl}\n`);
        }
        if (options.open !== false) {
          await openExternalUrl(frontendUrl);
        }
      }

      verboseLog("Command completed successfully");
      process.exit(0);
    } catch (error: any) {
      verboseLog("Command failed with error:", {
        message: error.message,
        stack: error.stack,
        name: error.name,
        cause: error.cause,
      });
      console.error("❌ Error:", error.message);
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

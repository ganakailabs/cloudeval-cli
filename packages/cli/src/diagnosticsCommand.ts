import type { Command } from "commander";
import { getActiveConfigProfile, getCliConfigPath, loadCliConfig } from "./cliConfig.js";
import {
  writeFormattedOutput,
  type MachineOutputFormat,
} from "./outputFormatter.js";
import { getMcpDoctorChecks } from "./mcpCommand.js";

interface DiagnosticsDeps {
  defaultBaseUrl: string;
  resolveBaseUrl: (
    options: { baseUrl?: string },
    command?: Command
  ) => Promise<string>;
}

interface DiagnosticsOptions {
  baseUrl?: string;
  format?: MachineOutputFormat;
  deep?: boolean;
  mcp?: boolean;
}

type CheckStatus = "pass" | "warn" | "fail";

interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

const addDiagnosticsOptions = <T extends Command>(command: T, defaultBaseUrl: string): T =>
  command
    .option("--base-url <url>", "Backend base URL", defaultBaseUrl)
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text") as T;

const nodeMajor = (): number => Number(process.versions.node.split(".")[0] ?? 0);

const formatChecksText = (checks: DoctorCheck[]): Array<Record<string, string>> =>
  checks.map((check) => ({
    status: check.status,
    id: check.id,
    detail: check.detail ?? check.label,
  }));

const summarizeConfig = (config: Record<string, unknown>): string => {
  const keys = Object.keys(config);
  if (!keys.length) {
    return "empty";
  }
  const selected = [
    typeof config.baseUrl === "string" ? `baseUrl=${config.baseUrl}` : undefined,
    typeof config.frontendUrl === "string" ? `frontendUrl=${config.frontendUrl}` : undefined,
    typeof config.defaultProjectId === "string"
      ? `project=${config.defaultProjectId}`
      : undefined,
    typeof config.model === "string" ? `model=${config.model}` : undefined,
  ].filter(Boolean);
  return selected.length ? selected.join(", ") : `${keys.length} setting${keys.length === 1 ? "" : "s"}`;
};

const formatDiagnosticStatusText = ({
  profile,
  baseUrl,
  configPath,
  config,
  auth,
  node,
}: {
  profile: string;
  baseUrl: string;
  configPath: string;
  config: Record<string, unknown>;
  auth: Record<string, any>;
  node: string;
}): string => {
  const accessTokenExpiresAt = auth.accessTokenExpiresAt
    ? new Date(auth.accessTokenExpiresAt).toISOString()
    : undefined;
  const lines = [
    "CloudEval CLI Status",
    `Profile: ${profile}`,
    `Base URL: ${baseUrl}`,
    `Config path: ${configPath}`,
    `Config: ${summarizeConfig(config)}`,
    `Node: ${node}`,
    `Auth: ${auth.authenticated ? "signed in" : "signed out"}`,
    `Auth checked: ${auth.validationAttempted ? "yes" : "no"}`,
    `Cached access token: ${auth.accessTokenCached ? "yes" : "no"}`,
    `Refresh token: ${auth.hasRefreshToken ? "available" : "missing"}`,
    `Storage: ${auth.storageBackend ?? "unknown"}`,
  ];
  if (auth.authError) {
    lines.push(`Auth error: ${auth.authError}`);
  }
  if (accessTokenExpiresAt) {
    lines.push(`Access token expires: ${accessTokenExpiresAt}`);
  }
  if (auth.sessionId) {
    lines.push(`Session ID: ${auth.sessionId}`);
  }
  if (auth.accountId) {
    lines.push(`Account ID: ${auth.accountId}`);
  }
  if (auth.baseUrl && auth.baseUrl !== baseUrl) {
    lines.push(`Stored auth URL: ${auth.baseUrl}`);
  }
  return `${lines.join("\n")}\n`;
};

export const registerDiagnosticsCommands = (
  program: Command,
  deps: DiagnosticsDeps
) => {
  addDiagnosticsOptions(
    program.command("status").description("Show CloudEval CLI status"),
    deps.defaultBaseUrl
  ).action(async (options: DiagnosticsOptions, command) => {
    const baseUrl = await deps.resolveBaseUrl(options, command);
    const profile = getActiveConfigProfile(command);
    const config = await loadCliConfig(profile);
    const core = await import("@cloudeval/core");
    const auth = await core.getAuthStatus(baseUrl, { validate: true });
    if (options.format === "text" || !options.format) {
      process.stdout.write(
        formatDiagnosticStatusText({
          profile,
          baseUrl,
          configPath: getCliConfigPath(profile),
          config: config as Record<string, unknown>,
          auth: auth as Record<string, any>,
          node: process.versions.node,
        })
      );
      return;
    }
    await writeFormattedOutput({
      command: "status",
      data: {
        profile,
        baseUrl,
        configPath: getCliConfigPath(profile),
        config,
        auth,
        node: process.versions.node,
      },
      format: options.format,
    });
  });

  addDiagnosticsOptions(
    program.command("doctor").description("Diagnose local CLI configuration and environment"),
    deps.defaultBaseUrl
  )
    .option("--deep", "Check backend reachability as well as local setup", false)
    .option("--mcp", "Check local MCP server metadata and discovery surface", false)
    .action(async (options: DiagnosticsOptions, command) => {
      const baseUrl = await deps.resolveBaseUrl(options, command);
      const profile = getActiveConfigProfile(command);
      const config = await loadCliConfig(profile);
      const checks: DoctorCheck[] = [];

      checks.push({
        id: "node-version",
        label: "Node.js version",
        status: nodeMajor() >= 20 ? "pass" : "fail",
        detail: process.versions.node,
      });
      checks.push({
        id: "config-readable",
        label: "Config profile is readable",
        status: "pass",
        detail: getCliConfigPath(profile),
      });

      try {
        const core = await import("@cloudeval/core");
        core.assertSecureBaseUrl(baseUrl);
        checks.push({
          id: "base-url-secure",
          label: "Backend URL is HTTPS or localhost HTTP",
          status: "pass",
          detail: baseUrl,
        });
        const auth = await core.getAuthStatus(baseUrl);
        checks.push({
          id: "auth-storage",
          label: "Auth storage backend",
          status: auth.storageBackend === "memory" ? "warn" : "pass",
          detail: auth.storageBackend,
        });
      } catch (error: any) {
        checks.push({
          id: "base-url-secure",
          label: "Backend URL is HTTPS or localhost HTTP",
          status: "fail",
          detail: error?.message ?? String(error),
        });
      }

      if (options.deep) {
        try {
          const response = await fetch(baseUrl.replace(/\/$/, ""));
          checks.push({
            id: "backend-reachable",
            label: "Backend is reachable",
            status: response.status < 500 ? "pass" : "warn",
            detail: `${response.status} ${response.statusText}`,
          });
        } catch (error: any) {
          checks.push({
            id: "backend-reachable",
            label: "Backend is reachable",
            status: "warn",
            detail: error?.message ?? String(error),
          });
        }
      }

      const mcp = options.mcp ? getMcpDoctorChecks() : undefined;
      if (mcp) {
        checks.push(...mcp.checks);
      }

      const ok = checks.every((check) => check.status !== "fail");
      await writeFormattedOutput({
        command: "doctor",
        data:
          options.format === "text" || !options.format
            ? {
                ok,
                checks: formatChecksText(checks),
                profile,
                config,
                ...(mcp?.status ? { mcp: mcp.status } : {}),
              }
            : { ok, checks, profile, config, mcp: mcp?.status },
        format: options.format,
      });
      if (!ok && options.format !== "json" && options.format !== "ndjson") {
        process.exitCode = 1;
      }
    });
};

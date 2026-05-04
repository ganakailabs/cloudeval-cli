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
            ? { ok, checks: formatChecksText(checks), profile, config, mcp: mcp?.status }
            : { ok, checks, profile, config, mcp: mcp?.status },
        format: options.format,
      });
      if (!ok && options.format !== "json" && options.format !== "ndjson") {
        process.exitCode = 1;
      }
    });
};

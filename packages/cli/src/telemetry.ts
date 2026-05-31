import os from "node:os";
import { createHash } from "node:crypto";
import type { CliConfig } from "./cliConfig.js";
import { CLI_VERSION } from "./version.js";
import { PACKAGED_APPLICATIONINSIGHTS_CONNECTION_STRING } from "./telemetryConnectionString.generated.js";

export const TELEMETRY_SCHEMA_VERSION = "2";

export type TelemetryEventName =
  | "cli.command"
  | "cli.install"
  | "cli.update"
  | "cli.auth"
  | "cli.mcp.tool"
  | "cli.tui"
  | "cli.error";

export interface TelemetryClientLike {
  trackEvent(event: {
    name: string;
    properties?: Record<string, string>;
    measurements?: Record<string, number>;
  }): void;
  flush?(callback?: (error?: Error) => void): Promise<void> | void;
  shutdown?(): Promise<void>;
  setUseDiskRetryCaching?(enabled: boolean): void;
}

export interface CliTelemetry {
  readonly enabled: boolean;
  setUserProperties(properties: Record<string, unknown>): void;
  track(eventName: TelemetryEventName, properties?: Record<string, unknown>): Promise<void>;
  flush(): Promise<void>;
}

export interface CreateCliTelemetryOptions {
  config: CliConfig;
  env?: NodeJS.ProcessEnv;
  commonProperties?: Record<string, unknown>;
  clientFactory?: (connectionString: string) => TelemetryClientLike;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

const PROPERTY_ALLOWLIST = new Set([
  "alias",
  "aliases",
  "arch",
  "authMode",
  "cliVersion",
  "command",
  "completionShell",
  "completions",
  "errorCategory",
  "exitCode",
  "format",
  "installSource",
  "installerResult",
  "installerType",
  "interactive",
  "mcpSetup",
  "nodeVersion",
  "os",
  "osVersionMajor",
  "previousCliVersion",
  "requestedVersion",
  "requestId",
  "resolvedVersion",
  "runtime",
  "subcommand",
  "success",
  "platform",
  "telemetrySchemaVersion",
  "toolName",
  "toolset",
  "targetCliVersion",
  "traceId",
  "tuiInitialTab",
  "updateAction",
  "user_hash",
]);

const MEASUREMENT_ALLOWLIST = new Set(["durationMs"]);

const trimString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
};

const parseTelemetryBoolean = (value: unknown): boolean | undefined => {
  const normalized = trimString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }
  return undefined;
};

export const resolveTelemetryEnabled = (
  config: CliConfig,
  env: NodeJS.ProcessEnv = process.env
): boolean => {
  if (parseTelemetryBoolean(env.CLOUDEVAL_TELEMETRY_DISABLED) === true) {
    return false;
  }

  const envOverride = parseTelemetryBoolean(env.CLOUDEVAL_TELEMETRY);
  if (typeof envOverride === "boolean") {
    return envOverride;
  }

  if (typeof config.telemetry?.enabled === "boolean") {
    return config.telemetry.enabled;
  }

  return true;
};

export const resolveTelemetryConnectionString = (
  env: NodeJS.ProcessEnv = process.env
): string | undefined => {
  return (
    trimString(env.CLOUDEVAL_APPLICATIONINSIGHTS_CONNECTION_STRING) ||
    trimString(env.APPLICATIONINSIGHTS_CONNECTION_STRING) ||
    trimString(env.NEXT_PUBLIC_APPLICATIONINSIGHTS_CONNECTION_STRING) ||
    trimString(PACKAGED_APPLICATIONINSIGHTS_CONNECTION_STRING)
  );
};

export const sanitizeTelemetryProperties = (
  properties: Record<string, unknown>
): {
  properties: Record<string, string>;
  measurements: Record<string, number>;
} => {
  const sanitizedProperties: Record<string, string> = {};
  const measurements: Record<string, number> = {};

  for (const [key, value] of Object.entries(properties)) {
    if (MEASUREMENT_ALLOWLIST.has(key)) {
      const numberValue =
        typeof value === "number"
          ? value
          : typeof value === "string"
            ? Number(value)
            : Number.NaN;
      if (Number.isFinite(numberValue)) {
        measurements[key] = numberValue;
      }
      continue;
    }

    if (!PROPERTY_ALLOWLIST.has(key)) {
      continue;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        sanitizedProperties[key] = trimmed.slice(0, 256);
      }
    } else if (typeof value === "boolean" || typeof value === "number") {
      sanitizedProperties[key] = String(value);
    }
  }

  return { properties: sanitizedProperties, measurements };
};

export const buildTelemetryUserProperties = (
  user?: Record<string, unknown> | null
): Record<string, string> => {
  if (!user || typeof user !== "object") {
    return {};
  }

  const internalId =
    trimString(user.id) ||
    trimString(user.userId) ||
    trimString(user.user_id) ||
    trimString(user.accountId) ||
    trimString(user.account_id);
  if (!internalId) {
    return {};
  }
  return {
    user_hash: `h_${createHash("sha256")
      .update("cloudeval-cli:user:")
      .update(internalId)
      .digest("hex")
      .slice(0, 32)}`,
  };
};

export const classifyTelemetryError = (error: unknown): string => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const normalized = message.toLowerCase();

  if (normalized.includes("no authentication") || normalized.includes("not authenticated")) {
    return "auth_unavailable";
  }
  if (normalized.includes("403") || normalized.includes("forbidden")) {
    return "forbidden";
  }
  if (normalized.includes("401") || normalized.includes("unauthorized")) {
    return "unauthorized";
  }
  if (normalized.includes("429") || normalized.includes("rate limit")) {
    return "rate_limited";
  }
  if (
    normalized.includes("fetch failed") ||
    normalized.includes("econnrefused") ||
    normalized.includes("enotfound") ||
    normalized.includes("etimedout") ||
    normalized.includes("network")
  ) {
    return "network";
  }
  if (normalized.includes("abort") || normalized.includes("cancel")) {
    return "interrupted";
  }
  if (normalized.includes("invalid") || normalized.includes("required")) {
    return "validation";
  }
  return "error";
};

export const getCommonTelemetryProperties = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => {
  const release = os.release();
  return {
    cliVersion: CLI_VERSION,
    telemetrySchemaVersion: TELEMETRY_SCHEMA_VERSION,
    os: os.platform(),
    osVersionMajor: release.split(".")[0],
    arch: os.arch(),
    nodeVersion: process.versions.node,
    runtime: process.versions.bun ? "bun" : "node",
    installSource: process.env.CLOUDEVAL_INSTALL_SOURCE || "unknown",
    ...overrides,
  };
};

const createNoopTelemetry = (): CliTelemetry => ({
  enabled: false,
  setUserProperties: () => {},
  track: async () => {},
  flush: async () => {},
});

const createApplicationInsightsClient = async (
  connectionString: string
): Promise<TelemetryClientLike> => {
  const appInsights = await import("applicationinsights");
  const client = new appInsights.TelemetryClient(connectionString, {
    useGlobalProviders: false,
  });
  disableDiskRetryCaching(client);
  return client;
};

const setTelemetryClientRole = (client: TelemetryClientLike): void => {
  try {
    const context = (client as any).context;
    const cloudRoleKey = context?.keys?.cloudRole;
    if (cloudRoleKey && context?.tags) {
      context.tags[cloudRoleKey] = "cloudeval-cli";
    }
  } catch {
    // Role tagging is best-effort across applicationinsights SDK versions.
  }
};

export const disableDiskRetryCaching = (client: TelemetryClientLike): void => {
  try {
    client.setUseDiskRetryCaching?.(false);
  } catch {
    // applicationinsights v3 exposes this compatibility method but throws
    // "Not implemented"; telemetry should still use the in-memory exporter.
  }
};

const flushClient = async (client: TelemetryClientLike): Promise<void> => {
  try {
    const flush = client.flush;
    if (!flush) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const timeout = setTimeout(settle, 1500);
      timeout.unref?.();

      try {
        const result = flush.call(client, () => {
          clearTimeout(timeout);
          settle();
        });
        if (result && typeof (result as Promise<void>).then === "function") {
          (result as Promise<void>)
            .catch(() => {})
            .finally(() => {
              clearTimeout(timeout);
              settle();
            });
        } else if (flush.length === 0) {
          clearTimeout(timeout);
          settle();
        }
      } catch {
        clearTimeout(timeout);
        settle();
      }
    });
  } catch {
    // Telemetry must never affect CLI command behavior.
  }
};

export const createCliTelemetry = async (
  options: CreateCliTelemetryOptions
): Promise<CliTelemetry> => {
  if (!resolveTelemetryEnabled(options.config, options.env)) {
    return createNoopTelemetry();
  }

  const connectionString = resolveTelemetryConnectionString(options.env);
  if (!connectionString) {
    return createNoopTelemetry();
  }

  let client: TelemetryClientLike;
  try {
    client = options.clientFactory
      ? options.clientFactory(connectionString)
      : await createApplicationInsightsClient(connectionString);
    setTelemetryClientRole(client);
  } catch {
    return createNoopTelemetry();
  }

  let userProperties: Record<string, unknown> = {};
  const commonProperties = options.commonProperties || {};

  return {
    enabled: true,
    setUserProperties(properties: Record<string, unknown>) {
      userProperties = {
        ...userProperties,
        ...sanitizeTelemetryProperties(buildTelemetryUserProperties(properties)).properties,
      };
    },
    async track(eventName: TelemetryEventName, properties: Record<string, unknown> = {}) {
      try {
        const sanitized = sanitizeTelemetryProperties({
          ...commonProperties,
          ...userProperties,
          ...properties,
        });
        client.trackEvent({
          name: eventName,
          properties: sanitized.properties,
          measurements: sanitized.measurements,
        });
      } catch {
        // Telemetry must never affect CLI command behavior.
      }
    },
    async flush() {
      await flushClient(client);
    },
  };
};

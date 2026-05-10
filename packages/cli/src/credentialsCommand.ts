import type { Command } from "commander";
import { addAuthOptions, resolveAuthContext, type AuthGuardDeps } from "./authGuard.js";
import {
  formatTextTable,
  writePrivateOutputFile,
  writeFormattedOutput,
  type MachineOutputFormat,
} from "./outputFormatter.js";

type CredentialFormat = MachineOutputFormat | "github-actions";

interface CredentialsDeps extends AuthGuardDeps {
  defaultBaseUrl: string;
}

interface CredentialOptions {
  baseUrl?: string;
  accessKey?: string;
  accessKeyStdin?: boolean;
  nonInteractive?: boolean;
  format?: CredentialFormat;
  output?: string;
  project?: string;
  template?: string;
  name?: string;
  expires?: string;
  capabilities?: string;
  idempotencyKey?: string;
  reason?: string;
}

const asRecord = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};

const arrayFromPayload = (payload: unknown, key: string): Record<string, unknown>[] => {
  const record = asRecord(payload);
  const value = record[key] ?? record.data;
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
};

const credentialFromPayload = (payload: unknown): Record<string, any> => {
  const record = asRecord(payload);
  return asRecord(record.credential ?? record.data ?? record);
};

const secretFromPayload = (payload: unknown): string | undefined => {
  const record = asRecord(payload);
  const value = record.access_key ?? record.accessKey ?? record.secret;
  return typeof value === "string" ? value : undefined;
};

const projectIdFromPayload = (
  payload: unknown,
  fallback?: string
): string | undefined => {
  const record = asRecord(payload);
  const credential = credentialFromPayload(payload);
  const value =
    record.project_id ??
    record.projectId ??
    credential.project_id ??
    credential.projectId ??
    (Array.isArray(credential.project_ids) ? credential.project_ids[0] : undefined) ??
    fallback;
  return typeof value === "string" ? value : undefined;
};

const formatCredentialTextRows = (credentials: Record<string, unknown>[]) =>
  credentials.map((credential) => ({
    id: credential.id,
    name: credential.name,
    status: credential.status,
    prefix: credential.key_prefix ?? credential.keyPrefix,
    projects: Array.isArray(credential.project_ids)
      ? credential.project_ids.join(",")
      : credential.project_id ?? credential.projectId ?? "",
    capabilities: Array.isArray(credential.capabilities)
      ? credential.capabilities.join(",")
      : "",
    expires: credential.expires_at ?? credential.expiresAt ?? "",
    "last used": credential.last_used_at ?? credential.lastUsedAt ?? "",
  }));

const writeCredentialOutput = async (input: {
  command: string;
  data: unknown;
  format?: CredentialFormat;
  output?: string;
  projectId?: string;
}) => {
  if (input.format === "github-actions") {
    const secret = secretFromPayload(input.data);
    if (!secret) {
      throw new Error("Credential create response did not include a one-time access key.");
    }
    const projectId = projectIdFromPayload(input.data, input.projectId);
    const text = [
      `CLOUDEVAL_ACCESS_KEY: ${secret}`,
      ...(projectId ? [`CLOUDEVAL_PROJECT_ID: ${projectId}`] : []),
    ].join("\n") + "\n";
    if (input.output) {
      await writePrivateOutputFile(input.output, text);
      return;
    }
    process.stdout.write(text);
    return;
  }

  if (input.format === "text" || !input.format) {
    const record = asRecord(input.data);
    const credentials =
      arrayFromPayload(input.data, "credentials").length > 0
        ? arrayFromPayload(input.data, "credentials")
        : record.credential
          ? [credentialFromPayload(input.data)]
          : arrayFromPayload(input.data, "templates");
    if (credentials.length) {
      process.stdout.write(formatTextTable(formatCredentialTextRows(credentials)));
      return;
    }
  }

  await writeFormattedOutput({
    command: input.command,
    data: input.data,
    format: input.format as MachineOutputFormat | undefined,
    output: input.output,
    redactSensitiveSecrets: input.command !== "credentials create",
  });
};

const resolveCoreAuth = async (
  options: CredentialOptions,
  command: Command,
  deps: CredentialsDeps
) => {
  const context = await resolveAuthContext(options, command, deps);
  const core = await import("@cloudeval/core");
  return { ...context, core };
};

const parseCapabilities = (value?: string): string[] | undefined =>
  value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const addCommon = <T extends Command>(command: T, deps: CredentialsDeps): T =>
  addAuthOptions(command, deps.defaultBaseUrl)
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file") as T;

export const registerCredentialsCommand = (
  program: Command,
  deps: CredentialsDeps
) => {
  const credentials = program
    .command("credentials")
    .description("Manage CloudEval access-key credentials");

  addCommon(credentials.command("templates").description("List credential templates"), deps)
    .action(async (options: CredentialOptions, command) => {
      const auth = await resolveCoreAuth(options, command, deps);
      const data = await auth.core.getCredentialTemplates({
        baseUrl: auth.baseUrl,
        authToken: auth.token,
      });
      await writeCredentialOutput({
        command: "credentials templates",
        data,
        format: options.format,
        output: options.output,
      });
    });

  addCommon(credentials.command("list").description("List credentials"), deps)
    .option("--project <id>", "Filter by project id")
    .action(async (options: CredentialOptions, command) => {
      const auth = await resolveCoreAuth(options, command, deps);
      const data = await auth.core.listCredentials({
        baseUrl: auth.baseUrl,
        authToken: auth.token,
        projectId: options.project,
      });
      await writeCredentialOutput({
        command: "credentials list",
        data,
        format: options.format,
        output: options.output,
      });
    });

  addCommon(credentials.command("inspect").description("Inspect a credential").argument("<credential_id>"), deps)
    .action(async (credentialId: string, options: CredentialOptions, command) => {
      const auth = await resolveCoreAuth(options, command, deps);
      const data = await auth.core.getCredential({
        baseUrl: auth.baseUrl,
        authToken: auth.token,
        credentialId,
      });
      await writeCredentialOutput({
        command: "credentials inspect",
        data,
        format: options.format,
        output: options.output,
      });
    });

  addAuthOptions(credentials.command("create").description("Create an access-key credential"), deps.defaultBaseUrl)
    .requiredOption("--template <id>", "Credential template id")
    .requiredOption("--name <name>", "Credential name")
    .requiredOption("--project <id>", "Project scope")
    .option("--expires <duration>", "Expiration duration, for example 90d")
    .option("--capabilities <list>", "Comma-separated capability override")
    .option("--idempotency-key <key>", "Idempotency key for safe retries")
    .option("--format <format>", "Output format: text, json, ndjson, markdown, github-actions", "text")
    .option("--output <file>", "Output file")
    .action(async (options: CredentialOptions, command) => {
      const auth = await resolveCoreAuth(options, command, deps);
      const data = await auth.core.createCredential({
        baseUrl: auth.baseUrl,
        authToken: auth.token,
        template: options.template!,
        name: options.name!,
        projectId: options.project!,
        expires: options.expires,
        capabilities: parseCapabilities(options.capabilities),
        idempotencyKey: options.idempotencyKey,
      });
      await writeCredentialOutput({
        command: "credentials create",
        data,
        format: options.format,
        output: options.output,
        projectId: options.project,
      });
    });

  addCommon(credentials.command("revoke").description("Revoke a credential").argument("<credential_id>"), deps)
    .option("--reason <reason>", "Revocation reason")
    .option("--idempotency-key <key>", "Idempotency key for safe retries")
    .action(async (credentialId: string, options: CredentialOptions, command) => {
      const auth = await resolveCoreAuth(options, command, deps);
      const data = await auth.core.revokeCredential({
        baseUrl: auth.baseUrl,
        authToken: auth.token,
        credentialId,
        reason: options.reason,
        idempotencyKey: options.idempotencyKey,
      });
      await writeCredentialOutput({
        command: "credentials revoke",
        data,
        format: options.format,
        output: options.output,
      });
    });
};

export const registerIdentityCommand = (
  program: Command,
  deps: CredentialsDeps
) => {
  addCommon(program.command("identity").description("Show the current CloudEval identity"), deps)
    .action(async (options: CredentialOptions, command) => {
      const auth = await resolveCoreAuth(options, command, deps);
      const data = await auth.core.getIdentity({
        baseUrl: auth.baseUrl,
        authToken: auth.token,
      });
      await writeFormattedOutput({
        command: "identity",
        data,
        format: options.format as MachineOutputFormat | undefined,
        output: options.output,
      });
    });
};

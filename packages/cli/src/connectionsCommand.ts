import type { Command } from "commander";
import {
  addAuthOptions,
  requireAuthUser,
  resolveAuthContext,
  type AuthGuardDeps,
  type AuthGuardOptions,
} from "./authGuard.js";
import {
  buildFrontendUrl,
  openExternalUrl,
  resolveFrontendBaseUrl,
} from "./frontendLinks.js";
import {
  writeFormattedOutput,
  type MachineOutputFormat,
} from "./outputFormatter.js";

export interface RegisterConnectionsCommandOptions extends AuthGuardDeps {
  defaultBaseUrl: string;
}

type CommonOptions = AuthGuardOptions & {
  format?: MachineOutputFormat;
  output?: string;
  open?: boolean;
  printUrl?: boolean;
  frontendUrl?: string;
};

const addCommon = <T extends Command>(command: T): T =>
  command
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file")
    .option("--open", "Open the matching frontend page", false)
    .option("--print-url", "Print the matching frontend URL", false)
    .option("--no-open", "Do not launch the browser when a URL is printed")
    .option("--frontend-url <url>", "Frontend base URL") as T;

const frontendBase = (
  context: { baseUrl: string },
  options: { frontendUrl?: string }
): string =>
  resolveFrontendBaseUrl({
    frontendUrl: options.frontendUrl,
    apiBaseUrl: context.baseUrl,
  });

const maybeOpen = async (url: string, options: CommonOptions) => {
  if (options.printUrl) {
    process.stdout.write(`${url}\n`);
  }
  if (options.open !== false && (options.open || options.printUrl)) {
    await openExternalUrl(url);
  }
};

export const registerConnectionsCommand = (
  program: Command,
  deps: RegisterConnectionsCommandOptions
) => {
  const connections = program.command("connections").description("Connection utilities");

  addCommon(addAuthOptions(connections.command("list").description("List connections"), deps.defaultBaseUrl))
    .action(async (options: CommonOptions, command) => {
      try {
        const context = requireAuthUser(await resolveAuthContext(options, command, deps));
        const core = await import("@cloudeval/core");
        const data = await core.listConnections({
          baseUrl: context.baseUrl,
          authToken: context.token,
          userId: context.user.id,
        });
        const url = buildFrontendUrl({
          baseUrl: frontendBase(context, options),
          target: "connections",
        });
        await writeFormattedOutput({
          command: "connections list",
          data,
          format: options.format,
          output: options.output,
          frontendUrl: url,
        });
        await maybeOpen(url, options);
      } catch (error: any) {
        console.error(`Failed to list connections: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });

  addCommon(
    addAuthOptions(
      connections.command("get").description("Show a connection").argument("<id>", "Connection id"),
      deps.defaultBaseUrl
    )
  ).action(async (id: string, options: CommonOptions, command) => {
    try {
      const context = requireAuthUser(await resolveAuthContext(options, command, deps));
      const core = await import("@cloudeval/core");
      const data = await core.getConnection({
        baseUrl: context.baseUrl,
        authToken: context.token,
        userId: context.user.id,
        connectionId: id,
      });
      if (!data) {
        throw new Error(`Connection ${id} was not found.`);
      }
      const url = buildFrontendUrl({
        baseUrl: frontendBase(context, options),
        target: "connection",
        connectionId: id,
      });
      await writeFormattedOutput({
        command: "connections get",
        data,
        format: options.format,
        output: options.output,
        frontendUrl: url,
      });
      await maybeOpen(url, options);
    } catch (error: any) {
      console.error(`Failed to show connection: ${error?.message ?? "Unknown error"}`);
      process.exit(1);
    }
  });

  addCommon(
    addAuthOptions(
      connections.command("open").description("Open a connection").argument("<id>", "Connection id"),
      deps.defaultBaseUrl
    )
  ).action(async (id: string, options: CommonOptions, command) => {
    try {
      const context = await resolveAuthContext(options, command, deps);
      const url = buildFrontendUrl({
        baseUrl: frontendBase(context, options),
        target: "connection",
        connectionId: id,
      });
      await writeFormattedOutput({
        command: "connections open",
        data: { url },
        format: options.format,
        output: options.output,
        frontendUrl: url,
      });
      await maybeOpen(url, { ...options, open: options.open || true });
    } catch (error: any) {
      console.error(`Failed to open connection: ${error?.message ?? "Unknown error"}`);
      process.exit(1);
    }
  });
};

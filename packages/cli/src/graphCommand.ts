import type { Command } from "commander";
import {
  addAuthOptions,
  requireAuthUser,
  resolveAuthContext,
  type AuthGuardDeps,
  type AuthGuardOptions,
} from "./authGuard.js";
import { getProjectGraphInsights } from "./graphClient.js";
import { buildGraphNeighborhood } from "./ideContracts.js";
import { IDE_SCHEMA_VERSION } from "./iacCommand.js";
import { writeFormattedOutput, type MachineOutputFormat } from "./outputFormatter.js";

type GraphNeighborhoodOptions = AuthGuardOptions & {
  project?: string;
  resource?: string;
  limit?: string;
  syncVersion?: string;
  format?: MachineOutputFormat;
  output?: string;
};

export interface RegisterGraphCommandOptions extends AuthGuardDeps {
  defaultBaseUrl: string;
}

const parseLimit = (value?: string): number | undefined => {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--limit must be a positive integer.");
  }
  return parsed;
};

export const registerGraphCommand = (
  program: Command,
  deps: RegisterGraphCommandOptions,
) => {
  const graph = program.command("graph").description("Cloudeval graph utilities");

  addAuthOptions(
    graph.command("neighborhood").description("Fetch a scoped graph neighborhood for an IDE resource"),
    deps.defaultBaseUrl,
  )
    .requiredOption("--project <id>", "Cloudeval project id")
    .requiredOption("--resource <id>", "Cloudeval resource id or IaC resource address")
    .option("--limit <count>", "Maximum graph insight items", "20")
    .option("--sync-version <version>", "Cloudeval sync version")
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file")
    .action(async (options: GraphNeighborhoodOptions, command) => {
      try {
        const context = requireAuthUser(await resolveAuthContext(options, command, deps));
        const graphData = await getProjectGraphInsights({
          baseUrl: context.baseUrl,
          authToken: context.token,
          userId: context.user.id,
          projectId: options.project!,
          resourceId: options.resource!,
          focus: "impact",
          syncVersion: options.syncVersion,
          limit: parseLimit(options.limit),
        });
        const data = buildGraphNeighborhood({
          projectId: options.project!,
          resourceId: options.resource!,
          graphData,
        });
        await writeFormattedOutput({
          command: "graph neighborhood",
          data,
          format: options.format,
          output: options.output,
          schemaVersion: IDE_SCHEMA_VERSION,
        });
      } catch (error: any) {
        console.error(`Failed to fetch graph neighborhood: ${error?.message ?? "Unknown error"}`);
        process.exitCode = 1;
      }
    });
};

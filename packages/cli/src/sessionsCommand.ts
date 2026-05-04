import type { Command } from "commander";
import {
  deleteSession,
  exportSessions,
  getSession,
  listSessions,
  pruneSessions,
  renameSession,
  searchSessions,
} from "./sessionsStore.js";
import { getActiveConfigProfile } from "./cliConfig.js";
import {
  writeFormattedOutput,
  type MachineOutputFormat,
} from "./outputFormatter.js";

interface SessionOptions {
  limit?: string;
  format?: MachineOutputFormat;
  output?: string;
  yes?: boolean;
  olderThan?: string;
  profile?: string;
}

const addSessionOutputOptions = <T extends Command>(command: T): T =>
  command
    .option("--profile <name>", "Configuration profile")
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file") as T;

const sessionSummary = (session: any) => ({
  threadId: session.threadId,
  title: session.title,
  projectId: session.projectId,
  projectName: session.projectName,
  model: session.model,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  messageCount: session.messageCount,
});

export const registerSessionsCommand = (program: Command) => {
  const sessions = program.command("sessions").description("Manage local CLI session history");

  addSessionOutputOptions(sessions.command("list").description("List local sessions"))
    .option("--limit <n>", "Max sessions to show", "20")
    .action(async (options: SessionOptions, command) => {
      const profile = options.profile || getActiveConfigProfile(command);
      const data = (await listSessions(Number(options.limit) || 20, profile)).map(sessionSummary);
      await writeFormattedOutput({
        command: "sessions list",
        data,
        format: options.format,
        output: options.output,
      });
    });

  addSessionOutputOptions(
    sessions.command("get").description("Show one local session").argument("<thread-id>", "Thread id")
  ).action(async (threadId: string, options: SessionOptions, command) => {
    const profile = options.profile || getActiveConfigProfile(command);
    const data = await getSession(threadId, profile);
    if (!data) {
      throw new Error(`Session ${threadId} was not found.`);
    }
    await writeFormattedOutput({
      command: "sessions get",
      data,
      format: options.format,
      output: options.output,
    });
  });

  addSessionOutputOptions(
    sessions.command("search").description("Search local sessions").argument("<query...>", "Search query")
  )
    .option("--limit <n>", "Max sessions to show", "20")
    .action(async (queryParts: string[], options: SessionOptions, command) => {
      const profile = options.profile || getActiveConfigProfile(command);
      const data = await searchSessions(queryParts.join(" "), {
        profile,
        limit: Number(options.limit) || 20,
      });
      await writeFormattedOutput({
        command: "sessions search",
        data,
        format: options.format,
        output: options.output,
      });
    });

  addSessionOutputOptions(
    sessions
      .command("rename")
      .description("Rename one local session")
      .argument("<thread-id>", "Thread id")
      .argument("<title...>", "New title")
  ).action(async (threadId: string, titleParts: string[], options: SessionOptions, command) => {
    const profile = options.profile || getActiveConfigProfile(command);
    const data = await renameSession(threadId, titleParts.join(" "), profile);
    if (!data) {
      throw new Error(`Session ${threadId} was not found.`);
    }
    await writeFormattedOutput({
      command: "sessions rename",
      data: sessionSummary(data),
      format: options.format,
      output: options.output,
    });
  });

  addSessionOutputOptions(sessions.command("export").description("Export local sessions"))
    .action(async (options: SessionOptions, command) => {
      const profile = options.profile || getActiveConfigProfile(command);
      await writeFormattedOutput({
        command: "sessions export",
        data: await exportSessions(profile),
        format: options.format ?? "json",
        output: options.output,
      });
    });

  addSessionOutputOptions(
    sessions.command("delete").description("Delete one local session").argument("<thread-id>", "Thread id")
  )
    .option("--yes", "Skip confirmation", false)
    .action(async (threadId: string, options: SessionOptions, command) => {
      const profile = options.profile || getActiveConfigProfile(command);
      if (!options.yes && process.stdin.isTTY && process.stdout.isTTY) {
        throw new Error("Pass --yes to delete a session non-interactively.");
      }
      await writeFormattedOutput({
        command: "sessions delete",
        data: { profile, threadId, deleted: await deleteSession(threadId, profile) },
        format: options.format,
        output: options.output,
      });
    });

  addSessionOutputOptions(sessions.command("prune").description("Delete old local sessions"))
    .option("--older-than <days>", "Delete sessions older than N days", "90")
    .option("--yes", "Skip confirmation", false)
    .action(async (options: SessionOptions, command) => {
      const profile = options.profile || getActiveConfigProfile(command);
      if (!options.yes && process.stdin.isTTY && process.stdout.isTTY) {
        throw new Error("Pass --yes to prune sessions non-interactively.");
      }
      const olderThanDays = Number(options.olderThan) || 90;
      await writeFormattedOutput({
        command: "sessions prune",
        data: { profile, olderThanDays, deleted: await pruneSessions(olderThanDays, profile) },
        format: options.format,
        output: options.output,
      });
    });
};

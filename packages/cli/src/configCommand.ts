import type { Command } from "commander";
import {
  getActiveConfigProfile,
  getCliConfigPath,
  listCliConfigProfiles,
  loadCliConfig,
  readCliConfigValue,
  saveCliConfig,
  unsetCliConfigValue,
  writeCliConfigValue,
} from "./cliConfig.js";
import {
  writeFormattedOutput,
  type MachineOutputFormat,
} from "./outputFormatter.js";

interface ConfigCommandOptions {
  profile?: string;
  format?: MachineOutputFormat;
  output?: string;
}

const addConfigOutputOptions = <T extends Command>(command: T): T =>
  command
    .option("--profile <name>", "Configuration profile")
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file") as T;

const resolveProfile = (options: ConfigCommandOptions, command?: Command): string =>
  options.profile || getActiveConfigProfile(command);

export const registerConfigCommand = (program: Command) => {
  const config = program
    .command("config")
    .description("View and edit local Cloudeval CLI settings");

  addConfigOutputOptions(config.command("show").description("Show current profile settings"))
    .action(async (options: ConfigCommandOptions, command) => {
      const profile = resolveProfile(options, command);
      const data = await loadCliConfig(profile);
      await writeFormattedOutput({
        command: "config show",
        data,
        format: options.format,
        output: options.output,
      });
    });

  addConfigOutputOptions(
    config.command("get").description("Read one setting").argument("<key>", "Config key")
  ).action(async (key: string, options: ConfigCommandOptions, command) => {
    const profile = resolveProfile(options, command);
    const data = await loadCliConfig(profile);
    await writeFormattedOutput({
      command: "config get",
      data: { key, value: readCliConfigValue(data, key) ?? null },
      format: options.format,
      output: options.output,
    });
  });

  addConfigOutputOptions(
    config
      .command("set")
      .description("Set one profile setting")
      .argument("<key>", "Config key")
      .argument("<value>", "Config value")
  ).action(async (key: string, value: string, options: ConfigCommandOptions, command) => {
    const profile = resolveProfile(options, command);
    const current = await loadCliConfig(profile);
    const next = writeCliConfigValue(current, key, value);
    const path = await saveCliConfig(next, profile);
    await writeFormattedOutput({
      command: "config set",
      data: { profile, path, config: next },
      format: options.format,
      output: options.output,
    });
  });

  addConfigOutputOptions(
    config.command("unset").description("Remove one profile setting").argument("<key>", "Config key")
  ).action(async (key: string, options: ConfigCommandOptions, command) => {
    const profile = resolveProfile(options, command);
    const current = await loadCliConfig(profile);
    const next = unsetCliConfigValue(current, key);
    const path = await saveCliConfig(next, profile);
    await writeFormattedOutput({
      command: "config unset",
      data: { profile, path, config: next },
      format: options.format,
      output: options.output,
    });
  });

  config
    .command("path")
    .description("Print the settings file path")
    .option("--profile <name>", "Configuration profile")
    .action((options: { profile?: string }, command) => {
      process.stdout.write(`${getCliConfigPath(resolveProfile(options, command))}\n`);
    });

  addConfigOutputOptions(config.command("profiles").description("List configuration profiles"))
    .action(async (options: ConfigCommandOptions) => {
      await writeFormattedOutput({
        command: "config profiles",
        data: await listCliConfigProfiles(),
        format: options.format,
        output: options.output,
      });
    });
};

import { createInterface, type Interface } from "node:readline/promises";
import type { Command } from "commander";
import {
  getActiveConfigProfile,
  loadCliConfig,
  normalizeCliMode,
  saveCliConfig,
  type CliConfig,
} from "./cliConfig.js";
import { CLOUD_BASE_URL } from "./baseUrl.js";
import {
  writeFormattedOutput,
  type MachineOutputFormat,
} from "./outputFormatter.js";

interface SetupOptions {
  nonInteractive?: boolean;
  baseUrl?: string;
  frontendUrl?: string;
  project?: string;
  model?: string;
  mode?: string;
  profile?: string;
  format?: MachineOutputFormat;
  output?: string;
}

const prompt = async (
  rl: Interface,
  label: string,
  current?: string
): Promise<string | undefined> => {
  const suffix = current ? ` [${current}]` : "";
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer || current;
};

const buildConfig = (current: CliConfig, options: SetupOptions): CliConfig => ({
  ...current,
  ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  ...(options.frontendUrl ? { frontendUrl: options.frontendUrl } : {}),
  ...(options.project ? { defaultProjectId: options.project } : {}),
  ...(options.model ? { model: options.model } : {}),
  ...(options.mode ? { mode: normalizeCliMode(options.mode) } : {}),
});

export const registerSetupCommand = (program: Command, defaultBaseUrl = CLOUD_BASE_URL) => {
  program
    .command("setup")
    .description("Configure CloudEval CLI defaults")
    .option("--non-interactive", "Write provided settings without prompting", false)
    .option("--base-url <url>", "Default backend API URL")
    .option("--frontend-url <url>", "Default frontend URL")
    .option("--project <id>", "Default project id")
    .option("--model <name>", "Default model")
    .option("--mode <mode>", "Default chat mode: ask, agent")
    .option("--profile <name>", "Configuration profile")
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file")
    .action(async (options: SetupOptions, command) => {
      const profile = options.profile || getActiveConfigProfile(command);
      const current = await loadCliConfig(profile);
      let next = buildConfig(current, options);

      if (!options.nonInteractive) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          throw new Error("setup requires a TTY unless --non-interactive is provided.");
        }
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          next = {
            ...next,
            baseUrl: await prompt(rl, "Backend API URL", next.baseUrl ?? defaultBaseUrl),
            frontendUrl: await prompt(rl, "Frontend URL", next.frontendUrl),
            defaultProjectId: await prompt(rl, "Default project id", next.defaultProjectId),
            model: await prompt(rl, "Default model", next.model),
            mode: normalizeCliMode(await prompt(rl, "Default chat mode", next.mode ?? "ask")),
          };
        } finally {
          rl.close();
        }
      }

      const path = await saveCliConfig(next, profile);
      await writeFormattedOutput({
        command: "setup",
        data: {
          profile,
          path,
          config: next,
          nextSteps: [
            "Run `cloudeval auth status` to inspect authentication.",
            "Run `cloudeval doctor` to verify local CLI setup.",
            "Run `cloudeval capabilities --format json` for agent integration metadata.",
          ],
        },
        format: options.format,
        output: options.output,
      });
    });
};

import type { Command } from "commander";
import {
  addAuthOptions,
  resolveAuthContext,
  type AuthGuardDeps,
  type AuthGuardOptions,
} from "./authGuard.js";
import { writeFormattedOutput, type MachineOutputFormat } from "./outputFormatter.js";
import {
  getRule,
  getRuleCategories,
  searchRules,
} from "./templateValidationClient.js";

export interface RegisterRulesCommandOptions extends AuthGuardDeps {
  defaultBaseUrl: string;
}

type RulesOptions = AuthGuardOptions & {
  format?: MachineOutputFormat;
  output?: string;
  category?: string;
  pillar?: string;
};

const addCommon = <T extends Command>(
  command: T,
  deps: RegisterRulesCommandOptions,
): T =>
  addAuthOptions(command, deps.defaultBaseUrl)
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file") as T;

export const registerRulesCommand = (
  program: Command,
  deps: RegisterRulesCommandOptions,
) => {
  const rules = program.command("rules").description("Browse cloud validation checks");

  addCommon(rules.command("categories").description("List validation check categories"), deps)
    .action(async (options: RulesOptions, command) => {
      try {
        const context = await resolveAuthContext(options, command, deps);
        const data = await getRuleCategories({
          baseUrl: context.baseUrl,
          authToken: context.token,
        });
        await writeFormattedOutput({
          command: "rules categories",
          data,
          format: options.format,
          output: options.output,
        });
      } catch (error: any) {
        console.error(`Failed to list rule categories: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });

  addCommon(
    rules.command("search").description("Search validation checks").argument("<query>", "Search query"),
    deps,
  )
    .option("--category <name>", "Category filter")
    .option("--pillar <name>", "Architecture pillar filter")
    .action(async (query: string, options: RulesOptions, command) => {
      try {
        const context = await resolveAuthContext(options, command, deps);
        const data = await searchRules({
          baseUrl: context.baseUrl,
          authToken: context.token,
          query,
          category: options.category,
          pillar: options.pillar,
        });
        await writeFormattedOutput({
          command: "rules search",
          data,
          format: options.format,
          output: options.output,
        });
      } catch (error: any) {
        console.error(`Failed to search rules: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });

  addCommon(
    rules.command("show").description("Show a validation check").argument("<rule_id>", "Rule id"),
    deps,
  ).action(async (ruleId: string, options: RulesOptions, command) => {
    try {
      const context = await resolveAuthContext(options, command, deps);
      const data = await getRule({
        baseUrl: context.baseUrl,
        authToken: context.token,
        ruleId,
      });
      await writeFormattedOutput({
        command: "rules show",
        data,
        format: options.format,
        output: options.output,
      });
    } catch (error: any) {
      console.error(`Failed to show rule: ${error?.message ?? "Unknown error"}`);
      process.exit(1);
    }
  });
};

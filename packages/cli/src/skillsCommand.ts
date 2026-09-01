import fs from "node:fs/promises";
import type { Command } from "commander";
import {
  formatTextTable,
  writeFormattedOutput,
  type MachineOutputFormat,
} from "./outputFormatter.js";
import {
  getSkill,
  getSkillsPath,
  listSkills,
  validateSkills,
  type SkillSummary,
} from "./skills/catalog.js";

type SkillsFormat = MachineOutputFormat | "table";

interface CommonSkillOptions {
  format?: SkillsFormat;
  output?: string;
}

const renderSkillsTable = (skills: SkillSummary[]): string =>
  formatTextTable(
    skills.map((skill) => ({
      id: skill.id,
      title: skill.title,
      recipes: skill.recipes.length,
      tools: skill.mcpTools.length,
      source: skill.source,
    })),
    [
      { key: "id", header: "ID", width: 36 },
      { key: "title", header: "Title", maxWidth: 40 },
      { key: "recipes", header: "Recipes", align: "right" },
      { key: "tools", header: "MCP Tools", align: "right" },
      { key: "source", header: "Source", maxWidth: 12 },
    ],
    { emptyMessage: "No Cloudeval skills found." },
  );

const renderSkillsMarkdown = (skills: SkillSummary[]): string =>
  [
    "# Cloudeval Skills",
    "",
    ...skills.map((skill) => [
      `## ${skill.title}`,
      "",
      `- ID: ${skill.id}`,
      `- Source: ${skill.source}`,
      `- Recipes: ${skill.recipes.length ? skill.recipes.join(", ") : "none"}`,
      `- MCP tools: ${skill.mcpTools.length ? skill.mcpTools.join(", ") : "none"}`,
      "",
      skill.description,
      "",
    ].join("\n")),
  ].join("\n");

const writeSkillList = async (options: CommonSkillOptions) => {
  const skills = await listSkills();
  const format = options.format ?? "table";
  if (format === "table" || format === "text") {
    const text = renderSkillsTable(skills);
    if (options.output) {
      await fs.writeFile(options.output, text, "utf8");
      return;
    }
    process.stdout.write(text);
    return;
  }
  if (format === "markdown") {
    const text = renderSkillsMarkdown(skills);
    if (options.output) {
      await fs.writeFile(options.output, text, "utf8");
      return;
    }
    process.stdout.write(text);
    return;
  }
  await writeFormattedOutput({
    command: "skills list",
    data: { skills },
    format,
    output: options.output,
  });
};

const writeSkillShow = async (id: string, options: CommonSkillOptions) => {
  const skill = await getSkill(id);
  if (!skill) {
    process.stderr.write(`Unknown skill '${id}'. Run 'cloudeval skills list' to see available skills.\n`);
    process.exit(1);
  }
  const format = options.format ?? "markdown";
  if (format === "markdown" || format === "text") {
    if (options.output) {
      await fs.writeFile(options.output, skill.content, "utf8");
      return;
    }
    process.stdout.write(skill.content);
    if (!skill.content.endsWith("\n")) {
      process.stdout.write("\n");
    }
    return;
  }
  await writeFormattedOutput({
    command: "skills show",
    data: skill,
    format: format === "table" ? "text" : format,
    output: options.output,
  });
};

const writeSkillDoctor = async (options: CommonSkillOptions) => {
  const result = await validateSkills();
  const format = options.format ?? "table";
  if (format === "table" || format === "text") {
    const failed = result.checks.filter((check) => check.status === "fail");
    const text = [
      formatTextTable(
        [
          {
            ok: result.ok ? "yes" : "no",
            skills: result.skills.length,
            checks: result.checks.length,
            failures: failed.length,
            path: result.skillsPath,
          },
        ],
        [
          { key: "ok", header: "OK", width: 4 },
          { key: "skills", header: "Skills", align: "right" },
          { key: "checks", header: "Checks", align: "right" },
          { key: "failures", header: "Failures", align: "right" },
          { key: "path", header: "Path", maxWidth: 72 },
        ],
      ).trimEnd(),
      failed.length
        ? "\nFailures\n" + formatTextTable(
            failed.map((check) => ({
              check: check.id,
              message: check.message,
              file: check.file ?? "",
            })),
            [
              { key: "check", header: "Check", maxWidth: 44 },
              { key: "message", header: "Message", maxWidth: 72 },
              { key: "file", header: "File", maxWidth: 64 },
            ],
          ).trimEnd()
        : "",
      "",
    ].filter(Boolean).join("\n");
    if (options.output) {
      await fs.writeFile(options.output, `${text}\n`, "utf8");
      return;
    }
    process.stdout.write(`${text}\n`);
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }
  await writeFormattedOutput({
    command: "skills doctor",
    data: result,
    format,
    output: options.output,
  });
  if (!result.ok) {
    process.exitCode = 1;
  }
};

export const registerSkillsCommand = (program: Command) => {
  const command = program
    .command("skills")
    .description("List, inspect, and validate Cloudeval agent skills");

  command
    .command("list")
    .description("List Cloudeval skills")
    .option("--format <format>", "Output format: table, text, json, ndjson, markdown", "table")
    .option("--output <file>", "Output file")
    .action((options: CommonSkillOptions) => writeSkillList(options));

  command
    .command("show")
    .description("Show a Cloudeval skill")
    .argument("<id>", "Skill id")
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "markdown")
    .option("--output <file>", "Output file")
    .action((id: string, options: CommonSkillOptions) => writeSkillShow(id, options));

  command
    .command("doctor")
    .description("Validate Cloudeval skill files and recipe references")
    .option("--format <format>", "Output format: table, text, json, ndjson, markdown", "table")
    .option("--output <file>", "Output file")
    .action((options: CommonSkillOptions) => writeSkillDoctor(options));

  command
    .command("path")
    .description("Print the Cloudeval skills directory")
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file")
    .action(async (options: CommonSkillOptions) => {
      const skillsPath = getSkillsPath();
      if (!options.format || options.format === "text" || options.format === "table") {
        const text = `${skillsPath}\n`;
        if (options.output) {
          await fs.writeFile(options.output, text, "utf8");
          return;
        }
        process.stdout.write(text);
        return;
      }
      await writeFormattedOutput({
        command: "skills path",
        data: { skillsPath },
        format: options.format,
        output: options.output,
      });
    });
};

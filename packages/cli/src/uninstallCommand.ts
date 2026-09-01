import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { Command } from "commander";
import {
  writeFormattedOutput,
  type MachineOutputFormat,
} from "./outputFormatter.js";

type UninstallKind = "file" | "directory" | "shell-profile";
type UninstallStatus =
  | "removed"
  | "updated"
  | "missing"
  | "kept"
  | "would_remove"
  | "would_update";

export interface UninstallAction {
  label: string;
  path: string;
  kind: UninstallKind;
  status: UninstallStatus;
}

export interface UninstallResult {
  dryRun: boolean;
  removeConfig: boolean;
  actions: UninstallAction[];
  notes: string[];
}

interface UninstallCommandOptions {
  yes?: boolean;
  dryRun?: boolean;
  keepConfig?: boolean;
  removeConfig?: boolean;
  format?: MachineOutputFormat;
  output?: string;
}

interface UninstallDeps {
  home?: string;
  platform?: NodeJS.Platform;
  input?: Readable;
  output?: Writable;
  inputIsTTY?: boolean;
}

const pathExists = async (candidate: string): Promise<boolean> => {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const installerBinDir = (home: string): string => path.join(home, ".local", "bin");

const completionPaths = (home: string): string[] => [
  path.join(home, ".local", "share", "bash-completion", "completions", "cloudeval"),
  path.join(home, ".zsh", "completions", "_cloudeval"),
  path.join(home, ".config", "fish", "completions", "cloudeval.fish"),
  path.join(home, ".config", "powershell", "cloudeval-completion.ps1"),
];

const installerArtifactTargets = (
  home: string,
  platform: NodeJS.Platform,
): UninstallAction[] => {
  const binDir = installerBinDir(home);
  const executableName = platform === "win32" ? "cloudeval.exe" : "cloudeval";
  const targets: UninstallAction[] = [
    {
      label: "cloudeval binary",
      path: path.join(binDir, executableName),
      kind: "file",
      status: "missing",
    },
    {
      label: "cloudeval binary",
      path: path.join(binDir, "cloudeval"),
      kind: "file",
      status: "missing",
    },
    {
      label: "eva alias",
      path: path.join(binDir, "eva"),
      kind: "file",
      status: "missing",
    },
    {
      label: "cloud alias",
      path: path.join(binDir, "cloud"),
      kind: "file",
      status: "missing",
    },
    {
      label: "Ink runtime asset",
      path: path.join(binDir, "yoga.wasm"),
      kind: "file",
      status: "missing",
    },
    {
      label: "license notices",
      path: path.join(home, ".local", "share", "cloudeval", "licenses"),
      kind: "directory",
      status: "missing",
    },
    ...completionPaths(home).map((completionPath): UninstallAction => ({
      label: "shell completion",
      path: completionPath,
      kind: "file",
      status: "missing",
    })),
  ];
  return targets.filter((target, index) =>
    targets.findIndex((candidate) => candidate.path === target.path) === index
  );
};

const shellProfilePaths = (home: string): string[] => [
  path.join(home, ".bashrc"),
  path.join(home, ".bash_profile"),
  path.join(home, ".zshrc"),
  path.join(home, ".profile"),
  path.join(home, ".config", "fish", "config.fish"),
];

const removeInstallerPathSnippet = (content: string, binDir: string): string | undefined => {
  const exportLine = `export PATH="${binDir}:$PATH"`;
  const fishLine = `set -gx PATH "${binDir}" $PATH`;
  const lines = content.split(/\r?\n/);
  let changed = false;

  for (let index = 0; index < lines.length; index += 1) {
    if (
      lines[index] === "# Cloudeval CLI" &&
      (lines[index + 1] === exportLine || lines[index + 1] === fishLine)
    ) {
      const removeFrom = index > 0 && lines[index - 1] === "" ? index - 1 : index;
      lines.splice(removeFrom, index - removeFrom + 2);
      changed = true;
      index = Math.max(removeFrom - 1, -1);
    }
  }

  if (!changed) {
    return undefined;
  }

  return lines.join("\n");
};

const removeTarget = async (
  target: UninstallAction,
  dryRun: boolean,
): Promise<UninstallAction> => {
  if (!(await pathExists(target.path))) {
    return { ...target, status: "missing" };
  }
  if (dryRun) {
    return { ...target, status: "would_remove" };
  }
  await fs.rm(target.path, { recursive: target.kind === "directory", force: true });
  return { ...target, status: "removed" };
};

const updateShellProfile = async (
  profilePath: string,
  home: string,
  dryRun: boolean,
): Promise<UninstallAction> => {
  if (!(await pathExists(profilePath))) {
    return {
      label: "shell profile PATH entry",
      path: profilePath,
      kind: "shell-profile",
      status: "missing",
    };
  }

  const content = await fs.readFile(profilePath, "utf8");
  const updated = removeInstallerPathSnippet(content, installerBinDir(home));
  if (updated === undefined) {
    return {
      label: "shell profile PATH entry",
      path: profilePath,
      kind: "shell-profile",
      status: "missing",
    };
  }
  if (dryRun) {
    return {
      label: "shell profile PATH entry",
      path: profilePath,
      kind: "shell-profile",
      status: "would_update",
    };
  }

  await fs.writeFile(profilePath, updated, "utf8");
  return {
    label: "shell profile PATH entry",
    path: profilePath,
    kind: "shell-profile",
    status: "updated",
  };
};

const confirmUninstall = async ({
  input = process.stdin,
  output = process.stderr,
}: {
  input?: Readable;
  output?: Writable;
}): Promise<boolean> => {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      "Remove Cloudeval CLI local installation artifacts? Config is kept unless --remove-config is set. [y/N] ",
    );
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
};

export const handleUninstallCommand = async (
  options: UninstallCommandOptions,
  deps: UninstallDeps = {},
): Promise<UninstallResult> => {
  const home = deps.home ?? os.homedir();
  const platform = deps.platform ?? process.platform;
  const dryRun = Boolean(options.dryRun);
  const removeConfig = Boolean(options.removeConfig);
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stderr;
  const inputIsTTY =
    deps.inputIsTTY ?? ("isTTY" in input ? Boolean((input as NodeJS.ReadStream).isTTY) : false);

  if (!dryRun && !options.yes) {
    if (!inputIsTTY) {
      throw new Error(
        "Cloudeval uninstall requires confirmation. Re-run with --yes for non-interactive removal.",
      );
    }
    const confirmed = await confirmUninstall({ input, output });
    if (!confirmed) {
      throw new Error("Cloudeval uninstall cancelled.");
    }
  }

  const actions: UninstallAction[] = [];
  for (const target of installerArtifactTargets(home, platform)) {
    actions.push(await removeTarget(target, dryRun));
  }

  for (const profilePath of shellProfilePaths(home)) {
    const action = await updateShellProfile(profilePath, home, dryRun);
    if (action.status !== "missing") {
      actions.push(action);
    }
  }

  const configTarget: UninstallAction = {
    label: "config",
    path: path.join(home, ".config", "cloudeval"),
    kind: "directory",
    status: "kept",
  };
  if (removeConfig) {
    actions.push(await removeTarget(configTarget, dryRun));
  } else {
    actions.push(configTarget);
  }

  return {
    dryRun,
    removeConfig,
    actions,
    notes: [
      "If you installed the npm package globally, finish with `npm uninstall -g @ganakailabs/cloudeval-cli`.",
      "MCP client configuration is left untouched. Update or remove MCP entries from each client if needed.",
    ],
  };
};

export const formatUninstallResultText = (result: UninstallResult): string => {
  const lines = [
    "Cloudeval CLI Uninstall",
    `Mode: ${result.dryRun ? "dry run" : "applied"}`,
    `Config: ${result.removeConfig ? "removed when present" : "kept"}`,
  ];

  const changed = result.actions.filter((action) =>
    ["removed", "updated", "would_remove", "would_update"].includes(action.status)
  );
  const kept = result.actions.filter((action) => action.status === "kept");

  if (changed.length) {
    lines.push("", result.dryRun ? "Would clean:" : "Cleaned:");
    for (const action of changed) {
      lines.push(`- ${action.label}: ${action.path}`);
    }
  } else {
    lines.push("", "Cleaned: nothing found");
  }

  if (kept.length) {
    lines.push("", "Kept:");
    for (const action of kept) {
      lines.push(`- ${action.label}: ${action.path}`);
    }
  }

  if (result.notes.length) {
    lines.push("", "Notes:");
    for (const note of result.notes) {
      lines.push(`- ${note}`);
    }
  }

  return `${lines.join("\n")}\n`;
};

export const registerUninstallCommand = (program: Command) => {
  program
    .command("uninstall")
    .description("Remove local Cloudeval CLI installation artifacts")
    .option("-y, --yes", "Remove without prompting for confirmation", false)
    .option("--dry-run", "Show what would be removed without deleting files", false)
    .option("--keep-config", "Keep ~/.config/cloudeval settings, sessions, and auth (default)", true)
    .option("--remove-config", "Also remove ~/.config/cloudeval settings, sessions, and auth", false)
    .option(
      "-f, --format <format>",
      "Output format: text, json, ndjson, markdown",
      "text",
    )
    .option("-o, --output <file>", "Output file")
    .action(async (options: UninstallCommandOptions) => {
      const result = await handleUninstallCommand(options);
      if (options.format === "text" || !options.format) {
        const text = formatUninstallResultText(result);
        if (options.output) {
          await fs.writeFile(options.output, text, "utf8");
          return;
        }
        process.stdout.write(text);
        return;
      }
      await writeFormattedOutput({
        command: "uninstall",
        data: result,
        format: options.format,
        output: options.output,
      });
    });
};

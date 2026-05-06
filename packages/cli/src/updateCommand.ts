import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { Command } from "commander";
import { getCloudevalConfigDir } from "./cliConfig.js";
import {
  writeFormattedOutput,
  type MachineOutputFormat,
} from "./outputFormatter.js";
import { CLI_VERSION } from "./version.js";

const DEFAULT_LATEST_RELEASE_URL =
  "https://api.github.com/repos/ganakailabs/cloudeval-cli/releases/latest";
const DEFAULT_INSTALLER_URL = "https://cli.cloudeval.ai/install.sh";
const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CACHE_FILE = "update-check.json";

type FetchImpl = typeof fetch;
type SpawnImpl = (
  command: string,
  args: string[],
  options: SpawnOptions
) => ChildProcess;

interface ParsedVersion {
  numbers: number[];
  prerelease: string[];
}

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string;
  latestTag: string;
  updateAvailable: boolean;
  checkedAt: string;
  releaseUrl?: string;
  publishedAt?: string;
}

interface UpdateCache {
  checkedAt: string;
  latestVersion: string;
  latestTag: string;
  releaseUrl?: string;
  publishedAt?: string;
}

interface GetUpdateStatusOptions {
  currentVersion?: string;
  latestReleaseUrl?: string;
  fetchImpl?: FetchImpl;
  now?: Date;
}

interface RunInstallerOptions {
  installerUrl?: string;
  targetTag: string;
  fetchImpl?: FetchImpl;
  spawnImpl?: SpawnImpl;
  output?: Writable;
  platform?: NodeJS.Platform;
}

interface UpdateCommandOptions {
  check?: boolean;
  yes?: boolean;
  format?: MachineOutputFormat;
  output?: string;
}

type UpdateCommandAction = "current" | "available" | "skipped" | "updated";

type UpdateCommandResult = UpdateStatus & {
  action: UpdateCommandAction;
};

interface UpdateCommandDeps {
  fetchImpl?: FetchImpl;
  spawnImpl?: SpawnImpl;
  input?: NodeJS.ReadStream | Readable;
  output?: NodeJS.WriteStream | Writable;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export interface VersionNudgeInput {
  commandName: string;
  args: string[];
  options?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  stderrIsTTY?: boolean;
}

export interface VersionNudgeDeps extends UpdateCommandDeps {
  cachePath?: string;
  currentVersion?: string;
  updateCheckIntervalMs?: number;
}

const normalizeVersion = (value: string): string =>
  value.trim().replace(/^v/i, "").split("+")[0] || "0.0.0";

const parseVersion = (value: string): ParsedVersion => {
  const [core, prerelease = ""] = normalizeVersion(value).split("-", 2);
  const numbers = core.split(".").map((part) => {
    const match = part.match(/^\d+/);
    return match ? Number.parseInt(match[0], 10) : 0;
  });
  return {
    numbers,
    prerelease: prerelease ? prerelease.split(".") : [],
  };
};

const compareIdentifiers = (left: string, right: string): number => {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    return Math.sign(Number(left) - Number(right));
  }
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }
  return left.localeCompare(right);
};

export const compareVersionStrings = (left: string, right: string): number => {
  const leftParsed = parseVersion(left);
  const rightParsed = parseVersion(right);
  const width = Math.max(leftParsed.numbers.length, rightParsed.numbers.length);

  for (let index = 0; index < width; index += 1) {
    const leftValue = leftParsed.numbers[index] ?? 0;
    const rightValue = rightParsed.numbers[index] ?? 0;
    if (leftValue !== rightValue) {
      return Math.sign(leftValue - rightValue);
    }
  }

  if (!leftParsed.prerelease.length && rightParsed.prerelease.length) {
    return 1;
  }
  if (leftParsed.prerelease.length && !rightParsed.prerelease.length) {
    return -1;
  }

  const prereleaseWidth = Math.max(
    leftParsed.prerelease.length,
    rightParsed.prerelease.length
  );
  for (let index = 0; index < prereleaseWidth; index += 1) {
    const leftValue = leftParsed.prerelease[index];
    const rightValue = rightParsed.prerelease[index];
    if (leftValue === undefined) {
      return -1;
    }
    if (rightValue === undefined) {
      return 1;
    }
    const compared = compareIdentifiers(leftValue, rightValue);
    if (compared !== 0) {
      return Math.sign(compared);
    }
  }

  return 0;
};

const statusFromLatest = (
  currentVersion: string,
  latest: UpdateCache,
  now: Date
): UpdateStatus => ({
  currentVersion,
  latestVersion: latest.latestVersion,
  latestTag: latest.latestTag,
  updateAvailable: compareVersionStrings(latest.latestVersion, currentVersion) > 0,
  checkedAt: now.toISOString(),
  releaseUrl: latest.releaseUrl,
  publishedAt: latest.publishedAt,
});

export const getUpdateStatus = async ({
  currentVersion = CLI_VERSION,
  latestReleaseUrl = process.env.CLOUDEVAL_UPDATE_CHECK_URL ??
    DEFAULT_LATEST_RELEASE_URL,
  fetchImpl = fetch,
  now = new Date(),
}: GetUpdateStatusOptions = {}): Promise<UpdateStatus> => {
  const response = await fetchImpl(latestReleaseUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `cloudeval-cli/${currentVersion}`,
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to check latest CloudEval CLI release (${response.status} ${response.statusText}).`
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const tagName = typeof payload.tag_name === "string" ? payload.tag_name : "";
  if (!tagName) {
    throw new Error("Latest CloudEval CLI release response did not include tag_name.");
  }
  return statusFromLatest(
    currentVersion,
    {
      checkedAt: now.toISOString(),
      latestVersion: normalizeVersion(tagName),
      latestTag: tagName,
      releaseUrl: typeof payload.html_url === "string" ? payload.html_url : undefined,
      publishedAt:
        typeof payload.published_at === "string" ? payload.published_at : undefined,
    },
    now
  );
};

export const runInstaller = async ({
  installerUrl = process.env.CLOUDEVAL_UPDATE_INSTALLER_URL ??
    DEFAULT_INSTALLER_URL,
  targetTag,
  fetchImpl = fetch,
  spawnImpl = spawn,
  output = process.stderr,
  platform = process.platform,
}: RunInstallerOptions): Promise<void> => {
  if (platform === "win32") {
    throw new Error(
      "Automatic update currently requires bash. Install the latest CLI from https://cli.cloudeval.ai/install.sh in Git Bash, WSL, or another POSIX shell."
    );
  }

  const response = await fetchImpl(installerUrl, {
    headers: {
      Accept: "text/x-shellscript,text/plain,*/*",
      "User-Agent": `cloudeval-cli/${CLI_VERSION}`,
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to download CloudEval CLI installer (${response.status} ${response.statusText}).`
    );
  }
  const installerScript = await response.text();
  const child = spawnImpl("bash", ["-s", "--", targetTag], {
    env: {
      ...process.env,
      CLOUDEVAL_ASSUME_YES: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`CloudEval CLI installer exited with code ${code ?? "unknown"}.`));
    });
    child.stdout?.on("data", (chunk) => output.write(chunk));
    child.stderr?.on("data", (chunk) => output.write(chunk));
    if (!child.stdin) {
      reject(new Error("Failed to open installer stdin."));
      return;
    }
    child.stdin.end(installerScript);
  });
};

const getUpdateCachePath = (): string =>
  path.join(getCloudevalConfigDir(), UPDATE_CACHE_FILE);

const readCache = async (cachePath: string): Promise<UpdateCache | undefined> => {
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.checkedAt === "string" &&
      typeof parsed.latestVersion === "string" &&
      typeof parsed.latestTag === "string"
    ) {
      return parsed;
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      return undefined;
    }
  }
  return undefined;
};

const writeCache = async (cachePath: string, status: UpdateStatus): Promise<void> => {
  await fs.mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    cachePath,
    `${JSON.stringify(
      {
        checkedAt: status.checkedAt,
        latestVersion: status.latestVersion,
        latestTag: status.latestTag,
        releaseUrl: status.releaseUrl,
        publishedAt: status.publishedAt,
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
};

const getCachedUpdateStatus = async ({
  cachePath = getUpdateCachePath(),
  currentVersion = CLI_VERSION,
  fetchImpl,
  now = new Date(),
  updateCheckIntervalMs = DEFAULT_UPDATE_CHECK_INTERVAL_MS,
}: VersionNudgeDeps): Promise<UpdateStatus> => {
  const cached = await readCache(cachePath);
  if (cached) {
    const checkedAt = Date.parse(cached.checkedAt);
    if (Number.isFinite(checkedAt) && now.getTime() - checkedAt < updateCheckIntervalMs) {
      return statusFromLatest(currentVersion, cached, now);
    }
  }

  const status = await getUpdateStatus({ currentVersion, fetchImpl, now });
  await writeCache(cachePath, status);
  return status;
};

const canPrompt = (input?: NodeJS.ReadStream | Readable): boolean =>
  Boolean("isTTY" in (input ?? {}) ? (input as NodeJS.ReadStream).isTTY : process.stdin.isTTY);

const promptForUpdate = async ({
  input = process.stdin,
  output = process.stderr,
  status,
}: {
  input?: NodeJS.ReadStream | Readable;
  output?: NodeJS.WriteStream | Writable;
  status: UpdateStatus;
}): Promise<boolean> => {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      `CloudEval CLI ${status.latestVersion} is available (current ${status.currentVersion}). Install now? [y/N] `
    );
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
};

export const formatUpdateStatusText = (result: UpdateCommandResult): string => {
  const statusText = (() => {
    if (result.action === "current") {
      return "up to date";
    }
    if (result.action === "available") {
      return "update available";
    }
    if (result.action === "updated") {
      return "updated";
    }
    return "skipped";
  })();

  const lines = [
    "CloudEval CLI Update",
    `Status: ${statusText}`,
    `Current version: ${result.currentVersion}`,
    `Latest version: ${result.latestVersion}`,
    `Latest tag: ${result.latestTag}`,
  ];

  if (result.releaseUrl) {
    lines.push(`Release: ${result.releaseUrl}`);
  }
  if (result.publishedAt) {
    lines.push(`Published: ${result.publishedAt}`);
  }
  lines.push(`Checked: ${result.checkedAt}`);

  if (result.action === "available") {
    lines.push("Next step: run `cloudeval update --yes` to install.");
  } else if (result.action === "skipped") {
    lines.push("Next step: run `cloudeval update --yes` when you are ready.");
  }

  return `${lines.join("\n")}\n`;
};

export const handleUpdateCommand = async (
  options: UpdateCommandOptions,
  deps: UpdateCommandDeps = {}
): Promise<UpdateCommandResult> => {
  const status = await getUpdateStatus({
    fetchImpl: deps.fetchImpl,
    now: deps.now,
  });

  if (!status.updateAvailable) {
    return { ...status, action: "current" as const };
  }
  if (options.check) {
    return { ...status, action: "available" as const };
  }

  const confirmed = options.yes
    ? true
    : canPrompt(deps.input)
      ? await promptForUpdate({
          input: deps.input,
          output: deps.output,
          status,
        })
      : false;

  if (!confirmed) {
    if (!canPrompt(deps.input)) {
      throw new Error(
        `CloudEval CLI ${status.latestVersion} is available. Re-run with --yes to update non-interactively.`
      );
    }
    return { ...status, action: "skipped" as const };
  }

  await runInstaller({
    targetTag: status.latestTag,
    fetchImpl: deps.fetchImpl,
    spawnImpl: deps.spawnImpl,
    output: deps.output,
  });

  return { ...status, action: "updated" as const };
};

const suppressedNudgeCommands = new Set([
  "update",
  "completion",
  "help",
  "capabilities",
  "mcp",
  "banner",
]);

const textLikeFormats = new Set(["text", "summary", "table", "tui"]);

export const shouldAttemptVersionNudge = ({
  commandName,
  args,
  options = {},
  env = process.env,
  stdinIsTTY = process.stdin.isTTY,
  stdoutIsTTY = process.stdout.isTTY,
  stderrIsTTY = process.stderr.isTTY,
}: VersionNudgeInput): boolean => {
  if (
    env.CI ||
    env.CLOUDEVAL_HEADLESS_LOGIN ||
    env.CLOUDEVAL_NO_UPDATE_CHECK ||
    env.CLOUDEVAL_DISABLE_UPDATE_CHECK
  ) {
    return false;
  }
  if (!stdinIsTTY || !stdoutIsTTY || !stderrIsTTY) {
    return false;
  }
  if (suppressedNudgeCommands.has(commandName)) {
    return false;
  }
  if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V")) {
    return false;
  }
  if (options.quiet || options.nonInteractive || options.json || options.output) {
    return false;
  }
  const requestedFormat =
    typeof options.format === "string" ? options.format.toLowerCase() : undefined;
  return !requestedFormat || textLikeFormats.has(requestedFormat);
};

export const maybeShowUpdateNudge = async (
  input: VersionNudgeInput,
  deps: VersionNudgeDeps = {}
): Promise<void> => {
  if (!shouldAttemptVersionNudge(input)) {
    return;
  }

  try {
    const status = await getCachedUpdateStatus(deps);
    if (!status.updateAvailable) {
      return;
    }
    const confirmed = await promptForUpdate({
      input: deps.input,
      output: deps.output,
      status,
    });
    if (!confirmed) {
      (deps.output ?? process.stderr).write(
        "Skipping update. Run `cloudeval update` later.\n"
      );
      return;
    }
    await runInstaller({
      targetTag: status.latestTag,
      fetchImpl: deps.fetchImpl,
      spawnImpl: deps.spawnImpl,
      output: deps.output,
    });
  } catch {
    // The nudge must never block the user's requested command.
  }
};

export const registerUpdateCommand = (program: Command) => {
  program
    .command("update")
    .description("Update CloudEval CLI to the latest published version")
    .option("-c, --check", "Check for the latest version without installing", false)
    .option("-y, --yes", "Install without prompting for confirmation", false)
    .option(
      "-f, --format <format>",
      "Output format: text, json, ndjson, markdown",
      "text"
    )
    .option("-o, --output <file>", "Output file")
    .action(async (options: UpdateCommandOptions) => {
      const result = await handleUpdateCommand(options);
      if (options.format === "text" || !options.format) {
        const text = formatUpdateStatusText(result);
        if (options.output) {
          await fs.writeFile(options.output, text, "utf8");
          return;
        }
        process.stdout.write(text);
        return;
      }
      await writeFormattedOutput({
        command: "update",
        data: result,
        format: options.format,
        output: options.output,
      });
    });
};

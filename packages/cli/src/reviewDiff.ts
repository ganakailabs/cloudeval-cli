import { spawn } from "node:child_process";

export type ReviewDiffFile = {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "changed";
  additions?: number;
  deletions?: number;
  previousPath?: string;
  patch?: string;
  patchTruncated?: boolean;
};

export type ReviewDiffSummary = {
  files_changed: number;
  additions: number;
  deletions: number;
  base_ref?: string;
  base_commit_sha?: string;
  head_ref?: string;
  head_commit_sha?: string;
  patch_truncated?: boolean;
};

export type ReviewDiffResult = {
  summary: ReviewDiffSummary;
  changedFiles: ReviewDiffFile[];
  warnings: string[];
};

export type ReviewDiffConfig = {
  enabled: boolean;
  baseRef?: string;
  maxFiles: number;
  maxPatchBytes: number;
};

type GitResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

const runGit = async (cwd: string, args: string[]): Promise<GitResult> => {
  const child = spawn("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return {
    ok: exitCode === 0,
    stdout: Buffer.concat(stdout).toString("utf8").trim(),
    stderr: Buffer.concat(stderr).toString("utf8").trim(),
  };
};

const cleanPath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^\/+/, "").trim();

const parseNumber = (value: string): number | undefined => {
  if (!value || value === "-") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const statusName = (status: string): ReviewDiffFile["status"] => {
  const marker = status.charAt(0).toUpperCase();
  if (marker === "A") return "added";
  if (marker === "M") return "modified";
  if (marker === "D") return "deleted";
  if (marker === "R") return "renamed";
  if (marker === "C") return "copied";
  return "changed";
};

const parseNameStatus = (stdout: string): ReviewDiffFile[] =>
  stdout
    .split(/\r?\n/)
    .map((line): ReviewDiffFile | undefined => {
      const parts = line.split("\t").filter(Boolean);
      if (parts.length < 2) return undefined;
      const status = statusName(parts[0]);
      if (status === "renamed" || status === "copied") {
        return {
          path: cleanPath(parts[2] ?? parts[1]),
          previousPath: cleanPath(parts[1]),
          status,
        };
      }
      return {
        path: cleanPath(parts[1]),
        status,
      };
    })
    .filter((file): file is ReviewDiffFile => Boolean(file?.path));

const parseNumstat = (stdout: string): Map<string, { additions?: number; deletions?: number }> => {
  const stats = new Map<string, { additions?: number; deletions?: number }>();
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const additions = parseNumber(parts[0]);
    const deletions = parseNumber(parts[1]);
    const pathValue = cleanPath(parts.slice(2).join("\t").replace(/\{.* => /, "").replace(/\}/, ""));
    if (!pathValue) continue;
    stats.set(pathValue, { additions, deletions });
  }
  return stats;
};

const resolveCommit = async (
  cwd: string,
  ref: string | undefined,
): Promise<string | undefined> => {
  if (!ref) return undefined;
  const result = await runGit(cwd, ["rev-parse", ref]);
  return result.ok && result.stdout ? result.stdout : undefined;
};

const firstWorkingRange = async (
  cwd: string,
  baseRef: string,
  headRef: string,
): Promise<{ rangeArgs: string[]; warning?: string } | undefined> => {
  const attempts = [
    [`${baseRef}...${headRef}`],
    [baseRef, headRef],
  ];
  for (const args of attempts) {
    const probe = await runGit(cwd, ["diff", "--quiet", ...args]);
    if (probe.ok || probe.stderr === "") {
      return { rangeArgs: args };
    }
  }
  const last = await runGit(cwd, ["diff", "--name-only", baseRef, headRef]);
  if (last.ok) {
    return { rangeArgs: [baseRef, headRef] };
  }
  return {
    rangeArgs: [],
    warning: `Git diff unavailable for ${baseRef}..${headRef}: ${last.stderr || "unknown git error"}`,
  };
};

const appendPatches = async ({
  cwd,
  rangeArgs,
  files,
  maxPatchBytes,
}: {
  cwd: string;
  rangeArgs: string[];
  files: ReviewDiffFile[];
  maxPatchBytes: number;
}): Promise<{ files: ReviewDiffFile[]; truncated: boolean }> => {
  if (maxPatchBytes <= 0 || !rangeArgs.length) {
    return { files, truncated: false };
  }
  let used = 0;
  let truncated = false;
  const patched: ReviewDiffFile[] = [];
  for (const file of files) {
    if (used >= maxPatchBytes) {
      patched.push({ ...file, patchTruncated: true });
      truncated = true;
      continue;
    }
    const pathForDiff = file.previousPath ?? file.path;
    const patch = await runGit(cwd, [
      "diff",
      "--unified=3",
      "--no-ext-diff",
      ...rangeArgs,
      "--",
      pathForDiff,
      file.path,
    ]);
    if (!patch.ok || !patch.stdout) {
      patched.push(file);
      continue;
    }
    const remaining = maxPatchBytes - used;
    const content =
      patch.stdout.length > remaining
        ? patch.stdout.slice(0, remaining)
        : patch.stdout;
    used += content.length;
    truncated = truncated || patch.stdout.length > remaining;
    patched.push({
      ...file,
      patch: content,
      ...(patch.stdout.length > remaining ? { patchTruncated: true } : {}),
    });
  }
  return { files: patched, truncated };
};

const yamlBlock = (configText: string | undefined, pathKeys: string[]): string | undefined => {
  if (!configText) return undefined;
  const lines = configText.split(/\r?\n/).map((raw) => ({
    raw,
    indent: raw.match(/^\s*/)?.[0].length ?? 0,
    trimmed: raw.trim(),
  }));
  let searchStart = 0;
  let searchEnd = lines.length;
  let parentIndent = -1;
  for (const key of pathKeys) {
    let found = -1;
    for (let index = searchStart; index < searchEnd; index += 1) {
      const line = lines[index];
      if (line.trimmed === `${key}:` && line.indent > parentIndent) {
        found = index;
        break;
      }
    }
    if (found === -1) return undefined;
    const blockIndent = lines[found].indent;
    let blockEnd = searchEnd;
    for (let index = found + 1; index < searchEnd; index += 1) {
      const line = lines[index];
      if (line.trimmed && line.indent <= blockIndent) {
        blockEnd = index;
        break;
      }
    }
    searchStart = found + 1;
    searchEnd = blockEnd;
    parentIndent = blockIndent;
  }
  return lines.slice(searchStart, searchEnd).map((line) => line.raw).join("\n");
};

const scalar = (block: string | undefined, key: string): string | undefined => {
  const match = block?.match(
    new RegExp(`^\\s*${key}\\s*:\\s*["']?([^"'\\n#]+)["']?\\s*(?:#.*)?$`, "m"),
  );
  return match?.[1]?.trim() || undefined;
};

const boolValue = (block: string | undefined, key: string): boolean | undefined => {
  const value = scalar(block, key);
  if (value === undefined) return undefined;
  if (/^(true|yes|on|1)$/i.test(value)) return true;
  if (/^(false|no|off|0)$/i.test(value)) return false;
  return undefined;
};

const numberValue = (block: string | undefined, key: string): number | undefined => {
  const value = scalar(block, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

export const parseReviewDiffConfig = (configText?: string): ReviewDiffConfig => {
  const block = yamlBlock(configText, ["ci", "review", "diff"]);
  return {
    enabled: boolValue(block, "enabled") ?? true,
    baseRef: scalar(block, "base_ref") ?? scalar(block, "baseRef"),
    maxFiles: numberValue(block, "max_files") ?? numberValue(block, "maxFiles") ?? 300,
    maxPatchBytes:
      numberValue(block, "max_patch_bytes") ?? numberValue(block, "maxPatchBytes") ?? 250_000,
  };
};

export const collectReviewDiff = async ({
  cwd,
  baseRef,
  headRef = "HEAD",
  maxFiles = 300,
  maxPatchBytes = 250_000,
  enabled = true,
  env = process.env,
}: {
  cwd: string;
  baseRef?: string;
  headRef?: string;
  maxFiles?: number;
  maxPatchBytes?: number;
  enabled?: boolean;
  env?: Record<string, string | undefined>;
}): Promise<ReviewDiffResult> => {
  if (!enabled) {
    return {
      changedFiles: [],
      summary: { files_changed: 0, additions: 0, deletions: 0 },
      warnings: [],
    };
  }
  const githubBase = env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : undefined;
  const chosenBase = baseRef || githubBase || "origin/main";
  const range = await firstWorkingRange(cwd, chosenBase, headRef);
  if (!range || !range.rangeArgs.length) {
    return {
      changedFiles: [],
      summary: {
        files_changed: 0,
        additions: 0,
        deletions: 0,
        base_ref: chosenBase,
        head_ref: headRef,
      },
      warnings: [range?.warning ?? `Git diff unavailable for ${chosenBase}..${headRef}`],
    };
  }

  const [nameStatus, numstat, baseCommitSha, headCommitSha] = await Promise.all([
    runGit(cwd, ["diff", "--name-status", "--find-renames", ...range.rangeArgs]),
    runGit(cwd, ["diff", "--numstat", "--find-renames", ...range.rangeArgs]),
    resolveCommit(cwd, chosenBase),
    resolveCommit(cwd, headRef),
  ]);

  if (!nameStatus.ok) {
    return {
      changedFiles: [],
      summary: {
        files_changed: 0,
        additions: 0,
        deletions: 0,
        base_ref: chosenBase,
        head_ref: headRef,
        base_commit_sha: baseCommitSha,
        head_commit_sha: headCommitSha,
      },
      warnings: [`Git diff unavailable for ${chosenBase}..${headRef}: ${nameStatus.stderr}`],
    };
  }

  const stats = parseNumstat(numstat.ok ? numstat.stdout : "");
  const files = parseNameStatus(nameStatus.stdout)
    .slice(0, maxFiles)
    .map((file) => {
      const stat = stats.get(file.path) ?? stats.get(file.previousPath ?? "");
      return {
        ...file,
        additions: stat?.additions,
        deletions: stat?.deletions,
      };
    });
  const patched = await appendPatches({
    cwd,
    rangeArgs: range.rangeArgs,
    files,
    maxPatchBytes,
  });
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  return {
    changedFiles: patched.files,
    summary: {
      files_changed: files.length,
      additions,
      deletions,
      base_ref: chosenBase,
      base_commit_sha: baseCommitSha,
      head_ref: headRef,
      head_commit_sha: headCommitSha,
      ...(patched.truncated ? { patch_truncated: true } : {}),
    },
    warnings: [
      ...(nameStatus.stdout.split(/\r?\n/).filter(Boolean).length > maxFiles
        ? [`Changed file list was capped at ${maxFiles} files.`]
        : []),
      ...(patched.truncated ? [`Diff patch snippets were capped at ${maxPatchBytes} bytes.`] : []),
    ],
  };
};

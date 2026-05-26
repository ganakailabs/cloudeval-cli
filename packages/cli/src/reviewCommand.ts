import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Command } from "commander";
import {
  addAuthOptions,
  resolveAuthContext,
  type AuthGuardDeps,
  type AuthGuardOptions,
} from "./authGuard.js";
import { fetchCloudEvalJson } from "./apiClient.js";
import {
  writeFormattedOutput,
  type MachineOutputFormat,
} from "./outputFormatter.js";

const DIRTY_REVIEW_MESSAGE =
  "Reviews pushed commits only. Add --ignore-dirty to review HEAD anyway.";

type ReviewOptions = AuthGuardOptions & {
  project?: string;
  repo?: string;
  ref?: string;
  commitSha?: string;
  sourceRoot?: string;
  config?: string;
  ignoreDirty?: boolean;
  output?: string;
  format?: MachineOutputFormat;
  quiet?: boolean;
  progress?: string;
  model?: string;
};

export interface RegisterReviewCommandOptions extends AuthGuardDeps {
  defaultBaseUrl: string;
}

type GitResult = {
  ok: boolean;
  stdout: string;
};

const runGit = async (cwd: string, args: string[]): Promise<GitResult> => {
  const child = spawn("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  const exitCode = await new Promise<number | null>((resolve) =>
    child.on("exit", resolve),
  );
  return {
    ok: exitCode === 0,
    stdout: Buffer.concat(stdout).toString("utf8").trim(),
  };
};

const normalizeGithubRepo = (value?: string): string | undefined => {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const withoutGit = text.replace(/\.git$/i, "");
  const httpsMatch = withoutGit.match(/github\.com[:/]([^/\s]+)\/([^/\s]+)$/i);
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }
  if (/^[^/\s]+\/[^/\s]+$/.test(withoutGit)) {
    return withoutGit;
  }
  return undefined;
};

const resolveGitMetadata = async (
  cwd: string,
  options: ReviewOptions,
): Promise<{
  repo?: string;
  ref?: string;
  commitSha?: string;
  dirty: boolean;
}> => {
  const status = await runGit(cwd, ["status", "--porcelain"]);
  const dirty = status.ok && status.stdout.length > 0;
  const remote = options.repo
    ? { ok: true, stdout: options.repo }
    : await runGit(cwd, ["remote", "get-url", "origin"]);
  const ref = options.ref
    ? options.ref
    : (await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout;
  const sha = options.commitSha
    ? options.commitSha
    : (await runGit(cwd, ["rev-parse", "HEAD"])).stdout;

  return {
    repo: normalizeGithubRepo(remote.stdout),
    ref: ref && ref !== "HEAD" ? ref : undefined,
    commitSha: sha || undefined,
    dirty,
  };
};

const asRecord = (value: unknown): Record<string, any> =>
  value && typeof value === "object" ? (value as Record<string, any>) : {};

const sourceOf = (project: Record<string, any>): Record<string, any> =>
  asRecord(project.iac_source ?? project.iacSource);

const resolveProjectId = async ({
  baseUrl,
  token,
  requestedProjectId,
  repo,
  ref,
  sourceRoot,
}: {
  baseUrl: string;
  token?: string;
  requestedProjectId?: string;
  repo?: string;
  ref?: string;
  sourceRoot?: string;
}): Promise<string> => {
  if (requestedProjectId) {
    return requestedProjectId;
  }
  if (!repo) {
    throw new Error("Provide --repo or run inside a GitHub-backed Git repository.");
  }
  const projects = await fetchCloudEvalJson<unknown[]>({
    baseUrl,
    authToken: token,
    path: "/projects",
  });
  const matches = projects.filter((project) => {
    const record = asRecord(project);
    const source = sourceOf(record);
    if (source.type !== "github") return false;
    if (source.repo_full_name !== repo) return false;
    if (sourceRoot !== undefined && String(source.source_root ?? "") !== sourceRoot) {
      return false;
    }
    if (ref && source.ref && source.ref !== ref) {
      return false;
    }
    return true;
  });
  if (matches.length === 1) {
    return String(asRecord(matches[0]).id);
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple CloudEval projects match ${repo}. Pass --project to choose one.`,
    );
  }
  throw new Error(
    `No CloudEval GitHub project matched ${repo}. Create one in CloudEval or pass --project.`,
  );
};

const readConfigText = async (cwd: string, options: ReviewOptions): Promise<string | undefined> => {
  const configPath = options.config ?? path.join(cwd, ".cloudeval", "config.yaml");
  try {
    return await fs.readFile(path.resolve(cwd, configPath), "utf8");
  } catch {
    return undefined;
  }
};

const parseGateConfig = (configText?: string):
  | {
      overallScoreMin: number;
      failOnHighRisk: boolean;
      maxMonthlyCost?: number;
    }
  | undefined => {
  if (!configText || !/^\s*ci\s*:/m.test(configText) || !/^\s*gates\s*:/m.test(configText)) {
    return undefined;
  }
  const numberValue = (key: string): number | undefined => {
    const match = configText.match(new RegExp(`^\\s*${key}\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)`, "m"));
    return match ? Number(match[1]) : undefined;
  };
  const booleanValue = (key: string): boolean | undefined => {
    const match = configText.match(new RegExp(`^\\s*${key}\\s*:\\s*(true|false)`, "im"));
    return match ? match[1].toLowerCase() === "true" : undefined;
  };
  return {
    overallScoreMin: numberValue("overall_score_min") ?? 80,
    failOnHighRisk: booleanValue("fail_on_high_risk") ?? true,
    maxMonthlyCost: numberValue("max_monthly_cost"),
  };
};

const numberFrom = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
};

const evaluateGate = ({
  configText,
  waf,
  cost,
}: {
  configText?: string;
  waf?: Record<string, any>;
  cost?: Record<string, any>;
}) => {
  const gateConfig = parseGateConfig(configText);
  const overallScore = numberFrom(
    waf?.parsed?.score?.overall,
    waf?.parsed?.overall_score,
    waf?.raw?.score,
  );
  const highRisk = numberFrom(
    waf?.parsed?.counts?.highRisk,
    waf?.parsed?.counts?.high_count,
    waf?.parsed?.highRisk,
  );
  const monthlyCost = numberFrom(
    cost?.parsed?.totalSpend?.amount,
    cost?.parsed?.total_spend?.amount,
    cost?.raw?.total,
  );
  if (!gateConfig) {
    return {
      status: "warn",
      reason: "ci.gates is not configured in .cloudeval/config.yaml.",
      overallScore,
      highRisk,
      monthlyCost,
    };
  }
  const failures: string[] = [];
  if (overallScore !== undefined && overallScore < gateConfig.overallScoreMin) {
    failures.push(
      `overall score ${overallScore} is below ${gateConfig.overallScoreMin}`,
    );
  }
  if (gateConfig.failOnHighRisk && highRisk !== undefined && highRisk > 0) {
    failures.push(`${highRisk} high-risk architecture findings`);
  }
  if (
    gateConfig.maxMonthlyCost !== undefined &&
    monthlyCost !== undefined &&
    monthlyCost > gateConfig.maxMonthlyCost
  ) {
    failures.push(`monthly cost ${monthlyCost} exceeds ${gateConfig.maxMonthlyCost}`);
  }
  return {
    status: failures.length ? "fail" : "pass",
    failures,
    thresholds: gateConfig,
    overallScore,
    highRisk,
    monthlyCost,
  };
};

const safeFetch = async <T>(input: Parameters<typeof fetchCloudEvalJson<T>>[0]): Promise<T | undefined> => {
  try {
    return await fetchCloudEvalJson<T>(input);
  } catch {
    return undefined;
  }
};

const buildMarkdownSummary = (data: Record<string, any>): string => {
  const gateStatus = String(data.gate?.status ?? "unknown").toUpperCase();
  const score = data.gate?.overallScore ?? "unknown";
  const cost = data.gate?.monthlyCost ?? "unknown";
  return [
    "### CloudEval review",
    "",
    `- **Project:** \`${data.projectId}\``,
    `- **Repository:** \`${data.repo ?? "unknown"}\``,
    `- **Ref:** \`${data.ref ?? "unknown"}\``,
    `- **Commit:** \`${String(data.commitSha ?? "unknown").slice(0, 12)}\``,
    `- **Gate:** ${gateStatus}`,
    `- **Well-Architected score:** ${score}`,
    `- **Monthly cost:** ${cost}`,
  ].join("\n");
};

export const registerReviewCommand = (
  program: Command,
  deps: RegisterReviewCommandOptions,
) => {
  const command = addAuthOptions(
    program.command("review").description("Review the current GitHub-backed project from a pushed commit"),
    deps.defaultBaseUrl,
  )
    .option("--project <id>", "CloudEval project id. If omitted, resolve by GitHub repo metadata.")
    .option("--repo <owner/repo>", "GitHub repository. Defaults to git origin.")
    .option("--ref <name>", "Git branch/ref. Defaults to current branch.")
    .option("--commit-sha <sha>", "Commit SHA to sync/review. Defaults to local HEAD.")
    .option("--source-root <path>", "GitHub source root used by the CloudEval project.")
    .option("--config <path>", "Path to .cloudeval/config.yaml for gate thresholds.")
    .option("--ignore-dirty", "Review HEAD even if the local working tree has uncommitted changes.", false)
    .option("--output <dir>", "Write review.json and review.md into a directory.")
    .option("--quiet", "Accepted for CI parity; review output stays machine-readable.", false)
    .option("--progress <mode>", "Accepted for CI parity; review does not stream progress.", "none")
    .option("--model <model>", "Accepted for CI parity with ask/agent modes.")
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text");

  command.action(async (options: ReviewOptions, actionCommand) => {
    try {
      const cwd = process.cwd();
      const git = await resolveGitMetadata(cwd, options);
      if (git.dirty && !options.ignoreDirty) {
        throw new Error(DIRTY_REVIEW_MESSAGE);
      }
      const context = await resolveAuthContext(options, actionCommand, deps);
      const repo = normalizeGithubRepo(options.repo) ?? git.repo;
      const ref = options.ref ?? git.ref;
      const commitSha = options.commitSha ?? git.commitSha;
      const sourceRoot = options.sourceRoot;
      const projectId = await resolveProjectId({
        baseUrl: context.baseUrl,
        token: context.token,
        requestedProjectId: options.project,
        repo,
        ref,
        sourceRoot,
      });

      const sync = await fetchCloudEvalJson({
        baseUrl: context.baseUrl,
        authToken: context.token,
        path: `/projects/${projectId}/github/sync`,
        method: "POST",
        body: commitSha ? { commit_sha: commitSha } : {},
        idempotencyKey: `cloudeval-review-${projectId}-${commitSha ?? "head"}`,
      });
      const [cost, waf, configText] = await Promise.all([
        safeFetch<Record<string, any>>({
          baseUrl: context.baseUrl,
          authToken: context.token,
          path: `/cost-reports/${projectId}/full`,
        }),
        safeFetch<Record<string, any>>({
          baseUrl: context.baseUrl,
          authToken: context.token,
          path: `/well-architected-reports/${projectId}/full`,
        }),
        readConfigText(cwd, options),
      ]);
      const data = {
        projectId,
        repo,
        ref,
        commitSha,
        sourceRoot,
        sync,
        gate: evaluateGate({ configText, waf, cost }),
      };
      const summaryMarkdown = buildMarkdownSummary(data);
      const filesWritten: string[] = [];
      if (options.output) {
        const outputDir = path.resolve(options.output);
        await fs.mkdir(outputDir, { recursive: true });
        const jsonPath = path.join(outputDir, "review.json");
        const markdownPath = path.join(outputDir, "review.md");
        await fs.writeFile(jsonPath, JSON.stringify(data, null, 2), "utf8");
        await fs.writeFile(markdownPath, summaryMarkdown, "utf8");
        filesWritten.push(jsonPath, markdownPath);
      }
      await writeFormattedOutput({
        command: "review",
        data: { ...data, summaryMarkdown },
        format: options.format,
        filesWritten,
      });
      if (data.gate.status === "fail") {
        process.exit(1);
      }
    } catch (error: any) {
      console.error(error?.message ?? "Review failed");
      process.exit(1);
    }
  });
};

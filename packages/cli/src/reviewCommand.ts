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
  wait?: boolean;
  waitTimeout?: string;
  pollInterval?: string;
  aiSummary?: boolean;
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

const parsePositiveInteger = (
  value: string | undefined,
  flagName: string,
  fallback: number,
): number => {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive number of milliseconds.`);
  }
  return Math.floor(parsed);
};

const extractJobId = (value: unknown): string | undefined => {
  const record = asRecord(value);
  const job = asRecord(record.job);
  const candidates = [
    record.job_id,
    record.jobId,
    record.id,
    job.job_id,
    job.jobId,
    job.id,
  ];
  return candidates.find((candidate): candidate is string =>
    typeof candidate === "string" && candidate.trim().length > 0,
  );
};

const isTerminalJobStatus = (value: unknown): boolean => {
  const status = String(asRecord(value).status ?? "").toUpperCase();
  return [
    "COMPLETED",
    "SUCCEEDED",
    "SUCCESS",
    "FAILED",
    "CANCELLED",
    "CANCELED",
    "ERROR",
  ].includes(status);
};

const isFailedJobStatus = (value: unknown): boolean => {
  const status = String(asRecord(value).status ?? "").toUpperCase();
  return ["FAILED", "CANCELLED", "CANCELED", "ERROR"].includes(status);
};

const waitForJob = async ({
  baseUrl,
  token,
  userId,
  jobId,
  pollIntervalMs,
  waitTimeoutMs,
}: {
  baseUrl: string;
  token?: string;
  userId?: string;
  jobId: string;
  pollIntervalMs: number;
  waitTimeoutMs: number;
}): Promise<Record<string, any>> => {
  const startedAt = Date.now();
  let lastStatus: Record<string, any> | undefined;
  for (;;) {
    const query = userId ? `?user_id=${encodeURIComponent(userId)}` : "";
    lastStatus = await fetchCloudEvalJson<Record<string, any>>({
      baseUrl,
      authToken: token,
      path: `/jobs/${encodeURIComponent(jobId)}${query}`,
    });
    const status = String(lastStatus.status ?? "unknown");
    process.stderr.write(`github sync job ${jobId}: ${status}\n`);
    if (isTerminalJobStatus(lastStatus)) {
      if (isFailedJobStatus(lastStatus)) {
        throw new Error(`GitHub sync job ${jobId} finished with status ${status}.`);
      }
      return lastStatus;
    }
    if (Date.now() - startedAt > waitTimeoutMs) {
      throw new Error(`Timed out waiting for GitHub sync job ${jobId}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
};

const fetchProjectById = async ({
  baseUrl,
  token,
  projectId,
}: {
  baseUrl: string;
  token?: string;
  projectId: string;
}): Promise<Record<string, any> | undefined> => {
  const projects = await safeFetch<unknown[]>({
    baseUrl,
    authToken: token,
    path: "/projects",
  });
  return projects
    ?.map(asRecord)
    .find((project) => project.id === projectId);
};

const buildAiSummaryPrompt = (data: Record<string, any>): string => [
  "Write a concise CloudEval pull request review summary in Markdown.",
  "Focus on gate status, Well-Architected posture, cost posture, and security/operational risks.",
  "Keep it under 160 words. Do not invent facts not present below.",
  "",
  `Project: ${data.projectId}`,
  `Repository: ${data.repo ?? "unknown"}`,
  `Ref: ${data.ref ?? "unknown"}`,
  `Commit: ${data.commitSha ?? "unknown"}`,
  `Gate: ${String(data.gate?.status ?? "unknown").toUpperCase()}`,
  `Well-Architected score: ${data.gate?.overallScore ?? "unknown"}`,
  `High-risk findings: ${data.gate?.highRisk ?? "unknown"}`,
  `Monthly cost: ${data.gate?.monthlyCost ?? "unknown"}`,
  Array.isArray(data.gate?.failures) && data.gate.failures.length
    ? `Gate failures: ${data.gate.failures.join("; ")}`
    : "Gate failures: none reported",
].join("\n");

const generateAiSummary = async ({
  baseUrl,
  token,
  user,
  project,
  model,
  data,
}: {
  baseUrl: string;
  token?: string;
  user?: { id?: string; email?: string; full_name?: string; name?: string };
  project?: Record<string, any>;
  model?: string;
  data: Record<string, any>;
}): Promise<Record<string, any>> => {
  const core = await import("@cloudeval/core");
  const threadId = `review-${data.projectId}-${Date.now()}`;
  let markdown = "";
  for await (const chunk of core.streamChat({
    baseUrl,
    authToken: token,
    message: buildAiSummaryPrompt(data),
    threadId,
    user: {
      id: String(project?.user_id ?? user?.id ?? "cli-user"),
      name: String(user?.full_name ?? user?.name ?? user?.email ?? "CloudEval CI"),
    },
    project: project
      ? {
          id: String(project.id ?? data.projectId),
          name: String(project.name ?? data.projectId),
          user_id: typeof project.user_id === "string" ? project.user_id : undefined,
          cloud_provider:
            typeof project.cloud_provider === "string" ? project.cloud_provider : undefined,
          type: typeof project.type === "string" ? project.type : undefined,
          connection_ids: Array.isArray(project.connection_ids)
            ? project.connection_ids
            : undefined,
        }
      : {
          id: String(data.projectId),
          name: String(data.projectId),
    },
    settings: {
      mode: "ask",
      ...(model ? { model } : {}),
    },
    completeAfterResponse: true,
    responseCompletionGraceMs: 250,
    streamIdleTimeoutMs: 30000,
  })) {
    const content = (chunk as any)?.content;
    if (chunk.type === "responding" && typeof content === "string") {
      markdown += content;
    }
  }
  return {
    enabled: true,
    mode: "ask",
    ...(model ? { model } : {}),
    markdown: markdown.trim(),
    threadId,
  };
};

const buildMarkdownSummary = (data: Record<string, any>): string => {
  const gateStatus = String(data.gate?.status ?? "unknown").toUpperCase();
  const score = data.gate?.overallScore ?? "unknown";
  const cost = data.gate?.monthlyCost ?? "unknown";
  const lines = [
    "### CloudEval review",
    "",
    `- **Project:** \`${data.projectId}\``,
    `- **Repository:** \`${data.repo ?? "unknown"}\``,
    `- **Ref:** \`${data.ref ?? "unknown"}\``,
    `- **Commit:** \`${String(data.commitSha ?? "unknown").slice(0, 12)}\``,
    `- **Gate:** ${gateStatus}`,
    `- **Well-Architected score:** ${score}`,
    `- **Monthly cost:** ${cost}`,
  ];
  if (data.aiSummary?.markdown) {
    lines.push("", "## AI summary", "", data.aiSummary.markdown);
  }
  return lines.join("\n");
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
    .option("--no-wait", "Submit GitHub sync and return without waiting for analysis.")
    .option("--wait-timeout <ms>", "Maximum time to wait for GitHub sync.", "900000")
    .option("--poll-interval <ms>", "Polling interval while waiting for GitHub sync.", "5000")
    .option("--no-ai-summary", "Skip the AI-written review summary.")
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
      const finalStatus = options.wait === false
        ? undefined
        : extractJobId(sync)
          ? await waitForJob({
              baseUrl: context.baseUrl,
              token: context.token,
              userId: context.user?.id,
              jobId: extractJobId(sync)!,
              pollIntervalMs: parsePositiveInteger(
                options.pollInterval,
                "--poll-interval",
                5000,
              ),
              waitTimeoutMs: parsePositiveInteger(
                options.waitTimeout,
                "--wait-timeout",
                900000,
              ),
            })
          : undefined;
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
      const project = await fetchProjectById({
        baseUrl: context.baseUrl,
        token: context.token,
        projectId,
      });
      const data: Record<string, any> = {
        projectId,
        repo,
        ref,
        commitSha,
        sourceRoot,
        sync: finalStatus ? { ...asRecord(sync), finalStatus } : sync,
        reports: {
          cost,
          waf,
        },
        gate: evaluateGate({ configText, waf, cost }),
      };
      if (options.aiSummary !== false) {
        try {
          data.aiSummary = await generateAiSummary({
            baseUrl: context.baseUrl,
            token: context.token,
            user: context.user,
            project,
            model: options.model,
            data,
          });
        } catch (error: any) {
          data.aiSummary = {
            enabled: true,
            status: "failed",
            error: error?.message ?? "AI summary failed",
          };
        }
      } else {
        data.aiSummary = { enabled: false };
      }
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
      process.exit(0);
    } catch (error: any) {
      console.error(error?.message ?? "Review failed");
      process.exit(1);
    }
  });
};

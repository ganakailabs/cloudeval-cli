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
import { buildFrontendUrl, resolveFrontendBaseUrl } from "./frontendLinks.js";

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
  aiSummaryMode?: string;
  aiSummaryProfile?: string;
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
      enforcement: "required" | "warn";
      overallScoreMin: number;
      pillarScoreMin?: number;
      pillarScoreMins: Record<string, number>;
      failOnHighRisk: boolean;
      failOnValidationErrors: boolean;
      maxMonthlyCost?: number;
    }
  | undefined => {
  if (!configText || !/^\s*ci\s*:/m.test(configText) || !/^\s*gates\s*:/m.test(configText)) {
    return undefined;
  }
  const stringValue = (key: string): string | undefined => {
    const match = configText.match(new RegExp(`^\\s*${key}\\s*:\\s*([^\\s#]+)`, "m"));
    return match ? match[1].trim() : undefined;
  };
  const numberValue = (key: string): number | undefined => {
    const match = configText.match(new RegExp(`^\\s*${key}\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)`, "m"));
    return match ? Number(match[1]) : undefined;
  };
  const booleanValue = (key: string): boolean | undefined => {
    const match = configText.match(new RegExp(`^\\s*${key}\\s*:\\s*(true|false)`, "im"));
    return match ? match[1].toLowerCase() === "true" : undefined;
  };
  const pillarScoreMins: Record<string, number> = {};
  const pillarBlock = configText.match(/^(\s*)pillars\s*:\s*$(?<body>(?:\n\s+[-\w]+\s*:\s*[0-9]+(?:\.[0-9]+)?\s*)+)/m);
  const pillarBody = pillarBlock?.groups?.body ?? "";
  for (const line of pillarBody.split("\n")) {
    const match = line.match(/^\s+([-\w]+)\s*:\s*([0-9]+(?:\.[0-9]+)?)/);
    if (match) {
      pillarScoreMins[match[1].replace(/-/g, "_").toLowerCase()] = Number(match[2]);
    }
  }
  for (const key of [
    "security",
    "reliability",
    "operational_excellence",
    "performance_efficiency",
    "cost_optimization",
  ]) {
    const value = numberValue(`${key}_score_min`);
    if (value !== undefined) {
      pillarScoreMins[key] = value;
    }
  }
  const enforcement = stringValue("enforcement")?.toLowerCase();
  return {
    enforcement: enforcement === "warn" ? "warn" : "required",
    overallScoreMin: numberValue("overall_score_min") ?? 80,
    pillarScoreMin: numberValue("pillar_score_min"),
    pillarScoreMins,
    failOnHighRisk: booleanValue("fail_on_high_risk") ?? true,
    failOnValidationErrors: booleanValue("fail_on_validation_errors") ?? true,
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

const normalizeKey = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .replace(/[\s-]+/g, "_")
    .toLowerCase();

const firstRecord = (...values: unknown[]): Record<string, any> | undefined => {
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, any>;
    }
  }
  return undefined;
};

const entriesAsNamedRecords = (
  value: unknown,
  amountKey = "amount",
): Array<Record<string, any>> => {
  const record = firstRecord(value);
  if (!record) {
    return [];
  }
  return Object.entries(record).map(([name, amount]) => ({
    name,
    [amountKey]: amount,
  }));
};

const publicFinding = (rule: Record<string, any>): Record<string, any> => ({
  id: rule.id ?? rule.rule_id ?? rule.ruleId,
  pillar: rule.pillar,
  title: rule.title ?? rule.name,
  status: rule.status ?? rule.outcome,
  severity: rule.severity,
});

const reviewReportStatus = (report: unknown): Record<string, any> => ({
  available: Boolean(report),
});

const reviewReportStatuses = ({
  cost,
  waf,
  preload,
}: {
  cost?: Record<string, any>;
  waf?: Record<string, any>;
  preload?: Record<string, any>;
}): Record<string, any> => ({
  cost: reviewReportStatus(cost),
  wellArchitected: reviewReportStatus(waf),
  preload: reviewReportStatus(preload),
});

const publicJobStatus = (value: unknown): Record<string, any> | undefined => {
  const record = firstRecord(value);
  if (!record) {
    return undefined;
  }
  return {
    jobId: record.job_id ?? record.jobId ?? record.id,
    status: record.status,
    operation: record.operation,
    progress: record.progress,
    submittedAt: record.submitted_at ?? record.submittedAt,
    startedAt: record.started_at ?? record.startedAt,
    completedAt: record.completed_at ?? record.completedAt,
  };
};

const reviewSyncStatus = (
  sync: unknown,
  finalStatus?: unknown,
): Record<string, any> => {
  const syncRecord = asRecord(sync);
  return {
    job: publicJobStatus(syncRecord.job ?? syncRecord),
    projectId: syncRecord.project_id ?? syncRecord.projectId,
    commitSha: syncRecord.commit_sha ?? syncRecord.commitSha,
    finalStatus: publicJobStatus(finalStatus),
  };
};

const displayNumber = (value: unknown, fallback = "not available"): string => {
  const number = numberFrom(value);
  return number === undefined ? fallback : String(number);
};

const formatMoney = (
  amount?: number,
  currency?: string,
  fallback = "not available",
): string => {
  const numericAmount = numberFrom(amount);
  if (numericAmount === undefined) {
    return fallback;
  }
  return currency ? `${numericAmount} ${currency}` : String(numericAmount);
};

const formatValidation = (validation?: Record<string, any>): string => {
  const policyFailed = displayNumber(validation?.policyChecks?.failed);
  const unitFailed = displayNumber(validation?.unitTests?.failed);
  return `Policy checks ${policyFailed} failed, unit tests ${unitFailed} failed`;
};

const compactValidation = (validation?: Record<string, any>): string => {
  const policyFailed = numberFrom(validation?.policyChecks?.failed);
  const unitFailed = numberFrom(validation?.unitTests?.failed);
  if (policyFailed === 0 && unitFailed === 0) {
    return "validation clean";
  }
  return formatValidation(validation);
};

const markdownLink = (label: string, url?: string): string =>
  url ? `[${label}](${url})` : label;

type ReviewPillar = {
  id: string;
  label: string;
  score: number;
  passed?: number;
  warned?: number;
  failed?: number;
};

const extractPillars = (waf?: Record<string, any>): ReviewPillar[] => {
  const fromArray = waf?.parsed?.score?.pillars;
  if (Array.isArray(fromArray)) {
    return fromArray
      .map((pillar): ReviewPillar | undefined => {
        const record = asRecord(pillar);
        const id = normalizeKey(record.id ?? record.name ?? record.label);
        const score = numberFrom(record.score, record.value);
        if (!id || score === undefined) return undefined;
        return {
          id,
          label: String(record.label ?? record.name ?? id),
          score,
          passed: numberFrom(record.passed, record.passed_rules),
          warned: numberFrom(record.warned, record.warning_rules),
          failed: numberFrom(record.failed, record.failed_rules),
        };
      })
      .filter((pillar): pillar is ReviewPillar => pillar !== undefined);
  }
  const scores = firstRecord(
    waf?.pillar_scores,
    waf?.parsed?.pillar_scores,
    waf?.parsed?.score?.pillar_scores,
    waf?.raw?.pillar_scores,
    waf?.report?.pillar_scores,
  );
  if (!scores) return [];
  return Object.entries(scores)
    .map(([id, score]) => ({
      id: normalizeKey(id),
      label: id,
      score: numberFrom(score),
    }))
    .filter((pillar): pillar is ReviewPillar => pillar.score !== undefined);
};

const extractValidation = ({
  waf,
  preload,
  project,
}: {
  waf?: Record<string, any>;
  preload?: Record<string, any>;
  project?: Record<string, any>;
}) => {
  const policySummary = firstRecord(
    waf?.parsed?.validation_summary,
    waf?.raw?.validation_summary,
    waf?.validation_summary,
  );
  const rules = Array.isArray(waf?.parsed?.rules) ? waf?.parsed?.rules : [];
  const failedRules = rules.filter((rule: any) =>
    ["fail", "failed", "error"].includes(String(rule?.status ?? rule?.outcome ?? "").toLowerCase()),
  );
  const unitSummary = firstRecord(
    preload?.latest_payloads?.unit_tests?.summary,
    preload?.reports?.unit_tests?.metrics,
    project?.status?.unit_tests,
  );
  return {
    policyChecks: {
      total: numberFrom(policySummary?.total_rules, policySummary?.totalRules, rules.length),
      passed: numberFrom(policySummary?.passed_rules, policySummary?.passedRules),
      failed: numberFrom(policySummary?.failed_rules, policySummary?.failedRules, failedRules.length),
      errors: numberFrom(policySummary?.error_rules, policySummary?.errorRules),
    },
    unitTests: {
      status: unitSummary?.status,
      total: numberFrom(unitSummary?.total_tests, unitSummary?.totalTests),
      passed: numberFrom(unitSummary?.passed_tests, unitSummary?.passedTests),
      failed: numberFrom(unitSummary?.failed_tests, unitSummary?.failedTests),
      skipped: numberFrom(unitSummary?.skipped_tests, unitSummary?.skippedTests),
    },
  };
};

const evaluateGate = ({
  configText,
  waf,
  cost,
  preload,
  project,
}: {
  configText?: string;
  waf?: Record<string, any>;
  cost?: Record<string, any>;
  preload?: Record<string, any>;
  project?: Record<string, any>;
}) => {
  const gateConfig = parseGateConfig(configText);
  const overallScore = numberFrom(
    waf?.overall_score,
    waf?.report?.overall_score,
    waf?.parsed?.score?.overall,
    waf?.parsed?.overall_score,
    waf?.raw?.score,
  );
  const highRisk = numberFrom(
    waf?.critical_issues_count !== undefined || waf?.high_issues_count !== undefined
      ? (numberFrom(waf?.critical_issues_count) ?? 0) + (numberFrom(waf?.high_issues_count) ?? 0)
      : undefined,
    waf?.report?.critical_issues_count !== undefined || waf?.report?.high_issues_count !== undefined
      ? (numberFrom(waf?.report?.critical_issues_count) ?? 0) + (numberFrom(waf?.report?.high_issues_count) ?? 0)
      : undefined,
    waf?.parsed?.counts?.highRisk,
    waf?.parsed?.counts?.high_count,
    waf?.parsed?.highRisk,
  );
  const monthlyCost = numberFrom(
    cost?.report?.processed?.total_monthly_cost,
    cost?.report?.processed?.totalMonthlyCost,
    cost?.parsed?.totalSpend?.amount,
    cost?.parsed?.total_spend?.amount,
    cost?.raw?.total,
    preload?.reports?.cost?.metrics?.monthly_cost,
    preload?.reports?.cost?.metrics?.monthlyCost,
    preload?.latest_payloads?.cost?.summary?.monthly_cost,
    preload?.latest_payloads?.cost?.summary?.monthlyCost,
    preload?.latest_payloads?.cost?.summary?.total_monthly_cost,
    preload?.latest_payloads?.cost?.summary?.totalMonthlyCost,
  );
  const currency = String(
    cost?.report?.metadata?.currency ??
      cost?.parsed?.totalSpend?.currency ??
      cost?.parsed?.total_spend?.currency ??
      cost?.raw?.currency ??
      preload?.reports?.cost?.metrics?.currency ??
      preload?.latest_payloads?.cost?.summary?.currency ??
      "",
  ) || undefined;
  const savings = numberFrom(
    cost?.report?.processed?.opportunity_summary?.total_monthly_savings,
    cost?.report?.processed?.opportunitySummary?.totalMonthlySavings,
    cost?.parsed?.estimatedSavings?.amount,
    cost?.parsed?.estimated_savings?.amount,
    preload?.reports?.cost?.metrics?.estimated_savings,
    preload?.reports?.cost?.metrics?.estimatedSavings,
    preload?.latest_payloads?.cost?.summary?.estimated_savings,
    preload?.latest_payloads?.cost?.summary?.estimatedSavings,
  );
  const pillars = extractPillars(waf).map((pillar) => {
    const threshold =
      gateConfig?.pillarScoreMins[pillar.id] ??
      gateConfig?.pillarScoreMin;
    return {
      ...pillar,
      threshold,
      status:
        threshold !== undefined && pillar.score < threshold ? "fail" : "pass",
    };
  });
  const validation = extractValidation({ waf, preload, project });
  const wellArchitected = {
    overall: {
      score: overallScore,
      threshold: gateConfig?.overallScoreMin,
      status:
        gateConfig && overallScore !== undefined && overallScore < gateConfig.overallScoreMin
          ? "fail"
          : "pass",
    },
    pillars,
    risks: {
      high: highRisk,
      medium: numberFrom(waf?.parsed?.counts?.mediumRisk, waf?.parsed?.counts?.medium_count),
      critical: numberFrom(waf?.parsed?.counts?.criticalRisk, waf?.parsed?.counts?.critical_count),
    },
    topFindings: Array.isArray(waf?.parsed?.rules)
      ? waf.parsed.rules.slice(0, 5).map((rule: any) => publicFinding(asRecord(rule)))
      : [],
  };
  const costSummary = {
    monthly: {
      amount: monthlyCost,
      currency,
      threshold: gateConfig?.maxMonthlyCost,
      status:
        gateConfig?.maxMonthlyCost !== undefined &&
        monthlyCost !== undefined &&
        monthlyCost > gateConfig.maxMonthlyCost
          ? "fail"
          : "pass",
    },
    estimatedSavings: {
      amount: savings,
      currency,
    },
    topServices: (
      Array.isArray(cost?.parsed?.serviceGroups)
        ? cost.parsed.serviceGroups
        : entriesAsNamedRecords(cost?.report?.processed?.cost_by_service_family)
    ).slice(0, 5),
    recommendations: (
      Array.isArray(cost?.parsed?.recommendations)
        ? cost.parsed.recommendations
        : Array.isArray(cost?.report?.processed?.optimization_recommendations)
          ? cost.report.processed.optimization_recommendations
          : []
    ).slice(0, 5),
  };
  if (!gateConfig) {
    return {
      status: "warn",
      reason: "ci.gates is not configured in .cloudeval/config.yaml.",
      enforcement: "warn",
      overallScore,
      highRisk,
      monthlyCost,
      wellArchitected,
      cost: costSummary,
      validation,
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
  for (const pillar of pillars) {
    if (pillar.status === "fail") {
      failures.push(`${pillar.label} score ${pillar.score} is below ${pillar.threshold}`);
    }
  }
  const failedPolicyChecks = validation.policyChecks.failed ?? 0;
  const failedUnitTests = validation.unitTests.failed ?? 0;
  if (gateConfig.failOnValidationErrors && (failedPolicyChecks > 0 || failedUnitTests > 0)) {
    failures.push(
      `validation has ${failedPolicyChecks} failed policy checks and ${failedUnitTests} failed unit tests`,
    );
  }
  if (
    gateConfig.maxMonthlyCost !== undefined &&
    monthlyCost !== undefined &&
    monthlyCost > gateConfig.maxMonthlyCost
  ) {
    failures.push(`monthly cost ${monthlyCost} exceeds ${gateConfig.maxMonthlyCost}`);
  }
  const wouldFail = failures.length > 0;
  return {
    status: wouldFail && gateConfig.enforcement === "required" ? "fail" : wouldFail ? "warn" : "pass",
    enforcement: gateConfig.enforcement,
    wouldFail,
    failures,
    thresholds: gateConfig,
    overallScore,
    highRisk,
    monthlyCost,
    wellArchitected,
    cost: costSummary,
    validation,
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
  projectId,
  jobId,
  pollIntervalMs,
  waitTimeoutMs,
}: {
  baseUrl: string;
  token?: string;
  userId?: string;
  projectId: string;
  jobId: string;
  pollIntervalMs: number;
  waitTimeoutMs: number;
}): Promise<Record<string, any>> => {
  const startedAt = Date.now();
  let lastStatus: Record<string, any> | undefined;
  for (;;) {
    const query = new URLSearchParams({ project_id: projectId });
    if (userId) {
      query.set("user_id", userId);
    }
    lastStatus = await fetchCloudEvalJson<Record<string, any>>({
      baseUrl,
      authToken: token,
      path: `/jobs/${encodeURIComponent(jobId)}?${query.toString()}`,
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

const userScopedPath = (pathValue: string, userId?: string): string => {
  if (!userId) {
    return pathValue;
  }
  const [pathPart, queryPart = ""] = pathValue.split("?");
  const query = new URLSearchParams(queryPart);
  query.set("user_id", userId);
  const suffix = query.toString();
  return suffix ? `${pathPart}?${suffix}` : pathPart;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const fetchReviewReports = async ({
  baseUrl,
  token,
  projectId,
  userId,
}: {
  baseUrl: string;
  token?: string;
  projectId: string;
  userId?: string;
}): Promise<{
  cost?: Record<string, any>;
  waf?: Record<string, any>;
  preload?: Record<string, any>;
}> => {
  const [cost, waf, preload] = await Promise.all([
    safeFetch<Record<string, any>>({
      baseUrl,
      authToken: token,
      path: userScopedPath(`/cost-reports/${projectId}/full`, userId),
    }),
    safeFetch<Record<string, any>>({
      baseUrl,
      authToken: token,
      path: userScopedPath(`/well-architected-reports/${projectId}/full`, userId),
    }),
    userId
      ? safeFetch<Record<string, any>>({
          baseUrl,
          authToken: token,
          path: `/reports/preload/${encodeURIComponent(projectId)}?user_id=${encodeURIComponent(userId)}&include_payload=true`,
        })
      : Promise.resolve(undefined),
  ]);
  return { cost, waf, preload };
};

const waitForReviewReports = async ({
  baseUrl,
  token,
  projectId,
  userId,
  wait,
  pollIntervalMs,
  waitTimeoutMs,
}: {
  baseUrl: string;
  token?: string;
  projectId: string;
  userId?: string;
  wait: boolean;
  pollIntervalMs: number;
  waitTimeoutMs: number;
}): Promise<{
  cost?: Record<string, any>;
  waf?: Record<string, any>;
  preload?: Record<string, any>;
}> => {
  const startedAt = Date.now();
  let latest = await fetchReviewReports({ baseUrl, token, projectId, userId });
  while (wait && (!latest.cost || !latest.waf)) {
    if (Date.now() - startedAt > waitTimeoutMs) {
      return latest;
    }
    await sleep(pollIntervalMs);
    latest = await fetchReviewReports({ baseUrl, token, projectId, userId });
  }
  return latest;
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
  `Well-Architected score: ${data.gate?.wellArchitected?.overall?.score ?? data.gate?.overallScore ?? "unknown"}`,
  `High-risk findings: ${data.gate?.wellArchitected?.risks?.high ?? data.gate?.highRisk ?? "unknown"}`,
  `Monthly cost: ${formatMoney(data.gate?.cost?.monthly?.amount ?? data.gate?.monthlyCost, data.gate?.cost?.monthly?.currency)}`,
  `Validation: ${formatValidation(data.gate?.validation)}`,
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
  mode,
  agentProfileId,
  data,
}: {
  baseUrl: string;
  token?: string;
  user?: { id?: string; email?: string; full_name?: string; name?: string };
  project?: Record<string, any>;
  model?: string;
  mode: "ask" | "agent";
  agentProfileId?: string;
  data: Record<string, any>;
}): Promise<Record<string, any>> => {
  const core = await import("@cloudeval/core");
  const threadId = `review-${data.projectId}-${Date.now()}`;
  let markdown = "";
  let chatState: any = { ...core.initialChatState, threadId };
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
      mode,
      ...(model ? { model } : {}),
    },
    ...(mode === "agent" ? { agentProfileId: agentProfileId ?? "architecture" } : {}),
    completeAfterResponse: true,
    responseCompletionGraceMs: 250,
    streamIdleTimeoutMs: 120000,
  })) {
    chatState = core.reduceChunk(chatState, chunk as any);
    const latestMessage = [...(chatState.messages ?? [])]
      .reverse()
      .find((message: any) => message.role === "assistant");
    const chunkAssistantMessage = Array.isArray((chunk as any)?.messages)
      ? [...((chunk as any).messages as any[])]
          .reverse()
          .find((message: any) => message?.role === "assistant" && typeof message?.content === "string")
          ?.content
      : undefined;
    const content = (chunk as any)?.content;
    if (typeof chunkAssistantMessage === "string" && chunkAssistantMessage.trim()) {
      markdown = chunkAssistantMessage;
    }
    if (chunk.type === "responding" && typeof content === "string") {
      markdown = latestMessage?.content || `${markdown}${content}`;
    }
  }
  const finalMessage = [...(chatState.messages ?? [])]
    .reverse()
    .find((message: any) => message.role === "assistant");
  return {
    enabled: true,
    mode,
    ...(mode === "agent" ? { agentProfileId: agentProfileId ?? "architecture" } : {}),
    ...(model ? { model } : {}),
    markdown: String(finalMessage?.content || markdown).trim(),
    threadId,
  };
};

const buildMarkdownSummary = (data: Record<string, any>): string => {
  const gateStatus = String(data.gate?.status ?? "unknown").toUpperCase();
  const score = data.gate?.overallScore ?? "unknown";
  const cost = data.gate?.cost?.monthly;
  const validation = data.gate?.validation;
  const projectLabel = String(data.project?.name ?? data.projectName ?? data.projectId);
  const projectDisplay = markdownLink(projectLabel, data.project?.url ?? data.projectUrl);
  const source = data.repo
    ? `${data.repo}${data.ref ? ` @ ${data.ref}` : ""}`
    : data.ref ?? "unknown source";
  const commit = String(data.commitSha ?? "unknown").slice(0, 12);
  const pillarLines = Array.isArray(data.gate?.wellArchitected?.pillars)
    ? data.gate.wellArchitected.pillars.map(
        (pillar: Record<string, any>) =>
          `- ${pillar.label}: ${pillar.score} - ${String(pillar.status ?? "unknown").toUpperCase()}`,
      )
    : [];
  const lines = [
    `**${gateStatus}** for ${projectDisplay}: Well-Architected ${score}, cost ${formatMoney(cost?.amount, cost?.currency)}, ${compactValidation(validation)}.`,
    "",
    `Source: \`${source}\` · commit \`${commit}\``,
  ];
  if (data.aiSummary?.markdown) {
    lines.push("", "#### AI summary", "", data.aiSummary.markdown);
  }
  if (Array.isArray(data.gate?.failures) && data.gate.failures.length) {
    lines.push("", "#### Gate failures", "", ...data.gate.failures.map((failure: string) => `- ${failure}`));
  }
  if (pillarLines.length) {
    lines.push(
      "",
      "<details>",
      "<summary>Well-Architected details</summary>",
      "",
      `- Overall score: ${score}`,
      ...pillarLines,
      "",
      "</details>",
    );
  }
  if (cost?.amount !== undefined || cost?.threshold !== undefined) {
    const costLines = [`- Monthly estimate: ${formatMoney(cost?.amount, cost?.currency)}`];
    if (data.gate?.cost?.estimatedSavings?.amount !== undefined) {
      costLines.push(
        `- Estimated savings: ${formatMoney(data.gate.cost.estimatedSavings.amount, data.gate.cost.estimatedSavings.currency)}`,
      );
    }
    lines.push(
      "",
      "<details>",
      "<summary>Cost details</summary>",
      "",
      ...costLines,
      "",
      "</details>",
    );
  }
  if (validation) {
    lines.push(
      "",
      "<details>",
      "<summary>Validation details</summary>",
      "",
      `- ${formatValidation(validation)}`,
      "",
      "</details>",
    );
  }
  return lines.filter((line) => line !== undefined).join("\n");
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
    .option("--ai-summary-mode <mode>", "AI summary mode: ask or agent.", "ask")
    .option("--ai-summary-profile <profile-id>", "Agent Profile id when --ai-summary-mode agent is used.", "architecture")
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
      const project = await fetchProjectById({
        baseUrl: context.baseUrl,
        token: context.token,
        projectId,
      });
      const projectUserId =
        typeof project?.user_id === "string" && project.user_id.trim()
          ? project.user_id
          : undefined;
      const scopedUserId = context.user?.id ?? projectUserId;
      const finalStatus = options.wait === false
        ? undefined
        : extractJobId(sync)
          ? await waitForJob({
              baseUrl: context.baseUrl,
              token: context.token,
              userId: scopedUserId,
              projectId,
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
      const [{ cost, waf, preload }, configText] = await Promise.all([
        waitForReviewReports({
          baseUrl: context.baseUrl,
          token: context.token,
          projectId,
          userId: scopedUserId,
          wait: options.wait !== false,
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
        }),
        readConfigText(cwd, options),
      ]);
      const data: Record<string, any> = {
        projectId,
        project: {
          id: projectId,
          name: String(project?.name ?? projectId),
          url: buildFrontendUrl({
            baseUrl: resolveFrontendBaseUrl({ apiBaseUrl: context.baseUrl }),
            target: "project",
            projectId,
            view: "preview",
            layout: "architecture",
          }),
        },
        repo,
        ref,
        commitSha,
        sourceRoot,
        sync: reviewSyncStatus(sync, finalStatus),
        reports: reviewReportStatuses({ cost, waf, preload }),
        gate: evaluateGate({ configText, waf, cost, preload, project }),
      };
      if (options.aiSummary !== false) {
        try {
          const aiSummaryMode = String(options.aiSummaryMode ?? "ask").toLowerCase();
          if (!["ask", "agent"].includes(aiSummaryMode)) {
            throw new Error("--ai-summary-mode must be ask or agent.");
          }
          data.aiSummary = await generateAiSummary({
            baseUrl: context.baseUrl,
            token: context.token,
            user: context.user,
            project,
            model: options.model,
            mode: aiSummaryMode as "ask" | "agent",
            agentProfileId: options.aiSummaryProfile,
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

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
  const firstStringValue = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = stringValue(key);
      if (value !== undefined) {
        return value;
      }
    }
    return undefined;
  };
  const numberValue = (key: string): number | undefined => {
    const match = configText.match(new RegExp(`^\\s*${key}\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)`, "m"));
    return match ? Number(match[1]) : undefined;
  };
  const firstNumberValue = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = numberValue(key);
      if (value !== undefined) {
        return value;
      }
    }
    return undefined;
  };
  const booleanValue = (key: string): boolean | undefined => {
    const match = configText.match(new RegExp(`^\\s*${key}\\s*:\\s*(true|false)`, "im"));
    return match ? match[1].toLowerCase() === "true" : undefined;
  };
  const firstBooleanValue = (...keys: string[]): boolean | undefined => {
    for (const key of keys) {
      const value = booleanValue(key);
      if (value !== undefined) {
        return value;
      }
    }
    return undefined;
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
  const enforcement = firstStringValue("enforcement", "mode")?.toLowerCase();
  return {
    enforcement: enforcement === "warn" || enforcement === "comment_only" ? "warn" : "required",
    overallScoreMin: firstNumberValue("overall_score_min", "minimum_well_architected_score") ?? 80,
    pillarScoreMin: firstNumberValue("pillar_score_min", "minimum_pillar_score"),
    pillarScoreMins,
    failOnHighRisk: firstBooleanValue(
      "fail_on_high_risk",
      "fail_when_high_risk_findings_exist",
    ) ?? true,
    failOnValidationErrors: firstBooleanValue(
      "fail_on_validation_errors",
      "fail_when_validation_fails",
    ) ?? true,
    maxMonthlyCost: firstNumberValue("max_monthly_cost", "max_monthly_cost_usd"),
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
  graph,
}: {
  cost?: Record<string, any>;
  waf?: Record<string, any>;
  preload?: Record<string, any>;
  graph?: Record<string, any>;
}): Record<string, any> => ({
  cost: reviewReportStatus(cost),
  wellArchitected: reviewReportStatus(waf),
  preload: reviewReportStatus(preload),
  graph: reviewReportStatus(graph),
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

const trimNumber = (value: number, fractionDigits = 2): string =>
  Number.isInteger(value) ? String(value) : String(Number(value.toFixed(fractionDigits)));

const formatScore = (value: unknown, fallback = "unknown"): string => {
  const numericValue = numberFrom(value);
  return numericValue === undefined ? fallback : `${trimNumber(numericValue)}/100`;
};

type ScoreRating = "EXCELLENT" | "GOOD" | "FAIR" | "POOR" | "CRITICAL";

const scoreRating = (value: unknown): ScoreRating | undefined => {
  const numericValue = numberFrom(value);
  if (numericValue === undefined) {
    return undefined;
  }
  if (numericValue >= 90) {
    return "EXCELLENT";
  }
  if (numericValue >= 75) {
    return "GOOD";
  }
  if (numericValue >= 50) {
    return "FAIR";
  }
  if (numericValue >= 30) {
    return "POOR";
  }
  return "CRITICAL";
};

const scoreRatingIcon = (rating?: ScoreRating): string => {
  switch (rating) {
    case "EXCELLENT":
      return "🟢";
    case "GOOD":
      return "🔵";
    case "FAIR":
      return "🟡";
    case "POOR":
      return "🟠";
    case "CRITICAL":
      return "🔴";
    default:
      return "⚪";
  }
};

const formatMonthlyMoney = (
  amount?: number,
  currency?: string,
  fallback = "not available",
): string => {
  const value = formatMoney(amount, currency, fallback);
  return value === fallback ? value : `${value}/mo`;
};

const compactBudgetLabel = (amount?: number, currency?: string): string | undefined => {
  if (amount === undefined || !Number.isFinite(amount)) {
    return undefined;
  }
  if (Math.abs(amount) >= 1_000_000) {
    return `${trimNumber(amount / 1_000_000, 1)}M`;
  }
  if (Math.abs(amount) >= 1_000) {
    return `${trimNumber(amount / 1_000, 1)}K`;
  }
  return formatMonthlyMoney(amount, currency);
};

const costSummaryLine = (cost?: Record<string, any>): string => {
  const amount = numberFrom(cost?.amount);
  if (amount === undefined) {
    return "⚪ Cost: not available";
  }
  const formattedCost = formatMonthlyMoney(amount, cost?.currency);
  const threshold = numberFrom(cost?.threshold);
  if (threshold === undefined) {
    return `⚪ Cost: ${formattedCost} (not gated)`;
  }
  const budget = compactBudgetLabel(threshold, cost?.currency) ?? "configured";
  return String(cost?.status ?? "").toLowerCase() === "fail"
    ? `🔴 Cost: ${formattedCost} (over ${budget} budget)`
    : `🟢 Cost: ${formattedCost} (under ${budget} budget)`;
};

const statusIcon = (status: unknown): string => {
  switch (String(status ?? "").toLowerCase()) {
    case "pass":
    case "passed":
    case "success":
    case "succeeded":
      return "🟢";
    case "warn":
    case "warning":
      return "🟡";
    case "fail":
    case "failed":
    case "error":
      return "🔴";
    default:
      return "⚪";
  }
};

const formatValidation = (validation?: Record<string, any>): string => {
  const policyFailed = numberFrom(validation?.policyChecks?.failed);
  const unitFailed = numberFrom(validation?.unitTests?.failed);
  if (policyFailed === 0 && unitFailed === 0) {
    return "Validation clean";
  }
  const parts: string[] = [];
  if (unitFailed !== undefined) {
    parts.push(unitFailed === 0 ? "unit tests clean" : `${unitFailed} unit tests failed`);
  }
  if (policyFailed !== undefined) {
    parts.push(policyFailed === 0 ? "policy checks clean" : `${policyFailed} policy checks failed`);
  }
  return parts.length ? parts.join(", ") : "Validation not available";
};

const validationSummaryLine = (validation?: Record<string, any>): string => {
  const unitFailed = numberFrom(validation?.unitTests?.failed);
  if (unitFailed === undefined) {
    return "⚪ Validation: not available";
  }
  return unitFailed > 0
    ? `🔴 Validation: ${unitFailed} unit tests failed`
    : "🟢 Validation: GOOD";
};

const policySummaryLine = (validation?: Record<string, any>): string => {
  const policyFailed = numberFrom(validation?.policyChecks?.failed);
  if (policyFailed === undefined) {
    return "⚪ Policy checks: not available";
  }
  return policyFailed > 0
    ? `🔴 Policy checks: ${policyFailed} failed`
    : "🟢 Policy checks: GOOD";
};

const validationDetailLines = (validation?: Record<string, any>): string[] => {
  if (!validation) {
    return ["- Validation data was not available."];
  }
  const lines: string[] = [];
  const unitTotal = numberFrom(validation.unitTests?.total);
  const unitPassed = numberFrom(validation.unitTests?.passed);
  const unitFailed = numberFrom(validation.unitTests?.failed);
  if (
    unitTotal !== undefined ||
    unitPassed !== undefined ||
    unitFailed !== undefined
  ) {
    const parts: string[] = [];
    if (unitPassed !== undefined) parts.push(`**${unitPassed} passed**`);
    if (unitFailed !== undefined) parts.push(`**${unitFailed} failed**`);
    if (unitTotal !== undefined) parts.push(`${unitTotal} total`);
    lines.push(`- Unit tests: ${parts.join(", ")}`);
  }
  const policyTotal = numberFrom(validation.policyChecks?.total);
  const policyPassed = numberFrom(validation.policyChecks?.passed);
  const policyFailed = numberFrom(validation.policyChecks?.failed);
  if (
    policyTotal !== undefined ||
    policyPassed !== undefined ||
    policyFailed !== undefined
  ) {
    const parts: string[] = [];
    if (policyPassed !== undefined) parts.push(`**${policyPassed} passed**`);
    if (policyFailed !== undefined) parts.push(`**${policyFailed} failed**`);
    if (policyTotal !== undefined) parts.push(`${policyTotal} total`);
    lines.push(`- Policy checks: ${parts.join(", ")}`);
  }
  return lines.length ? lines : ["- Validation data was not available."];
};

const namedAmount = (record: Record<string, any>): number | undefined =>
  numberFrom(
    record.amount,
    record.monthly_cost,
    record.monthlyCost,
    record.cost,
    record.value,
  );

const namedLabel = (record: Record<string, any>, fallback: string): string =>
  String(record.name ?? record.service ?? record.label ?? record.category ?? fallback);

const mermaidLabel = (value: string): string => value.replace(/"/g, "'");

const costServiceRows = (
  services: unknown,
  currency?: string,
): Array<{ name: string; amount: number; currency?: string }> =>
  (Array.isArray(services) ? services : [])
    .map((service, index) => {
      const record = asRecord(service);
      const amount = namedAmount(record);
      if (amount === undefined) {
        return undefined;
      }
      const rowCurrency = String(record.currency ?? currency ?? "") || undefined;
      return {
        name: namedLabel(record, `Service ${index + 1}`),
        amount,
        ...(rowCurrency ? { currency: rowCurrency } : {}),
      };
    })
    .filter((service): service is { name: string; amount: number; currency?: string } => service !== undefined);

const reconcileCostServiceRows = (
  services: Array<{ name: string; amount: number; currency?: string }>,
  totalAmount?: number,
  currency?: string,
): Array<{ name: string; amount: number; currency?: string }> => {
  const total = numberFrom(totalAmount);
  if (total === undefined || services.length === 0) {
    return services;
  }
  const serviceSum = services.reduce((sum, service) => sum + service.amount, 0);
  if (serviceSum > total + 0.001) {
    return [
      {
        name: "Reported total",
        amount: total,
        ...(currency ? { currency } : {}),
      },
    ];
  }
  const delta = Number((total - serviceSum).toFixed(3));
  if (delta > 0.001) {
    return [
      ...services,
      {
        name: "Other",
        amount: delta,
        ...(currency ? { currency } : {}),
      },
    ];
  }
  return services;
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

const extractArchitectureInsights = ({
  waf,
  preload,
  graph,
  project,
}: {
  waf?: Record<string, any>;
  preload?: Record<string, any>;
  graph?: Record<string, any>;
  project?: Record<string, any>;
}) => {
  const graphNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const graphEdges = Array.isArray(graph?.edges) ? graph.edges : [];
  const graphResourceTypes = new Set(
    graphNodes
      .map((node) => asRecord(node).type)
      .filter((type): type is string => typeof type === "string" && type.trim().length > 0),
  );
  const metrics = firstRecord(
    preload?.reports?.architecture?.metrics,
    preload?.latest_payloads?.architecture?.summary,
    waf?.architecture,
    waf?.parsed?.architecture,
    project?.architecture,
    project?.graph,
  );
  const resources = numberFrom(
    metrics?.resource_count,
    metrics?.resourceCount,
    metrics?.resources,
    metrics?.node_count,
    metrics?.nodeCount,
    graphNodes.length || undefined,
  );
  const relationships = numberFrom(
    metrics?.relationship_count,
    metrics?.relationshipCount,
    metrics?.relationships,
    metrics?.edge_count,
    metrics?.edgeCount,
    graphEdges.length || undefined,
  );
  const resourceTypes = numberFrom(
    metrics?.resource_type_count,
    metrics?.resourceTypeCount,
    metrics?.types,
    metrics?.resource_types,
    metrics?.resourceTypes,
    graphResourceTypes.size || undefined,
  );
  if (
    resources === undefined &&
    relationships === undefined &&
    resourceTypes === undefined
  ) {
    return undefined;
  }
  return {
    resources,
    relationships,
    resourceTypes,
    relationshipDensity:
      resources !== undefined && resources > 0 && relationships !== undefined
        ? relationships / resources
        : undefined,
  };
};

const evaluateGate = ({
  configText,
  waf,
  cost,
  preload,
  graph,
  project,
}: {
  configText?: string;
  waf?: Record<string, any>;
  cost?: Record<string, any>;
  preload?: Record<string, any>;
  graph?: Record<string, any>;
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
  const architecture = extractArchitectureInsights({ waf, preload, graph, project });
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
      architecture,
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
    architecture,
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
  graph?: Record<string, any>;
}> => {
  const [cost, waf, preload, graph] = await Promise.all([
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
    userId
      ? safeFetch<Record<string, any>>({
          baseUrl,
          authToken: token,
          path: `/projects/${encodeURIComponent(projectId)}/graph?user_id=${encodeURIComponent(userId)}`,
        })
      : Promise.resolve(undefined),
  ]);
  return { cost, waf, preload, graph };
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
  graph?: Record<string, any>;
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
  "Return exactly two sections: Short Summary and Details.",
  "Short Summary: one dense paragraph under 45 words with gate status, Well-Architected posture, validation, and cost.",
  "Details: short bullets with bold labels only when useful, such as **Key risks:**, **Cost posture:**, and **Recommended next step:**.",
  "Keep the full response under 180 words. Do not invent facts not present below.",
  "Do not include citations, source markers, hidden tool ids, or HTML comments.",
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

const isTransientAiSummaryText = (text?: string): boolean => {
  if (!text?.trim()) {
    return false;
  }
  return /too many requests|rate[- ]?limit|try again in a moment|temporarily unavailable|something went wrong while processing|please try again or ask a different question|did not complete within/i.test(
    text,
  );
};

const normalizeAiSummaryMarkdown = (text?: string): string => {
  return normalizeAiSummarySections(text).markdown;
};

const normalizeAiSummarySections = (text?: string): {
  shortSummary: string;
  detailsMarkdown: string;
  markdown: string;
} => {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return { shortSummary: "", detailsMarkdown: "", markdown: "" };
  }
  const withNewlines = sanitizeAiSummaryMarkdown(trimmed.replace(/\\n/g, "\n"));
  const requestMatch = /\bRequest:\s*/i.exec(withNewlines);
  const sourceText = requestMatch
    ? withNewlines
        .slice(requestMatch.index + requestMatch[0].length)
        .split(/\n\s*\nThe request reached\b/i)[0]
        .trim() || withNewlines
    : withNewlines;
  const sections = splitAiSummarySections(sourceText);
  return {
    ...sections,
    markdown: renderAiSummarySections(sections.shortSummary, sections.detailsMarkdown),
  };
};

const sanitizeAiSummaryMarkdown = (text: string): string =>
  text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s*\[S_[A-Za-z0-9_:-]+\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const stripAiSectionLabel = (text: string, label: string): string =>
  text
    .replace(new RegExp(`^\\s*#{0,6}\\s*\\*\\*?${label}\\*\\*?\\s*:?\\s*`, "i"), "")
    .replace(new RegExp(`^\\s*${label}\\s*:?\\s*`, "i"), "")
    .trim();

const normalizeAiDetailHeadings = (text: string): string =>
  text
    .split("\n")
    .map((line) => {
      const cleaned = line
        .replace(/^\s*#{1,6}\s*/, "")
        .replace(/^\s*[-*]\s+/, "")
        .trimEnd();
      const labelMatch =
        cleaned.match(/^\*\*(Key risks|Cost posture|Recommended next step|Recommendation|Validation|Impact):\*\*\s*(.*)$/i) ??
        cleaned.match(/^\*\*(Key risks|Cost posture|Recommended next step|Recommendation|Validation|Impact)\*\*\s*:\s*(.*)$/i) ??
        cleaned.match(/^(Key risks|Cost posture|Recommended next step|Recommendation|Validation|Impact)\s*:\s*(.*)$/i);
      if (!labelMatch) {
        return cleaned;
      }
      return `- **${labelMatch[1]}:** ${labelMatch[2]}`.trimEnd();
    })
    .join("\n")
    .trim();

const splitAiSummarySections = (text: string): { shortSummary: string; detailsMarkdown: string } => {
  const cleaned = sanitizeAiSummaryMarkdown(text)
    .replace(/^\s*#{1,6}\s*AI summary\s*$/gim, "")
    .trim();
  const shortMatch = /\bShort Summary\s*:\s*/i.exec(cleaned);
  const detailsMatch = /\bDetails\s*:\s*/i.exec(cleaned);
  if (shortMatch && detailsMatch && shortMatch.index < detailsMatch.index) {
    const shortSummary = stripAiSectionLabel(
      cleaned.slice(shortMatch.index, detailsMatch.index).trim(),
      "Short Summary",
    );
    const detailsMarkdown = normalizeAiDetailHeadings(
      stripAiSectionLabel(cleaned.slice(detailsMatch.index).trim(), "Details"),
    );
    return { shortSummary, detailsMarkdown };
  }
  const paragraphs = cleaned.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const shortSummary = stripAiSectionLabel(paragraphs[0] ?? cleaned, "Short Summary");
  const detailsMarkdown = normalizeAiDetailHeadings(paragraphs.slice(1).join("\n\n"));
  return { shortSummary, detailsMarkdown };
};

const renderAiSummarySections = (shortSummary: string, detailsMarkdown: string): string => {
  const lines = [`**Short summary:** ${shortSummary.trim()}`];
  if (detailsMarkdown.trim()) {
    lines.push(
      "",
      "<details>",
      "<summary>AI details</summary>",
      "",
      detailsMarkdown.trim(),
      "",
      "</details>",
    );
  }
  return lines.join("\n");
};

const aiSummaryAttemptTimeoutMs = (): number => {
  const raw = process.env.CLOUDEVAL_REVIEW_AI_ATTEMPT_TIMEOUT_MS;
  if (raw?.trim()) {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 180000;
};

const aiSummaryRetryDelaysMs = (): number[] => {
  const raw = process.env.CLOUDEVAL_REVIEW_AI_RETRY_DELAYS_MS;
  if (raw?.trim()) {
    return raw
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isFinite(value) && value >= 0);
  }
  return [5000, 15000];
};

type GenerateAiSummaryInput = {
  baseUrl: string;
  token?: string;
  user?: { id?: string; email?: string; full_name?: string; name?: string };
  project?: Record<string, any>;
  model?: string;
  mode: "ask" | "agent";
  agentProfileId?: string;
  data: Record<string, any>;
};

const generateAiSummaryAttempt = async ({
  baseUrl,
  token,
  user,
  project,
  model,
  mode,
  agentProfileId,
  data,
}: GenerateAiSummaryInput): Promise<Record<string, any>> => {
  const core = await import("@cloudeval/core");
  const threadId = `review-${data.projectId}-${Date.now()}`;
  let markdown = "";
  let chatState: any = { ...core.initialChatState, threadId };
  const attemptTimeoutMs = aiSummaryAttemptTimeoutMs();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(
        new Error(`AI summary did not complete within ${attemptTimeoutMs}ms.`),
      );
    }, attemptTimeoutMs);
    timeoutId.unref?.();
  });
  const iterator = core.streamChat({
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
  });
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), timeoutPromise]);
      if (next.done) {
        break;
      }
      const chunk = next.value;
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
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (timedOut) {
      await iterator.return?.(undefined).catch(() => undefined);
    }
  }
  const finalMessage = [...(chatState.messages ?? [])]
    .reverse()
    .find((message: any) => message.role === "assistant");
  const rawMarkdown = String(finalMessage?.content || markdown).trim();
  const normalized = normalizeAiSummarySections(rawMarkdown);
  return {
    enabled: true,
    status: "ok",
    mode,
    ...(mode === "agent" ? { agentProfileId: agentProfileId ?? "architecture" } : {}),
    ...(model ? { model } : {}),
    ...normalized,
    threadId,
  };
};

const generateAiSummary = async (
  input: GenerateAiSummaryInput,
): Promise<Record<string, any>> => {
  const retryDelays = aiSummaryRetryDelaysMs();
  let lastResult: Record<string, any> | undefined;
  let activeInput = input;
  let fallbackFromMode: "agent" | undefined;

  for (let attemptIndex = 0; attemptIndex <= retryDelays.length; attemptIndex += 1) {
    let result: Record<string, any>;
    try {
      result = await generateAiSummaryAttempt(activeInput);
    } catch (error: any) {
      const message = error?.message ?? "AI summary failed";
      if (!isTransientAiSummaryText(message)) {
        throw error;
      }
      result = {
        enabled: true,
        status: "transient_error",
        mode: activeInput.mode,
        ...(activeInput.mode === "agent"
          ? { agentProfileId: activeInput.agentProfileId ?? "architecture" }
          : {}),
        ...(activeInput.model ? { model: activeInput.model } : {}),
        markdown: message,
        error: message,
      };
    }
    result.attempts = attemptIndex + 1;
    if (fallbackFromMode) {
      result.fallbackFromMode = fallbackFromMode;
    }
    const normalizedSummary =
      typeof result.shortSummary === "string" || typeof result.detailsMarkdown === "string"
        ? {
            shortSummary: String(result.shortSummary ?? "").trim(),
            detailsMarkdown: String(result.detailsMarkdown ?? "").trim(),
            markdown: renderAiSummarySections(
              String(result.shortSummary ?? "").trim(),
              String(result.detailsMarkdown ?? "").trim(),
            ),
          }
        : normalizeAiSummarySections(result.markdown);
    result = { ...result, ...normalizedSummary };
    if (isTransientAiSummaryText(result.markdown)) {
      const normalizedError = normalizeAiSummaryMarkdown(result.error);
      if (normalizedError && !isTransientAiSummaryText(normalizedError)) {
        result = {
          ...result,
          ...normalizeAiSummarySections(normalizedError),
        };
        result.status = "ok";
        delete result.error;
      }
    }
    lastResult = result;

    if (!isTransientAiSummaryText(result.markdown)) {
      return result;
    }

    const retryDelay = retryDelays[attemptIndex];
    if (retryDelay === undefined) {
      break;
    }
    await sleep(retryDelay);
    if (activeInput.mode === "agent") {
      fallbackFromMode = "agent";
      activeInput = {
        ...input,
        mode: "ask",
        agentProfileId: undefined,
      };
    }
  }

  return {
    ...(lastResult ?? {}),
    enabled: true,
    status: "unavailable",
    mode: activeInput.mode,
    ...(activeInput.mode === "agent"
      ? { agentProfileId: activeInput.agentProfileId ?? "architecture" }
      : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(fallbackFromMode ? { fallbackFromMode } : {}),
    attempts: lastResult?.attempts ?? retryDelays.length + 1,
    error: lastResult?.markdown || "AI summary unavailable",
    markdown:
      "AI summary unavailable: CloudEval AI was rate-limited. Retry the workflow or rerun `cloudeval review`.",
  };
};

const buildMarkdownSummary = (data: Record<string, any>): string => {
  const gateStatus = String(data.gate?.status ?? "unknown").toUpperCase();
  const score = data.gate?.overallScore ?? data.gate?.wellArchitected?.overall?.score;
  const cost = data.gate?.cost?.monthly;
  const validation = data.gate?.validation;
  const architecture = data.gate?.architecture;
  const projectLabel = String(data.project?.name ?? data.projectName ?? data.projectId);
  const projectDisplay = markdownLink(projectLabel, data.project?.url ?? data.projectUrl);
  const source = data.repo
    ? `${data.repo}${data.ref ? ` @ ${data.ref}` : ""}`
    : data.ref ?? "unknown source";
  const commit = String(data.commitSha ?? "unknown").slice(0, 12);
  const pillarLines = Array.isArray(data.gate?.wellArchitected?.pillars)
    ? data.gate.wellArchitected.pillars.map((pillar: Record<string, any>) => {
        const rating = scoreRating(pillar.score);
        return `| ${pillar.label} | **${formatScore(pillar.score)}** | ${scoreRatingIcon(rating)} ${rating ?? "UNKNOWN"} |`;
      })
    : [];
  const riskLines = [
    ["High-risk findings", data.gate?.wellArchitected?.risks?.high],
    ["Medium-risk findings", data.gate?.wellArchitected?.risks?.medium],
    ["Critical findings", data.gate?.wellArchitected?.risks?.critical],
  ]
    .filter(([, value]) => numberFrom(value) !== undefined)
    .map(([label, value]) => `- ${label}: **${displayNumber(value)}**`);
  const costServices = reconcileCostServiceRows(
    costServiceRows(data.gate?.cost?.topServices, cost?.currency),
    cost?.amount,
    cost?.currency,
  );
  const positiveCostServices = costServices.filter((service) => service.amount > 0);
  const architectureLines = [
    ["Resources", architecture?.resources],
    ["Relationships", architecture?.relationships],
    ["Resource types", architecture?.resourceTypes],
  ]
    .filter(([, value]) => numberFrom(value) !== undefined)
    .map(([label, value]) => `- ${label}: **${displayNumber(value)}**`);
  const density = numberFrom(architecture?.relationshipDensity);
  if (density !== undefined) {
    architectureLines.push(
      `- Graph connectivity: **${trimNumber(density, 2)} relationships per resource**`,
    );
  }
  const resourceCount = numberFrom(architecture?.resources);
  const resourceTypeCount = numberFrom(architecture?.resourceTypes);
  if (resourceCount !== undefined && resourceTypeCount !== undefined) {
    architectureLines.push(
      `- Resource diversity: **${displayNumber(resourceTypeCount)} types across ${displayNumber(resourceCount)} resources**`,
    );
  }
  const overallRating = scoreRating(score);
  const lines = [
    `${statusIcon(data.gate?.status)} **Overall** : ${gateStatus}`,
    `${scoreRatingIcon(overallRating)} Well-Architected Posture: ${formatScore(score)} (${overallRating ?? "UNKNOWN"})`,
    validationSummaryLine(validation),
    policySummaryLine(validation),
    costSummaryLine(cost),
    `**Cloudeval Project**: ${projectDisplay}`,
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
      "<summary>Well-Architected drilldown</summary>",
      "",
      ...riskLines,
      "",
      "| Pillar | Score | Rating |",
      "| --- | ---: | --- |",
      ...pillarLines,
      "",
      "</details>",
    );
  }
  if (cost?.amount !== undefined || cost?.threshold !== undefined) {
    const costLines: string[] = [];
    if (data.gate?.cost?.estimatedSavings?.amount !== undefined) {
      costLines.push(
        `- Estimated savings: **${formatMonthlyMoney(data.gate.cost.estimatedSavings.amount, data.gate.cost.estimatedSavings.currency)}**`,
      );
    }
    if (costServices.length) {
      costLines.push(
        "",
        "| Service | Monthly cost |",
        "| --- | ---: |",
        ...costServices.map(
          (service) =>
            `| ${service.name} | **${formatMonthlyMoney(service.amount, service.currency)}** |`,
        ),
      );
    }
    if (positiveCostServices.length) {
      costLines.push(
        "",
        "```mermaid",
        "pie title Monthly cost by service",
        ...positiveCostServices.map(
          (service) => `  "${mermaidLabel(service.name)}" : ${trimNumber(service.amount, 3)}`,
        ),
        "```",
      );
    }
    if (costLines.length) {
      lines.push(
        "",
        "<details>",
        "<summary>Cost drilldown</summary>",
        "",
        ...costLines,
        "",
        "</details>",
      );
    }
  }
  if (validation) {
    lines.push(
      "",
      "<details>",
      "<summary>Validation details</summary>",
      "",
      ...validationDetailLines(validation),
      "",
      "</details>",
    );
  }
  if (architectureLines.length) {
    lines.push(
      "",
      "<details>",
      "<summary>Architecture insights</summary>",
      "",
      ...architectureLines,
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
      const [{ cost, waf, preload, graph }, configText] = await Promise.all([
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
        reports: reviewReportStatuses({ cost, waf, preload, graph }),
        gate: evaluateGate({ configText, waf, cost, preload, graph, project }),
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

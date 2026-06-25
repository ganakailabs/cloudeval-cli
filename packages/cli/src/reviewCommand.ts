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

const firstArray = (...values: unknown[]): unknown[] | undefined => {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value;
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
  const formattedAmount = trimNumber(numericAmount);
  return currency ? `${formattedAmount} ${currency}` : formattedAmount;
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

const failedValidationRecords = (records?: unknown[]): Record<string, any>[] =>
  (Array.isArray(records) ? records : [])
    .map(asRecord)
    .filter((record) => {
      const status = String(
        record.status ??
          record.outcome ??
          record.result ??
          record.state ??
          "",
      ).toLowerCase();
      if (record.passed === false || record.success === false) {
        return true;
      }
      return ["fail", "failed", "error", "critical"].includes(status);
    });

const severityIcon = (severity?: string): string => {
  switch (String(severity ?? "").toLowerCase()) {
    case "critical":
    case "error":
    case "high":
    case "fail":
    case "failed":
      return "🔴";
    case "warning":
    case "warn":
    case "medium":
      return "🟡";
    case "info":
    case "low":
      return "🔵";
    default:
      return "⚪";
  }
};

const compactMarkdownCell = (value: unknown, fallback = "not available"): string => {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
  return text || fallback;
};

const failureName = (record: Record<string, any>, fallback: string): string =>
  compactMarkdownCell(
    record.test_name ??
      record.testName ??
      record.rule_name ??
      record.ruleName ??
      record.name ??
      record.title ??
      record.id ??
      fallback,
  );

const failureLocation = (record: Record<string, any>): string =>
  compactMarkdownCell(
    record.file_path ??
      record.filePath ??
      record.path ??
      record.resource_id ??
      record.resourceId ??
      record.resource ??
      record.target,
    "-",
  );

const failureWhy = (record: Record<string, any>): string => {
  const message = compactMarkdownCell(
    record.message ?? record.reason ?? record.description ?? record.details,
    "",
  );
  const recommendation = compactMarkdownCell(
    record.recommendation ?? record.remediation ?? record.fix ?? record.next_step,
    "",
  );
  if (message && recommendation && message !== recommendation) {
    return `${message} ${recommendation}`;
  }
  return message || recommendation || "No failure reason was included in the report payload.";
};

const validationFailureRows = (validation?: Record<string, any>): string[] => {
  const rows: string[] = [];
  const unitFailures = (Array.isArray(validation?.unitTests?.failures)
    ? validation?.unitTests?.failures
    : []
  )
    .map(asRecord)
    .slice(0, 5);
  const policyFailures = (Array.isArray(validation?.policyChecks?.failures)
    ? validation?.policyChecks?.failures
    : []
  )
    .map(asRecord)
    .slice(0, 5);
  const groupedFailures: Array<["Unit test" | "Policy check", Record<string, any>[]]> = [
    ["Unit test", unitFailures],
    ["Policy check", policyFailures],
  ];
  for (const [kind, failures] of groupedFailures) {
    failures.forEach((failure, index) => {
      const severity = compactMarkdownCell(
        failure.severity ?? failure.status ?? failure.outcome,
        "failed",
      );
      rows.push(
        `| ${kind} | ${failureName(failure, `${kind} ${index + 1}`)} | \`${failureLocation(failure)}\` | ${severityIcon(severity)} ${severity} | ${failureWhy(failure)} |`,
      );
    });
  }
  return rows;
};

const architectureSignalLines = ({
  architecture,
  costServices,
  costCurrency,
  highRiskFindings,
  pillars,
}: {
  architecture?: Record<string, any>;
  costServices: Array<{ name: string; amount: number; currency?: string }>;
  costCurrency?: string;
  highRiskFindings?: unknown;
  pillars: Array<Record<string, any>>;
}): string[] => {
  const lines: string[] = [];
  const resourceCount = numberFrom(architecture?.resources);
  const resourceTypeCount = numberFrom(architecture?.resourceTypes);
  const relationshipCount = numberFrom(architecture?.relationships);
  const density = numberFrom(architecture?.relationshipDensity);
  if (resourceCount !== undefined && resourceTypeCount !== undefined) {
    lines.push(
      `- Scale: **${displayNumber(resourceCount)} resources** across **${displayNumber(resourceTypeCount)} resource types**`,
    );
  } else if (resourceCount !== undefined) {
    lines.push(`- Scale: **${displayNumber(resourceCount)} resources**`);
  }
  if (relationshipCount !== undefined) {
    const densityText =
      density !== undefined
        ? ` (**${trimNumber(density, 2)} per resource**)`
        : "";
    const shape =
      density !== undefined && density < 0.5
        ? "; sparse dependency graph, review isolated resources and missing links"
        : density !== undefined && density > 2
          ? "; dense dependency graph, review blast radius before changes"
          : "";
    lines.push(
      `- Dependency shape: **${displayNumber(relationshipCount)} relationships**${densityText}${shape}`,
    );
  }
  const highRisk = numberFrom(highRiskFindings);
  const weakestPillar = pillars
    .map((pillar) => ({
      label: String(pillar.label ?? pillar.id ?? "pillar"),
      score: numberFrom(pillar.score),
    }))
    .filter((pillar): pillar is { label: string; score: number } => pillar.score !== undefined)
    .sort((left, right) => left.score - right.score)[0];
  if (highRisk !== undefined || weakestPillar) {
    const parts: string[] = [];
    if (highRisk !== undefined) {
      parts.push(`**${displayNumber(highRisk)} high-risk findings**`);
    }
    if (weakestPillar) {
      const rating = scoreRating(weakestPillar.score);
      parts.push(
        `weakest pillar **${weakestPillar.label} ${formatScore(weakestPillar.score)} (${rating ?? "UNKNOWN"})**`,
      );
    }
    lines.push(`- Risk concentration: ${parts.join("; ")}`);
  }
  const topCostDrivers = costServices
    .filter((service) => service.amount > 0)
    .sort((left, right) => right.amount - left.amount)
    .slice(0, 2);
  if (topCostDrivers.length) {
    const total = topCostDrivers.reduce((sum, service) => sum + service.amount, 0);
    lines.push(
      `- Cost drivers: ${joinReadableList(
        topCostDrivers.map((service) => `**${service.name}**`),
      )} account for **${formatMonthlyMoney(total, costCurrency ?? topCostDrivers[0]?.currency)}**`,
    );
  }
  return lines;
};

const namedAmount = (record: Record<string, any>): number | undefined =>
  numberFrom(
    record.amount,
    record.monthly_cost,
    record.monthlyCost,
    record.monthly_cost_estimate,
    record.monthlyCostEstimate,
    record.cost,
    record.value,
  );

const namedLabel = (record: Record<string, any>, fallback: string): string =>
  String(
    record.name ??
      record.resource_name ??
      record.resourceName ??
      record.service ??
      record.label ??
      record.category ??
      fallback,
  );

const mermaidLabel = (value: string): string => value.replace(/"/g, "'");

const joinReadableList = (values: string[]): string => {
  if (values.length <= 1) {
    return values[0] ?? "";
  }
  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`;
  }
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
};

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

const sortedPositiveCostRows = (
  rows: Array<{ name: string; amount: number; currency?: string }>,
): Array<{ name: string; amount: number; currency?: string }> =>
  rows
    .filter((row) => row.amount > 0)
    .sort((left, right) => right.amount - left.amount);

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

const compactCostRowsForChart = (
  rows: Array<{ name: string; amount: number; currency?: string }>,
  totalAmount?: number,
  currency?: string,
  options: { maxRows?: number; remainderLabel?: string } = {},
): Array<{ name: string; amount: number; currency?: string }> => {
  const maxRows = options.maxRows ?? 5;
  const remainderLabel = options.remainderLabel ?? "Unallocated";
  const total = numberFrom(totalAmount);
  const positiveRows = sortedPositiveCostRows(rows);
  const selected = positiveRows.slice(0, maxRows);
  const collapsed = positiveRows.slice(maxRows);
  const collapsedSum = Number(
    collapsed.reduce((sum, row) => sum + row.amount, 0).toFixed(3),
  );
  const result = [...selected];
  if (collapsedSum > 0.001) {
    result.push({
      name: "Other",
      amount: collapsedSum,
      ...(currency ? { currency } : {}),
    });
  }
  const represented = result.reduce((sum, row) => sum + row.amount, 0);
  if (total !== undefined) {
    const delta = Number((total - represented).toFixed(3));
    if (delta > 0.001) {
      result.push({
        name: remainderLabel,
        amount: delta,
        ...(currency ? { currency } : {}),
      });
    }
  }
  return result;
};

const markdownLink = (label: string, url?: string): string =>
  url ? `[${label}](${url})` : label;

const openInCloudEvalLines = (links: Record<string, any> | undefined): string[] => {
  if (!links) {
    return [];
  }
  const reports = asRecord(links.reports);
  const downloads = asRecord(links.downloads);
  const entries = [
    ["Project preview", links.project],
    ["Architecture report", reports.architecture],
    ["Cost report", reports.cost],
    ["Validation details", reports.validation],
    ["Download PDF", downloads.pdf],
    ["Workflow run", links.workflowRun],
    ["Download review artifacts", downloads.reviewArtifacts],
  ].filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0);
  return entries.map(([label, url]) => `- ${markdownLink(label, url)}`);
};

const monthlyCostImpactLines = (
  currentAmount: unknown,
  savingsAmount: unknown,
  currency?: string,
): string[] => {
  const current = numberFrom(currentAmount);
  const savings = numberFrom(savingsAmount);
  if (current === undefined || current <= 0 || savings === undefined || savings <= 0) {
    return [];
  }
  const optimized = Math.max(current - savings, 0);
  const savingsPercent = current > 0 ? (savings / current) * 100 : undefined;
  const yMax = Math.max(current, optimized, savings);
  return [
    "| Metric | Amount |",
    "| --- | ---: |",
    `| Current monthly cost | **${formatMonthlyMoney(current, currency)}** |`,
    `| Potential savings | **${formatMonthlyMoney(savings, currency)}${savingsPercent !== undefined ? ` (${trimNumber(savingsPercent, 1)}%)` : ""}** |`,
    `| Optimized monthly cost | **${formatMonthlyMoney(optimized, currency)}** |`,
    "",
    "```mermaid",
    "xychart-beta",
    '  title "Monthly cost impact"',
    '  x-axis ["Current", "Optimized"]',
    `  y-axis "${currency ? `${currency}/mo` : "monthly cost"}" 0 --> ${trimNumber(yMax, 3)}`,
    `  bar [${trimNumber(current, 3)}, ${trimNumber(optimized, 3)}]`,
    "```",
  ];
};

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
  const unitFailures = failedValidationRecords(
    firstArray(
      preload?.latest_payloads?.unit_tests?.test_results,
      preload?.latest_payloads?.unit_tests?.results,
      preload?.reports?.unit_tests?.metrics?.test_results,
      preload?.reports?.unit_tests?.metrics?.results,
      project?.status?.unit_tests?.test_results,
      project?.status?.unit_tests?.results,
    ),
  );
  const policyFailures = failedValidationRecords(
    firstArray(
      policySummary?.results,
      policySummary?.checks,
      waf?.parsed?.validation_results,
      waf?.parsed?.rules,
      waf?.raw?.rules,
      failedRules,
    ),
  );
  return {
    policyChecks: {
      total: numberFrom(policySummary?.total_rules, policySummary?.totalRules, rules.length),
      passed: numberFrom(policySummary?.passed_rules, policySummary?.passedRules),
      failed: numberFrom(policySummary?.failed_rules, policySummary?.failedRules, failedRules.length),
      errors: numberFrom(policySummary?.error_rules, policySummary?.errorRules),
      failures: policyFailures.slice(0, 5),
    },
    unitTests: {
      status: unitSummary?.status,
      total: numberFrom(unitSummary?.total_tests, unitSummary?.totalTests),
      passed: numberFrom(unitSummary?.passed_tests, unitSummary?.passedTests),
      failed: numberFrom(unitSummary?.failed_tests, unitSummary?.failedTests),
      skipped: numberFrom(unitSummary?.skipped_tests, unitSummary?.skippedTests),
      failures: unitFailures.slice(0, 5),
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
    topResources: (
      firstArray(
        cost?.report?.raw?.resource_estimates,
        cost?.report?.raw?.resourceEstimates,
        cost?.raw?.resource_estimates,
        cost?.raw?.resourceEstimates,
        cost?.parsed?.resourceEstimates,
        cost?.parsed?.resource_estimates,
        preload?.latest_payloads?.cost?.raw?.resource_estimates,
        preload?.latest_payloads?.cost?.raw?.resourceEstimates,
      ) ?? []
    ).slice(0, 20),
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

const renderAiSummarySections = (shortSummary: string, detailsMarkdown: string): string => {
  const lines = [shortSummary.trim()];
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

const githubWorkflowRunUrl = (): string | undefined => {
  const server = process.env.GITHUB_SERVER_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (server && repo && runId) {
    return `${server.replace(/\/$/, "")}/${repo}/actions/runs/${runId}`;
  }
  return undefined;
};

const reviewSurface = (): "local_review" | "pull_request" => {
  const event = String(process.env.GITHUB_EVENT_NAME ?? "").toLowerCase();
  const ref = String(process.env.GITHUB_REF ?? "").toLowerCase();
  return event.startsWith("pull_request") || ref.startsWith("refs/pull/")
    ? "pull_request"
    : "local_review";
};

const buildReviewSummaryPayload = (data: Record<string, any>): Record<string, any> => ({
  source: process.env.GITHUB_ACTIONS === "true" ? "github_action" : "cli",
  surface: reviewSurface(),
  project: data.project ?? { id: data.projectId },
  repository: { full_name: data.repo },
  ref: data.ref,
  commit_sha: data.commitSha,
  workflow_run_url: githubWorkflowRunUrl(),
  gate_result: {
    status: data.gate?.status,
    failures: data.gate?.failures ?? [],
    thresholds: data.gate?.thresholds ?? {},
    enforcement: data.gate?.enforcement,
  },
  well_architected: data.gate?.wellArchitected ?? {},
  cost: data.gate?.cost ?? {},
  validation: data.gate?.validation ?? {},
  policy: data.gate?.validation?.policy ?? data.gate?.policy ?? {},
  architecture_signals: data.gate?.architecture ?? {},
  changed_files: data.changedFiles ?? [],
});

const deterministicAiSummary = (
  data: Record<string, any>,
  error?: string,
): Record<string, any> => {
  const score = data.gate?.wellArchitected?.overall?.score ?? data.gate?.overallScore;
  const rating = scoreRating(score) ?? "UNKNOWN";
  const validation = data.gate?.validation ?? {};
  const cost = data.gate?.cost?.monthly ?? {};
  const failedTests = numberFrom(validation?.unitTests?.failed) ??
    numberFrom(validation?.unit_tests?.failed) ??
    numberFrom(validation?.failedUnitTests) ??
    numberFrom(validation?.failed_tests) ??
    0;
  const policyFailed = numberFrom(validation?.policyChecks?.failed) ??
    numberFrom(validation?.policy_checks?.failed) ??
    numberFrom(data.gate?.policy?.failed) ??
    0;
  const policyStatus = policyFailed > 0 ? "has failed checks" : "GOOD";
  const weakestPillar = Array.isArray(data.gate?.wellArchitected?.pillars)
    ? data.gate.wellArchitected.pillars
        .filter((pillar: Record<string, any>) => numberFrom(pillar.score) !== undefined)
        .sort(
          (left: Record<string, any>, right: Record<string, any>) =>
            (numberFrom(left.score) ?? 0) - (numberFrom(right.score) ?? 0),
        )[0]
    : undefined;
  const weakestPillarLabel = weakestPillar?.label ?? weakestPillar?.id ?? "the weakest Well-Architected pillar";
  const highRisk = numberFrom(data.gate?.wellArchitected?.risks?.high) ?? 0;
  const summary = [
    `CloudEval review completed with **${String(data.gate?.status ?? "UNKNOWN").toUpperCase()}**.`,
    `Well-Architected posture is **${formatScore(score)} (${rating})**, validation has **${displayNumber(failedTests)} failed unit tests**, policy checks are **${policyStatus}**, and monthly cost is **${formatMonthlyMoney(cost?.amount, cost?.currency)}**.`,
    `Prioritize **failed validation checks** and **${weakestPillarLabel}** first.`,
  ].join(" ");
  const detailsMarkdown = [
    `**Main risk**\nThe gate is **${String(data.gate?.status ?? "UNKNOWN").toUpperCase()}** with Well-Architected posture **${formatScore(score)} (${rating})**, **${displayNumber(failedTests)} failed unit tests**, and monthly cost **${formatMonthlyMoney(cost?.amount, cost?.currency)}**.`,
    `**Why it matters**\n${highRisk > 0 ? `There are **${displayNumber(highRisk)} high-risk findings**. ` : ""}Validation failures, weak architecture pillars, and cost over budget are the highest-signal remediation inputs before merge.`,
    `**Recommended actions**\nFix **${displayNumber(failedTests)} failed unit tests**, address **${weakestPillarLabel}**, review cost drivers against the budget, rerun CloudEval review, and compare the updated gate.`,
    "**Evidence used**\n**Gate status**, **Well-Architected score**, **validation totals**, **policy totals**, **monthly cost**, and **architecture signals**.",
  ].join("\n\n");
  return {
    enabled: true,
    status: "fallback",
    fallbackUsed: true,
    warnings: error ? [`Review summary endpoint failed: ${error}`] : [],
    shortSummary: summary,
    detailsMarkdown,
    markdown: renderAiSummarySections(summary, detailsMarkdown),
  };
};

const generateAiSummary = async (input: GenerateAiSummaryInput): Promise<Record<string, any>> => {
  try {
    const payload = buildReviewSummaryPayload(input.data);
    const response = await fetchCloudEvalJson<Record<string, any>>({
      baseUrl: input.baseUrl,
      authToken: input.token,
      path: `/projects/${encodeURIComponent(String(input.data.projectId))}/review/summary`,
      method: "POST",
      body: payload,
      idempotencyKey: `cloudeval-review-summary-${input.data.projectId}-${input.data.commitSha ?? "head"}`,
    });
    const shortSummary = String(response.summary ?? "").trim();
    const detailsMarkdown = String(response.details ?? "").trim();
    if (!shortSummary) {
      return deterministicAiSummary(input.data, "Review summary endpoint returned no summary.");
    }
    return {
      enabled: true,
      status: response.fallback_used ? "fallback" : "ok",
      fallbackUsed: Boolean(response.fallback_used),
      warnings: Array.isArray(response.warnings) ? response.warnings : [],
      riskHighlights: Array.isArray(response.risk_highlights)
        ? response.risk_highlights
        : [],
      recommendedActions: Array.isArray(response.recommended_actions)
        ? response.recommended_actions
        : [],
      evidenceUsed: Array.isArray(response.evidence_used)
        ? response.evidence_used
        : [],
      shortSummary,
      detailsMarkdown,
      markdown: renderAiSummarySections(shortSummary, detailsMarkdown),
    };
  } catch (error: any) {
    return deterministicAiSummary(input.data, error?.message ?? "request failed");
  }
};

const buildMarkdownSummary = (data: Record<string, any>): string => {
  const gateStatus = String(data.gate?.status ?? "unknown").toUpperCase();
  const score = data.gate?.overallScore ?? data.gate?.wellArchitected?.overall?.score;
  const cost = data.gate?.cost?.monthly;
  const validation = data.gate?.validation;
  const architecture = data.gate?.architecture;
  const projectLabel = String(data.project?.name ?? data.projectName ?? data.projectId);
  const projectDisplay = markdownLink(projectLabel, data.project?.url ?? data.projectUrl);
  const repository = String(data.repo ?? "unknown repository");
  const ref = String(data.ref ?? "unknown ref");
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
  const resourceCostRows = compactCostRowsForChart(
    costServiceRows(data.gate?.cost?.topResources, cost?.currency),
    cost?.amount,
    cost?.currency,
    { maxRows: 5, remainderLabel: "Unallocated" },
  );
  const positiveResourceCosts = resourceCostRows.filter((resource) => resource.amount > 0);
  const namedResourceCosts = positiveResourceCosts.filter(
    (resource) => resource.name !== "Unallocated",
  );
  const costPieRows = namedResourceCosts.length
    ? positiveResourceCosts
    : costServices.filter((service) => service.amount > 0);
  const costPieTitle = namedResourceCosts.length
    ? "Monthly cost by resource"
    : "Monthly cost by service";
  const openLinks = openInCloudEvalLines(data.links);
  const architectureLines = architectureSignalLines({
    architecture,
    costServices,
    costCurrency: cost?.currency,
    highRiskFindings: data.gate?.wellArchitected?.risks?.high,
    pillars: Array.isArray(data.gate?.wellArchitected?.pillars)
      ? data.gate.wellArchitected.pillars
      : [],
  });
  const validationRows = validationFailureRows(validation);
  const overallRating = scoreRating(score);
  const lines = [
    `${statusIcon(data.gate?.status)} **Overall** : ${gateStatus}`,
    `${scoreRatingIcon(overallRating)} Well-Architected Posture: ${formatScore(score)} (${overallRating ?? "UNKNOWN"})`,
    validationSummaryLine(validation),
    policySummaryLine(validation),
    costSummaryLine(cost),
    "",
    "#### Source",
    "",
    `- **CloudEval project**: ${projectDisplay}`,
    `- **Repository**: \`${repository}\``,
    `- **Ref**: \`${ref}\``,
    `- **Commit**: \`${commit}\``,
  ];
  if (openLinks.length) {
    lines.push("", "#### Open in CloudEval", "", ...openLinks);
  }
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
    const impactLines = monthlyCostImpactLines(
      cost?.amount,
      data.gate?.cost?.estimatedSavings?.amount,
      cost?.currency ?? data.gate?.cost?.estimatedSavings?.currency,
    );
    if (impactLines.length) {
      costLines.push(...impactLines);
    } else if (data.gate?.cost?.estimatedSavings?.amount !== undefined) {
      costLines.push(
        `- Estimated savings: **${formatMonthlyMoney(data.gate.cost.estimatedSavings.amount, data.gate.cost.estimatedSavings.currency)}**`,
      );
    }
    if (costPieRows.length) {
      costLines.push(
        "",
        "```mermaid",
        `pie title ${costPieTitle}`,
        ...costPieRows.map(
          (row) => `  "${mermaidLabel(row.name)}" : ${trimNumber(row.amount, 3)}`,
        ),
        "```",
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
      `<summary>${validationRows.length ? "Validation failures" : "Validation details"}</summary>`,
      "",
      ...validationDetailLines(validation),
      ...(validationRows.length
        ? [
            "",
            "| Type | Name | Location | Severity | Why / next step |",
            "| --- | --- | --- | --- | --- |",
            ...validationRows,
          ]
        : []),
      "",
      "</details>",
    );
  }
  if (architectureLines.length) {
    lines.push(
      "",
      "<details>",
      "<summary>Architecture signals</summary>",
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
      const frontendBaseUrl = resolveFrontendBaseUrl({ apiBaseUrl: context.baseUrl });
      const projectUrl = buildFrontendUrl({
        baseUrl: frontendBaseUrl,
        target: "project",
        projectId,
        view: "preview",
        layout: "architecture",
      });
      const workflowRunUrl = githubWorkflowRunUrl();
      const data: Record<string, any> = {
        projectId,
        project: {
          id: projectId,
          name: String(project?.name ?? projectId),
          url: projectUrl,
        },
        links: {
          project: projectUrl,
          reports: {
            architecture: buildFrontendUrl({
              baseUrl: frontendBaseUrl,
              target: "reports",
              projectId,
              tab: "architecture",
              reportType: "architecture",
            }),
            cost: buildFrontendUrl({
              baseUrl: frontendBaseUrl,
              target: "reports",
              projectId,
              tab: "cost",
              reportType: "cost",
            }),
            validation: buildFrontendUrl({
              baseUrl: frontendBaseUrl,
              target: "reports",
              projectId,
              tab: "validation",
              reportType: "unit_tests",
            }),
          },
          downloads: {
            pdf: buildFrontendUrl({
              baseUrl: frontendBaseUrl,
              target: "reports",
              projectId,
              downloadPdf: true,
              pdfVerbosity: "full",
            }),
            ...(workflowRunUrl ? { reviewArtifacts: workflowRunUrl } : {}),
          },
          ...(workflowRunUrl ? { workflowRun: workflowRunUrl } : {}),
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
        process.exitCode = 1;
        return;
      }
      process.exitCode = 0;
    } catch (error: any) {
      console.error(error?.message ?? "Review failed");
      process.exitCode = 1;
    }
  });
};

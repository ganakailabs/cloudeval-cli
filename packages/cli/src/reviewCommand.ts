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
import { buildSignalStoryReviewFallback } from "./signalstoryReviewAdapter.js";
import { registerReviewLocalCommand } from "./reviewLocalCommand.js";
import { collectReviewDiff, parseReviewDiffConfig } from "./reviewDiff.js";
import {
  buildReviewAnnotations,
  extractReviewFindings,
  parseReviewGithubConfig,
} from "./reviewFindings.js";
import { buildReviewSarifLog } from "./reviewSarif.js";

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
  githubChecks?: boolean;
  checksAnnotationLimit?: string;
  checksAllFiles?: boolean;
  checksIncludeNotices?: boolean;
  sarif?: boolean;
  sarifOutput?: string;
  format?: MachineOutputFormat;
  quiet?: boolean;
  progress?: string;
  model?: string;
};

type ReviewPdfReportType = "all" | "architecture" | "cost" | "unit_tests";
type ReviewPdfVerbosity = "brief" | "detailed" | "evidence";

type ReviewPdfOutputConfig = {
  enabled: boolean;
  reportType: ReviewPdfReportType;
  verbosity: ReviewPdfVerbosity;
  failOnError: boolean;
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

const findYamlBlock = (
  configText: string | undefined,
  pathKeys: string[],
): string | undefined => {
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
    if (found === -1) {
      return undefined;
    }
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

const yamlScalarValue = (
  block: string | undefined,
  ...keys: string[]
): string | undefined => {
  if (!block) return undefined;
  for (const key of keys) {
    const match = block.match(
      new RegExp(`^\\s*${key}\\s*:\\s*["']?([^"'\\n#]+)["']?\\s*(?:#.*)?$`, "m"),
    );
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }
  return undefined;
};

const yamlBooleanValue = (
  block: string | undefined,
  ...keys: string[]
): boolean | undefined => {
  const value = yamlScalarValue(block, ...keys);
  if (value === undefined) return undefined;
  if (/^(true|yes|on|1)$/i.test(value)) return true;
  if (/^(false|no|off|0)$/i.test(value)) return false;
  return undefined;
};

const normalizeReviewPdfReportType = (
  value: string | undefined,
): ReviewPdfReportType => {
  const normalized = String(value ?? "all").trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "cost") return "cost";
  if (normalized === "waf" || normalized === "architecture") return "architecture";
  if (normalized === "unit_tests" || normalized === "validation") return "unit_tests";
  return "all";
};

const normalizeReviewPdfVerbosity = (
  value: string | undefined,
): ReviewPdfVerbosity => {
  const normalized = String(value ?? "evidence").trim().toLowerCase();
  if (normalized === "brief" || normalized === "short") return "brief";
  if (normalized === "detailed") return "detailed";
  if (normalized === "evidence" || normalized === "full" || normalized === "extended") {
    return "evidence";
  }
  return "evidence";
};

const parseReviewPdfOutputConfig = (
  configText?: string,
): ReviewPdfOutputConfig | undefined => {
  const block = findYamlBlock(configText, ["ci", "review", "outputs", "pdf"]);
  if (!block) {
    return undefined;
  }
  return {
    enabled: yamlBooleanValue(block, "enabled") ?? false,
    reportType: normalizeReviewPdfReportType(
      yamlScalarValue(block, "report_type", "reportType", "type"),
    ),
    verbosity: normalizeReviewPdfVerbosity(
      yamlScalarValue(block, "verbosity", "pdf_verbosity", "pdfVerbosity"),
    ),
    failOnError: yamlBooleanValue(block, "fail_on_error", "failOnError") ?? false,
  };
};

const parseGateConfig = (configText?: string):
  | {
      enforcement: "required" | "warn";
      overallScoreMin: number;
      pillarScoreMin?: number;
      pillarScoreMins: Record<string, number>;
      failOnHighRisk: boolean;
      failOnPostureFindings: boolean;
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
    failOnPostureFindings: firstBooleanValue(
      "fail_on_cloud_posture_findings",
      "fail_when_cloud_posture_findings_exist",
      "fail_on_posture_findings",
      "fail_when_posture_findings_exist",
    ) ?? false,
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
  message: rule.message ?? rule.reason ?? rule.description,
  recommendation: rule.recommendation ?? rule.remediation ?? rule.fix,
  path:
    rule.file_path ??
    rule.filePath ??
    rule.path ??
    rule.source_file ??
    rule.sourceFile,
  line:
    rule.line ??
    rule.line_number ??
    rule.lineNumber ??
    rule.start_line ??
    rule.startLine,
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
  nestedStatuses?: unknown[],
): Record<string, any> => {
  const syncRecord = asRecord(sync);
  return {
    job: publicJobStatus(syncRecord.job ?? syncRecord),
    projectId: syncRecord.project_id ?? syncRecord.projectId,
    commitSha: syncRecord.commit_sha ?? syncRecord.commitSha,
    finalStatus: publicJobStatus(finalStatus),
    nestedJobs: (nestedStatuses ?? []).map(publicJobStatus).filter(Boolean),
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

const shieldSegment = (value: string): string =>
  encodeURIComponent(value.trim().replace(/-/g, "--").replace(/_/g, "__"));

const badgeLink = ({
  label,
  message,
  color,
  url,
}: {
  label: string;
  message: string;
  color: string;
  url?: string;
}): string | undefined => {
  if (!url) {
    return undefined;
  }
  return `[![${label}](https://img.shields.io/badge/${shieldSegment(label)}-${shieldSegment(message)}-${color}?style=flat-square)](${url})`;
};

const openInCloudEvalBadges = (links: Record<string, any> | undefined): string[] => {
  if (!links) {
    return [];
  }
  const reports = asRecord(links.reports);
  const downloads = asRecord(links.downloads);
  return [
    badgeLink({
      label: "Project",
      message: "preview",
      color: "2563eb",
      url: typeof links.project === "string" ? links.project : undefined,
    }),
    badgeLink({
      label: "Report",
      message: "architecture",
      color: "16a34a",
      url: typeof reports.architecture === "string" ? reports.architecture : undefined,
    }),
    badgeLink({
      label: "Cost",
      message: "drilldown",
      color: "0f766e",
      url: typeof reports.cost === "string" ? reports.cost : undefined,
    }),
    badgeLink({
      label: "Validation",
      message: "details",
      color: "d97706",
      url: typeof reports.validation === "string" ? reports.validation : undefined,
    }),
    badgeLink({
      label: "PDF",
      message: "download",
      color: "7c3aed",
      url: typeof downloads.pdf === "string" ? downloads.pdf : undefined,
    }),
    badgeLink({
      label: "Workflow",
      message: "run",
      color: "475569",
      url: typeof links.workflowRun === "string" ? links.workflowRun : undefined,
    }),
    badgeLink({
      label: "Artifacts",
      message: "review",
      color: "475569",
      url:
        typeof downloads.reviewArtifacts === "string"
          ? downloads.reviewArtifacts
          : undefined,
    }),
  ].filter((entry): entry is string => Boolean(entry));
};

const signalTableCell = (summaryLine: string): string => {
  const match = summaryLine.match(/^(\S+)\s+[^:]+:\s*(.+)$/);
  if (!match) {
    return compactMarkdownCell(summaryLine);
  }
  return `${match[1]} **${compactMarkdownCell(match[2])}**`;
};

const reviewDecisionLine = ({
  gateStatus,
  score,
  rating,
}: {
  gateStatus: string;
  score?: unknown;
  rating?: ScoreRating;
}): string => {
  if (gateStatus === "FAIL") {
    return `${statusIcon(gateStatus)} **FAIL** - configured gates failed. Do not merge until the action queue is resolved and CloudEval is rerun.`;
  }
  if (gateStatus === "WARN") {
    return `${statusIcon(gateStatus)} **WARN** - configured gates are warning-only or non-blocking for this run. Review the action queue before merge.`;
  }
  if (rating === "CRITICAL" || rating === "POOR") {
    return `${statusIcon(gateStatus)} **PASS** - configured gates passed, but observed Well-Architected posture is **${formatScore(score)} (${rating})**. Tighten gate thresholds if this posture should block pull requests.`;
  }
  return `${statusIcon(gateStatus)} **PASS** - configured gates passed for this review. Use the drilldowns below to keep the posture improving.`;
};

const strongestPillarRisk = (
  pillars: Array<Record<string, any>>,
): { label: string; score: number; rating?: ScoreRating } | undefined =>
  pillars
    .map((pillar) => ({
      label: String(pillar.label ?? pillar.id ?? "Well-Architected pillar"),
      score: numberFrom(pillar.score),
    }))
    .filter((pillar): pillar is { label: string; score: number } => pillar.score !== undefined)
    .sort((left, right) => left.score - right.score)
    .map((pillar) => ({
      ...pillar,
      rating: scoreRating(pillar.score),
    }))[0];

const reviewActionItems = ({
  data,
  pillars,
  cost,
  validation,
}: {
  data: Record<string, any>;
  pillars: Array<Record<string, any>>;
  cost?: Record<string, any>;
  validation?: Record<string, any>;
}): string[] => {
  const endpointActions = Array.isArray(data.aiSummary?.recommendedActions)
    ? data.aiSummary.recommendedActions
        .map((action: unknown) => compactMarkdownCell(action, ""))
        .filter(Boolean)
    : [];
  const failedUnitTests = numberFrom(validation?.unitTests?.failed) ?? 0;
  const failedPolicyChecks = numberFrom(validation?.policyChecks?.failed) ?? 0;
  const weakest = strongestPillarRisk(pillars);
  const currentCost = numberFrom(cost?.amount);
  const savings = numberFrom(data.gate?.cost?.estimatedSavings?.amount);
  const currency = cost?.currency ?? data.gate?.cost?.estimatedSavings?.currency;
  const actions: string[] = [...endpointActions];
  if (failedUnitTests > 0 || failedPolicyChecks > 0) {
    const parts: string[] = [];
    if (failedUnitTests > 0) {
      parts.push(`${displayNumber(failedUnitTests)} failed unit tests`);
    }
    if (failedPolicyChecks > 0) {
      parts.push(`${displayNumber(failedPolicyChecks)} failed policy checks`);
    }
    actions.push(
      `**Fix validation failures** - resolve ${joinReadableList(parts)} and rerun CloudEval review.`,
    );
  }
  if (weakest) {
    actions.push(
      `**Prioritize ${weakest.label}** - weakest pillar is **${formatScore(weakest.score)} (${weakest.rating ?? "UNKNOWN"})**.`,
    );
  }
  if (currentCost !== undefined) {
    const savingsText =
      savings !== undefined && savings > 0
        ? `; review the estimated **${formatMonthlyMoney(savings, currency)}** savings`
        : "";
    actions.push(
      `**Review cost drivers** - current monthly cost is **${formatMonthlyMoney(currentCost, currency)}**${savingsText}.`,
    );
  }
  if (Array.isArray(data.gate?.failures)) {
    for (const failure of data.gate.failures) {
      actions.push(`**Address gate failure** - ${compactMarkdownCell(failure)}.`);
    }
  }
  actions.push("**Rerun CloudEval** - confirm the updated gate, reports, and PR comment after remediation.");
  const unique: string[] = [];
  const seenKeys = new Set<string>();
  for (const action of actions) {
    const key = normalizeActionDedupeKey(action);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      unique.push(action);
    }
    if (unique.length >= 3) {
      break;
    }
  }
  return unique.map((action, index) => `${index + 1}. ${action}`);
};

const mermaidAxisId = (label: string): string => {
  const normalized = normalizeKey(label).replace(/[^a-z0-9_]/g, "_");
  return normalized || "pillar";
};

const compactMermaidAxisLabel = (label: string): string => {
  const compactLabels: Record<string, string> = {
    security: "Security",
    reliability: "Reliability",
    cost_optimization: "Cost",
    operational_excellence: "Ops",
    performance_efficiency: "Performance",
  };
  const normalized = normalizeKey(label);
  if (compactLabels[normalized]) {
    return compactLabels[normalized];
  }
  const cleaned = label.trim().replace(/\s+/g, " ");
  if (cleaned.length <= 16) {
    return cleaned;
  }
  const words = cleaned.split(" ");
  if (words.length > 1) {
    return words
      .slice(0, 2)
      .map((word) => (word.length > 8 ? word.slice(0, 8) : word))
      .join(" ");
  }
  return cleaned.slice(0, 16);
};

const wellArchitectedRadarLines = (
  pillars: Array<Record<string, any>>,
): string[] => {
  const scored = pillars
    .map((pillar) => {
      const label = String(pillar.label ?? pillar.id ?? "Pillar");
      const score = numberFrom(pillar.score);
      return score === undefined
        ? undefined
        : {
            id: mermaidAxisId(label),
            label,
            score,
          };
    })
    .filter(
      (pillar): pillar is { id: string; label: string; score: number } =>
        pillar !== undefined,
    );
  if (scored.length < 3) {
    return [];
  }
  return [
    "```mermaid",
    "radar-beta",
    "  title Well-Architected posture",
    `  axis ${scored
      .map(
        (pillar) =>
          `${pillar.id}["${mermaidLabel(compactMermaidAxisLabel(pillar.label))}"]`,
      )
      .join(", ")}`,
    `  curve current["Current"]{${scored
      .map((pillar) => trimNumber(pillar.score, 3))
      .join(", ")}}`,
    "  showLegend false",
    "  max 100",
    "  min 0",
    "  graticule polygon",
    "  ticks 4",
    "```",
    "",
    "_If GitHub does not render Mermaid radar charts yet, use the table below as the fallback._",
  ];
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

const changedFileLines = (files: unknown): string[] => {
  const changed = (Array.isArray(files) ? files : [])
    .map(asRecord)
    .filter((file) => typeof file.path === "string" && file.path.trim())
    .slice(0, 15);
  if (!changed.length) {
    return [];
  }
  return [
    "| File | Change |",
    "| --- | ---: |",
    ...changed.map((file) => {
      const additions = numberFrom(file.additions);
      const deletions = numberFrom(file.deletions);
      const stats =
        additions !== undefined || deletions !== undefined
          ? `+${additions ?? 0} / -${deletions ?? 0}`
          : String(file.status ?? "changed");
      return `| \`${compactMarkdownCell(file.path)}\` | ${compactMarkdownCell(file.status ?? "changed")} (${stats}) |`;
    }),
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

const extractPostureGate = (project?: Record<string, any>) => {
  const status = asRecord(project?.status);
  const dashboard = asRecord(project?.dashboard);
  const reports = asRecord(project?.reports);
  const posture = asRecord(
    status.posture ??
      dashboard.posture ??
      reports.posture ??
      project?.posture,
  );
  const gate = asRecord(posture.gate ?? posture.release_gate);
  const rawStatus = String(
    posture.gate_result ??
      posture.gateResult ??
      posture.release_gate_status ??
      posture.releaseGateStatus ??
      gate.status ??
      "",
  )
    .trim()
    .toLowerCase();
  return {
    status: rawStatus || undefined,
    findingCount: numberFrom(
      posture.finding_count,
      posture.findingCount,
      posture.open_findings,
      posture.openFindings,
      posture.total_findings,
      posture.totalFindings,
    ),
    releaseBlockers: numberFrom(
      posture.release_blocker_count,
      posture.releaseBlockerCount,
      posture.blocking_count,
      posture.blockingCount,
      gate.blocking_count,
      gate.blockingCount,
    ),
    scannerCount: numberFrom(posture.scanner_count, posture.scannerCount),
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
  const posture = extractPostureGate(project);
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
      posture,
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
  if (["fail", "failed", "block", "blocked"].includes(posture.status ?? "")) {
    failures.push(
      `Cloud Posture gate failed${posture.releaseBlockers !== undefined ? ` with ${posture.releaseBlockers} release blockers` : ""}`,
    );
  } else if (
    gateConfig.failOnHighRisk &&
    posture.releaseBlockers !== undefined &&
    posture.releaseBlockers > 0
  ) {
    failures.push(`${posture.releaseBlockers} Cloud Posture release blockers`);
  } else if (
    gateConfig.failOnPostureFindings &&
    posture.findingCount !== undefined &&
    posture.findingCount > 0
  ) {
    failures.push(`${posture.findingCount} Cloud Posture findings require review`);
  }
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
    posture,
  };
};

const safeFetch = async <T>(input: Parameters<typeof fetchCloudEvalJson<T>>[0]): Promise<T | undefined> => {
  try {
    return await fetchCloudEvalJson<T>(input);
  } catch {
    return undefined;
  }
};

const writeReviewPdfOutput = async ({
  config,
  outputDir,
  baseUrl,
  token,
  projectId,
  userId,
}: {
  config?: ReviewPdfOutputConfig;
  outputDir?: string;
  baseUrl: string;
  token?: string;
  projectId: string;
  userId?: string;
}): Promise<Record<string, any> | undefined> => {
  if (!config) {
    return undefined;
  }
  const base = {
    enabled: config.enabled,
    reportType: config.reportType,
    verbosity: config.verbosity,
    failOnError: config.failOnError,
  };
  if (!config.enabled) {
    return { ...base, status: "skipped" };
  }
  if (!outputDir) {
    return {
      ...base,
      status: "skipped",
      reason: "PDF output requires --output so the file can be attached as an artifact.",
    };
  }
  try {
    const core = await import("@cloudeval/core");
    const pdf = await core.downloadReportPdf({
      baseUrl,
      authToken: token,
      projectId,
      userId,
      verbosity: config.verbosity,
      reportType: config.reportType,
      includeVisuals: true,
    });
    if (!pdf.bytes.length) {
      throw new Error("Backend returned an empty PDF.");
    }
    await fs.mkdir(outputDir, { recursive: true });
    const file = path.join(outputDir, "review.pdf");
    await fs.writeFile(file, pdf.bytes);
    return {
      ...base,
      status: "written",
      file,
      bytes: pdf.bytes.length,
      contentType: pdf.contentType,
      backendFilename: pdf.filename,
      reportStatus: pdf.status,
      warningsCount: pdf.warningsCount ?? 0,
    };
  } catch (error: any) {
    return {
      ...base,
      status: "failed",
      error: error?.message ?? "PDF download failed.",
    };
  }
};

const writeReviewSarifOutput = async ({
  enabled,
  outputFile,
  category,
  data,
}: {
  enabled: boolean;
  outputFile?: string;
  category: string;
  data: Record<string, any>;
}): Promise<Record<string, any> | undefined> => {
  if (!enabled) {
    return undefined;
  }
  if (!outputFile) {
    return {
      enabled,
      category,
      status: "skipped",
      reason: "SARIF output requires --output or --sarif-output.",
    };
  }
  const findings = extractReviewFindings(data).filter((finding) => finding.path);
  const sarif = buildReviewSarifLog({ findings, category });
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, JSON.stringify(sarif, null, 2), "utf8");
  return {
    enabled,
    category,
    status: "written",
    file: outputFile,
    resultCount: sarif.runs[0].results.length,
  };
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
    throw new Error(`${flagName} must be a positive number.`);
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

const fetchJobResult = async ({
  baseUrl,
  token,
  userId,
  jobId,
}: {
  baseUrl: string;
  token?: string;
  userId?: string;
  jobId: string;
}): Promise<unknown> => {
  const query = new URLSearchParams();
  if (userId) {
    query.set("user_id", userId);
  }
  const suffix = query.toString();
  return safeFetch<unknown>({
    baseUrl,
    authToken: token,
    path: `/jobs/${encodeURIComponent(jobId)}/result${suffix ? `?${suffix}` : ""}`,
  });
};

const maybeJobId = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return /^[0-9a-f-]{8,}$/i.test(value.trim()) ? value.trim() : undefined;
  }
  const record = firstRecord(value);
  if (!record) {
    return undefined;
  }
  const direct = [
    record.job_id,
    record.jobId,
    record.id,
    asRecord(record.job).job_id,
    asRecord(record.job).jobId,
    asRecord(record.job).id,
  ].find((candidate): candidate is string =>
    typeof candidate === "string" && candidate.trim().length > 0,
  );
  if (direct) {
    return direct;
  }
  const statusUrl = String(record.status_url ?? record.statusUrl ?? "").trim();
  const match = statusUrl.match(/\/jobs\/([^/?#]+)/);
  return match?.[1];
};

const collectNestedJobIds = (value: unknown): string[] => {
  const seen = new Set<string>();
  const ids: string[] = [];
  const visit = (candidate: unknown, keyHint = "") => {
    if (candidate === null || candidate === undefined) {
      return;
    }
    const id = maybeJobId(candidate);
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item, keyHint);
      }
      return;
    }
    if (typeof candidate !== "object") {
      return;
    }
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      const normalizedKey = normalizeKey(key || keyHint);
      if (
        normalizedKey === "result" ||
        normalizedKey === "data" ||
        normalizedKey.includes("refresh_analysis") ||
        normalizedKey.includes("report") ||
        normalizedKey.includes("sync") ||
        normalizedKey.includes("job")
      ) {
        visit(child, normalizedKey);
      }
    }
  };
  const root = asRecord(value);
  visit(root.result ?? root.data ?? value);
  return ids;
};

const waitForNestedJobs = async ({
  baseUrl,
  token,
  userId,
  projectId,
  parentJobId,
  pollIntervalMs,
  waitTimeoutMs,
}: {
  baseUrl: string;
  token?: string;
  userId?: string;
  projectId: string;
  parentJobId?: string;
  pollIntervalMs: number;
  waitTimeoutMs: number;
}): Promise<Record<string, any>[]> => {
  if (!parentJobId) {
    return [];
  }
  const result = await fetchJobResult({ baseUrl, token, userId, jobId: parentJobId });
  const nestedJobIds = collectNestedJobIds(result).filter((jobId) => jobId !== parentJobId);
  const statuses: Record<string, any>[] = [];
  for (const nestedJobId of nestedJobIds) {
    statuses.push(
      await waitForJob({
        baseUrl,
        token,
        userId,
        projectId,
        jobId: nestedJobId,
        pollIntervalMs,
        waitTimeoutMs,
      }),
    );
  }
  return statuses;
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

const normalizeActionDedupeKey = (value: string): string => {
  const normalized = value
    .replace(/\*\*/g, "")
    .replace(/\bone\b/gi, "1")
    .replace(/\btwo\b/gi, "2")
    .replace(/\bthree\b/gi, "3")
    .replace(/\bfour\b/gi, "4")
    .replace(/\bfive\b/gi, "5")
    .replace(/\bsix\b/gi, "6")
    .replace(/\bseven\b/gi, "7")
    .replace(/\beight\b/gi, "8")
    .replace(/\bnine\b/gi, "9")
    .replace(/\bten\b/gi, "10")
    .replace(/\bfailing\b/gi, "failed")
    .replace(/\bre-run\b/gi, "rerun")
    .toLowerCase();

  if (/\b(unit|validation)\s+tests?\b/.test(normalized) && /\b(fix|resolve|triage|address|rerun)\b/.test(normalized)) {
    return "validation-unit-tests";
  }
  if (/\bpolicy\b/.test(normalized) && /\b(fix|resolve|triage|address|rerun)\b/.test(normalized)) {
    return "validation-policy-checks";
  }
  if (/\bcost optimization\b/.test(normalized) && /\b(prioritize|increase|improve|fix|raise|address)\b/.test(normalized)) {
    return "pillar-cost-optimization";
  }
  if (/\breliability\b/.test(normalized) && /\b(prioritize|increase|improve|fix|raise|address)\b/.test(normalized)) {
    return "pillar-reliability";
  }
  if (/\bsecurity\b/.test(normalized) && /\b(prioritize|increase|improve|fix|raise|address)\b/.test(normalized)) {
    return "pillar-security";
  }

  return normalized.replace(/[^a-z0-9]+/g, " ").trim();
};

const dedupeRecommendedActionsInMarkdown = (detailsMarkdown: string): string => {
  const lines = detailsMarkdown.split(/\r?\n/);
  const seen = new Set<string>();
  let inRecommendedActions = false;
  const output: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const isBoldHeading = /^\*\*[^*]+\*\*$/.test(trimmed);
    const isMarkdownHeading = /^#{1,6}\s+/.test(trimmed);
    if (
      inRecommendedActions &&
      (isMarkdownHeading || (isBoldHeading && !/^\*\*Recommended actions\*\*$/i.test(trimmed)))
    ) {
      inRecommendedActions = false;
    }
    if (/^\*\*Recommended actions\*\*$/i.test(trimmed) || /^#{1,6}\s+Recommended actions\s*$/i.test(trimmed)) {
      inRecommendedActions = true;
      seen.clear();
      output.push(line);
      continue;
    }
    if (inRecommendedActions && /^\s*[-*]\s+/.test(line)) {
      const key = normalizeActionDedupeKey(line.replace(/^\s*[-*]\s+/, ""));
      if (key && seen.has(key)) {
        continue;
      }
      seen.add(key);
    }
    output.push(line);
  }

  return output.join("\n").trim();
};

const renderAiSummarySections = (shortSummary: string, detailsMarkdown: string): string => {
  const lines = [shortSummary.trim()];
  const sanitizedDetailsMarkdown = dedupeRecommendedActionsInMarkdown(detailsMarkdown);
  if (sanitizedDetailsMarkdown.trim()) {
    lines.push(
      "",
      "<details>",
      "<summary><strong>Detailed AI reviewer note - evidence, reasoning, and next actions</strong></summary>",
      "",
      sanitizedDetailsMarkdown.trim(),
      "",
      "</details>",
    );
  }
  return lines.join("\n");
};

const isInstructionLikeAiDetails = (detailsMarkdown: string): boolean => {
  const normalized = detailsMarkdown.toLowerCase();
  return [
    "markdown for a collapsible ai details section",
    "use short paragraphs or bullets",
    "bold important evidence keywords",
    "prefer concrete failed test names",
    "headings: **main risk**",
  ].some((marker) => normalized.includes(marker));
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

type ReviewSummaryPreferences = {
  model?: string;
  mode?: "ask" | "agent";
  agentProfileId?: string;
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

const buildReviewSummaryPayload = (
  data: Record<string, any>,
  preferences: ReviewSummaryPreferences = {},
): Record<string, any> => ({
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
  diff_summary: data.diffSummary ?? {},
  changed_files: data.changedFiles ?? [],
  ai_preferences: {
    mode: preferences.mode ?? "ask",
    ...(preferences.agentProfileId
      ? { agent_profile_id: preferences.agentProfileId }
      : {}),
    ...(preferences.model ? { model: preferences.model } : {}),
  },
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
  const signalStorySummary = buildSignalStoryReviewFallback({
    gateStatus: String(data.gate?.status ?? "UNKNOWN").toUpperCase(),
    score: formatScore(score),
    rating,
    scoreRating: `${formatScore(score)} (${rating})`,
    failedTests,
    policyStatus,
    monthlyCost: formatMonthlyMoney(cost?.amount, cost?.currency),
    weakestPillar: weakestPillarLabel,
  });
  if (signalStorySummary) {
    const signalStoryShortSummary = String(signalStorySummary.shortSummary ?? "").trim();
    const signalStoryDetailsMarkdown = String(signalStorySummary.detailsMarkdown ?? "").trim();
    return {
      ...signalStorySummary,
      warnings: error ? [`Review summary endpoint failed: ${error}`] : [],
      markdown: renderAiSummarySections(
        signalStoryShortSummary,
        signalStoryDetailsMarkdown,
      ),
    };
  }
  throw new Error("CloudEval SignalStory review rules did not produce a deterministic fallback summary.");
};

const generateAiSummary = async (input: GenerateAiSummaryInput): Promise<Record<string, any>> => {
  try {
    const payload = buildReviewSummaryPayload(input.data, {
      model: input.model,
      mode: input.mode,
      agentProfileId: input.agentProfileId,
    });
    const response = await fetchCloudEvalJson<Record<string, any>>({
      baseUrl: input.baseUrl,
      authToken: input.token,
      path: `/projects/${encodeURIComponent(String(input.data.projectId))}/review/summary`,
      method: "POST",
      body: payload,
      idempotencyKey: `cloudeval-review-summary-${input.data.projectId}-${input.data.commitSha ?? "head"}`,
    });
    const shortSummary = String(response.summary ?? "").trim();
    let detailsMarkdown = String(response.details ?? "").trim();
    if (!shortSummary) {
      return deterministicAiSummary(input.data, "Review summary endpoint returned no summary.");
    }
    const warnings = Array.isArray(response.warnings) ? response.warnings : [];
    if (isInstructionLikeAiDetails(detailsMarkdown)) {
      const fallback = deterministicAiSummary(
        input.data,
        "Review summary endpoint returned instruction-like details.",
      );
      detailsMarkdown = String(fallback.detailsMarkdown ?? "").trim();
      warnings.push("Review summary endpoint returned instruction-like details; using deterministic details.");
    }
    return {
      enabled: true,
      status: response.fallback_used || warnings.length > 0 ? "fallback" : "ok",
      fallbackUsed: Boolean(response.fallback_used) || warnings.length > 0,
      warnings,
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
  const pillars = Array.isArray(data.gate?.wellArchitected?.pillars)
    ? data.gate.wellArchitected.pillars
    : [];
  const pillarLines = pillars.length
    ? pillars.map((pillar: Record<string, any>) => {
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
  const linkBadges = openInCloudEvalBadges(data.links);
  const architectureLines = architectureSignalLines({
    architecture,
    costServices,
    costCurrency: cost?.currency,
    highRiskFindings: data.gate?.wellArchitected?.risks?.high,
    pillars,
  });
  const changedLines = changedFileLines(data.changedFiles);
  const validationRows = validationFailureRows(validation);
  const overallRating = scoreRating(score);
  const actionLines = reviewActionItems({
    data,
    pillars,
    cost,
    validation,
  });
  const radarLines = wellArchitectedRadarLines(pillars);
  const lines = [
    "## CloudEval infrastructure review",
    "",
    "| Signal | Result |",
    "| --- | --- |",
    `| Merge gate | ${statusIcon(data.gate?.status)} **${gateStatus}** |`,
    `| Observed posture | ${scoreRatingIcon(overallRating)} **${formatScore(score)} (${overallRating ?? "UNKNOWN"})** |`,
    `| Validation | ${signalTableCell(validationSummaryLine(validation))} |`,
    `| Policy | ${signalTableCell(policySummaryLine(validation))} |`,
    `| Cost | ${signalTableCell(costSummaryLine(cost))} |`,
  ];
  if (linkBadges.length) {
    lines.push("", "### Links", "", linkBadges.join(" "));
  }
  lines.push(
    "",
    "### Decision",
    "",
    reviewDecisionLine({ gateStatus, score, rating: overallRating }),
    "",
    "<details>",
    "<summary><strong>Source</strong></summary>",
    "",
    `- **CloudEval project**: ${projectDisplay}`,
    `- **Repository**: \`${repository}\``,
    `- **Ref**: \`${ref}\``,
    `- **Commit**: \`${commit}\``,
    "",
    "</details>",
  );
  if (changedLines.length) {
    lines.push(
      "",
      "<details>",
      "<summary><strong>Changed files</strong></summary>",
      "",
      ...changedLines,
      "",
      "</details>",
    );
  }
  if (data.aiSummary?.markdown) {
    lines.push("", "### AI summary", "", data.aiSummary.markdown);
  }
  if (actionLines.length) {
    lines.push(
      "",
      "<details open>",
      `<summary><strong>Action queue - ${actionLines.length} recommended fixes</strong></summary>`,
      "",
      ...actionLines,
      "",
      "</details>",
    );
  }
  if (Array.isArray(data.gate?.failures) && data.gate.failures.length) {
    lines.push(
      "",
      "<details>",
      "<summary><strong>Gate failures</strong></summary>",
      "",
      ...data.gate.failures.map((failure: string) => `- ${failure}`),
      "",
      "</details>",
    );
  }
  if (pillarLines.length) {
    lines.push(
      "",
      "<details>",
      "<summary><strong>Well-Architected drilldown</strong></summary>",
      "",
      ...riskLines,
      "",
      ...(radarLines.length
        ? ["**Radar (compact labels)**", "", ...radarLines, ""]
        : []),
      "**Scores**",
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
      costLines.push("**Cost impact**", "", ...impactLines);
    } else if (data.gate?.cost?.estimatedSavings?.amount !== undefined) {
      costLines.push(
        "**Cost impact**",
        "",
        `- Estimated savings: **${formatMonthlyMoney(data.gate.cost.estimatedSavings.amount, data.gate.cost.estimatedSavings.currency)}**`,
      );
    }
    if (costPieRows.length) {
      costLines.push(
        "",
        "**Cost split**",
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
        "<summary><strong>Cost drilldown</strong></summary>",
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
      `<summary><strong>${validationRows.length ? "Validation failures" : "Validation details"}</strong></summary>`,
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
      "<summary><strong>Architecture signals</strong></summary>",
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
    .option("--github-checks", "Include GitHub Checks annotation payload in review.json.")
    .option("--checks-annotation-limit <n>", "Maximum GitHub Checks annotations to emit.")
    .option("--checks-all-files", "Allow GitHub Checks annotations for unchanged files.")
    .option("--checks-include-notices", "Include notice-level GitHub Checks annotations.")
    .option("--sarif", "Write review.sarif.json when --output is set.")
    .option("--sarif-output <path>", "Write SARIF output to a specific file.")
    .option("--quiet", "Accepted for CI parity; review output stays machine-readable.", false)
    .option("--progress <mode>", "Accepted for CI parity; review does not stream progress.", "none")
    .option("--model <model>", "Accepted for CI parity with ask/agent modes.")
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text");

  registerReviewLocalCommand(command, deps);

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
      const initialProject = await fetchProjectById({
        baseUrl: context.baseUrl,
        token: context.token,
        projectId,
      });
      const projectUserId =
        typeof initialProject?.user_id === "string" && initialProject.user_id.trim()
          ? initialProject.user_id
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
      const nestedJobStatuses = options.wait === false
        ? []
        : await waitForNestedJobs({
            baseUrl: context.baseUrl,
            token: context.token,
            userId: scopedUserId,
            projectId,
            parentJobId: extractJobId(sync),
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
          });
      const project =
        (options.wait === false
          ? initialProject
          : await fetchProjectById({
              baseUrl: context.baseUrl,
              token: context.token,
              projectId,
            })) ?? initialProject;
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
      const diffConfig = parseReviewDiffConfig(configText);
      const diff = await collectReviewDiff({
        cwd,
        baseRef: diffConfig.baseRef,
        headRef: commitSha ?? "HEAD",
        maxFiles: diffConfig.maxFiles,
        maxPatchBytes: diffConfig.maxPatchBytes,
        enabled: diffConfig.enabled,
      });
      const githubReviewConfig = parseReviewGithubConfig(configText);
      const outputDir = options.output ? path.resolve(options.output) : undefined;
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
        source: {
          repo,
          ref,
          commit_sha: commitSha,
          source_root: sourceRoot,
          project_commit_sha:
            asRecord(project?.iac_source ?? project?.iacSource).commit_sha ??
            asRecord(project?.iac_source ?? project?.iacSource).commitSha,
          surface: reviewSurface(),
        },
        changedFiles: diff.changedFiles,
        diffSummary: diff.summary,
        warnings: diff.warnings,
        sync: reviewSyncStatus(sync, finalStatus, nestedJobStatuses),
        reports: reviewReportStatuses({ cost, waf, preload, graph }),
        gate: evaluateGate({ configText, waf, cost, preload, graph, project }),
      };
      const checksEnabled = Boolean(options.githubChecks) || githubReviewConfig.checks.enabled;
      const annotationLimit =
        options.checksAnnotationLimit !== undefined
          ? parsePositiveInteger(options.checksAnnotationLimit, "--checks-annotation-limit", 50)
          : githubReviewConfig.checks.annotationLimit;
      const annotations = buildReviewAnnotations(data, {
        annotationLimit,
        changedFilesOnly: options.checksAllFiles
          ? false
          : githubReviewConfig.checks.changedFilesOnly,
        includeNotices: options.checksIncludeNotices
          ? true
          : githubReviewConfig.checks.includeNotices,
      });
      data.github = {
        checks: {
          enabled: checksEnabled,
          name: githubReviewConfig.checks.name,
          annotationLimit,
          changedFilesOnly: options.checksAllFiles
            ? false
            : githubReviewConfig.checks.changedFilesOnly,
          includeNotices: options.checksIncludeNotices
            ? true
            : githubReviewConfig.checks.includeNotices,
          annotations: checksEnabled ? annotations : [],
          annotationCount: checksEnabled ? annotations.length : 0,
        },
        sarif: {
          enabled: Boolean(options.sarif) || githubReviewConfig.sarif.enabled,
          category: githubReviewConfig.sarif.category,
          upload: githubReviewConfig.sarif.upload,
          failOnUploadError: githubReviewConfig.sarif.failOnUploadError,
        },
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
      const filesWritten: string[] = [];
      const pdfOutput = await writeReviewPdfOutput({
        config: parseReviewPdfOutputConfig(configText),
        outputDir,
        baseUrl: context.baseUrl,
        token: context.token,
        projectId,
        userId: scopedUserId,
      });
      if (pdfOutput) {
        data.outputs = {
          ...asRecord(data.outputs),
          pdf: pdfOutput,
        };
        if (pdfOutput.status === "written" && typeof pdfOutput.file === "string") {
          filesWritten.push(pdfOutput.file);
        }
      }
      const sarifOutput = await writeReviewSarifOutput({
        enabled: Boolean(data.github?.sarif?.enabled),
        outputFile: options.sarifOutput
          ? path.resolve(options.sarifOutput)
          : outputDir
            ? path.join(outputDir, "review.sarif.json")
            : undefined,
        category: String(data.github?.sarif?.category ?? "cloudeval-iac"),
        data,
      });
      if (sarifOutput) {
        data.outputs = {
          ...asRecord(data.outputs),
          sarif: sarifOutput,
        };
        if (sarifOutput.status === "written" && typeof sarifOutput.file === "string") {
          filesWritten.push(sarifOutput.file);
        }
      }
      const summaryMarkdown = buildMarkdownSummary(data);
      if (outputDir) {
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
      if (pdfOutput?.status === "failed" && pdfOutput.failOnError === true) {
        process.exitCode = 1;
        return;
      }
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

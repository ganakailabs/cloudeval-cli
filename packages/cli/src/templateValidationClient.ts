import fs from "node:fs/promises";
import { fetchCloudEvalJson } from "./apiClient.js";

export type TemplateFileInput = {
  templatePath: string;
  parametersPath?: string;
};

export type ValidationOptions = {
  failedOnly?: boolean;
  ruleNames?: string[];
  category?: string;
  pillar?: string;
  minSeverity?: string;
  maxResults?: number;
  projectId?: string;
  saveReport?: boolean;
};

export type TemplateTestOptions = {
  testCategories?: string[];
  specificTests?: string[];
  skipTests?: string[];
  includeTests?: string[];
  testGroups?: string[];
  verboseOutput?: boolean;
};

export type AuthenticatedTemplateRequest = {
  baseUrl: string;
  authToken: string;
  userId: string;
};

export type TemplateValidationWaitResult = {
  submitted: unknown;
  jobId: string;
  status: unknown;
  result: unknown;
};

export type TemplateProgressItem = {
  name?: string;
  status?: string;
  passed?: boolean;
  category?: string;
  severity?: string;
  message?: string;
  recommendation?: string;
  location?: string;
  durationMs?: number;
  documentationUrl?: string;
};

export type TemplateProgressEvent = {
  phase: "submitted" | "status" | "result";
  jobId: string;
  operation?: string;
  status?: string;
  progress?: number;
  completed?: number;
  total?: number;
  currentItem?: string;
  message?: string;
  items?: TemplateProgressItem[];
  elapsedMs: number;
};

export const readJsonFile = async (filePath: string): Promise<unknown> => {
  const text = await fs.readFile(filePath, "utf8");
  try {
    return JSON.parse(text);
  } catch (error: any) {
    throw new Error(`Failed to parse JSON file ${filePath}: ${error?.message ?? "invalid JSON"}`);
  }
};

const readTemplateFiles = async (
  input: TemplateFileInput,
): Promise<{ template: unknown; parameterFile?: unknown }> => {
  const template = await readJsonFile(input.templatePath);
  const parameterFile = input.parametersPath
    ? await readJsonFile(input.parametersPath)
    : undefined;
  return { template, parameterFile };
};

const validationRequestBody = async (
  files: TemplateFileInput,
  options: ValidationOptions & { userId: string },
): Promise<Record<string, unknown>> => {
  const { template, parameterFile } = await readTemplateFiles(files);
  return {
    template,
    ...(parameterFile === undefined ? {} : { parameter_file: parameterFile }),
    options: {
      output_format: "json",
      include_recommendations: true,
      include_remediation_steps: true,
      include_documentation_links: true,
      include_only_failed: Boolean(options.failedOnly),
      ...(options.ruleNames?.length ? { rule_names: options.ruleNames } : {}),
      ...(options.category ? { rule_categories: [options.category] } : {}),
      ...(options.pillar ? { rule_pillars: [options.pillar] } : {}),
      ...(options.minSeverity ? { min_severity_level: options.minSeverity } : {}),
      ...(options.maxResults ? { max_results: options.maxResults } : {}),
    },
    user_id: options.userId,
    ...(options.projectId ? { project_id: options.projectId } : {}),
    ...(options.saveReport ? { save_report: true } : {}),
  };
};

export const validateTemplate = async (
  input: AuthenticatedTemplateRequest & TemplateFileInput & ValidationOptions,
): Promise<unknown> =>
  fetchCloudEvalJson({
    baseUrl: input.baseUrl,
    authToken: input.authToken,
    path: "/rule/template/validate",
    method: "POST",
    query: { user_id: input.userId },
    body: await validationRequestBody(input, {
      ...input,
      userId: input.userId,
    }),
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stringField = (
  value: Record<string, unknown> | undefined,
  field: string,
): string | undefined => {
  const raw = value?.[field];
  return typeof raw === "string" && raw.trim() ? raw : undefined;
};

const extractJobId = (value: unknown): string | undefined => {
  const record = recordValue(value);
  const job = recordValue(record?.job);
  const data = recordValue(record?.data);
  const dataJob = recordValue(data?.job);
  return (
    stringField(job, "job_id") ??
    stringField(job, "jobId") ??
    stringField(record, "job_id") ??
    stringField(record, "jobId") ??
    stringField(dataJob, "job_id") ??
    stringField(dataJob, "jobId")
  );
};

const normalizedStatus = (value: unknown): string =>
  String(recordValue(value)?.status ?? "").trim().toLowerCase();

const isTerminalJobStatus = (value: unknown): boolean =>
  [
    "completed",
    "succeeded",
    "failed",
    "error",
    "cancelled",
    "canceled",
    "dead_lettered",
  ].includes(normalizedStatus(value));

const isSuccessfulJobStatus = (value: unknown): boolean =>
  ["completed", "succeeded"].includes(normalizedStatus(value));

const compactRecord = (
  value: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );

const arrayValue = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const firstString = (
  record: Record<string, unknown> | undefined,
  fields: string[],
): string | undefined => {
  for (const field of fields) {
    const value = record?.[field];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
};

const publicValidationText = (value?: string): string | undefined =>
  value
    ?.replace(/\bPSRule(?:\s+for\s+Azure)?\b/gi, "validation rules")
    .replace(/\bARM\s+TTK\b/gi, "template validation");

const sanitizeTemplateOperationText = (value: unknown): unknown => {
  if (typeof value === "string") {
    return publicValidationText(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeTemplateOperationText);
  }
  const record = recordValue(value);
  if (record) {
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [
        key,
        sanitizeTemplateOperationText(item),
      ]),
    );
  }
  return value;
};

const firstNumber = (
  record: Record<string, unknown> | undefined,
  fields: string[],
): number | undefined => {
  for (const field of fields) {
    const value = record?.[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
};

const firstArray = (
  record: Record<string, unknown> | undefined,
  fields: string[],
): unknown[] => {
  for (const field of fields) {
    const value = record?.[field];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
};

const normalizeProgressItem = (value: unknown): TemplateProgressItem => {
  const record = recordValue(value) ?? {};
  const passed = typeof record.passed === "boolean" ? record.passed : undefined;
  return compactRecord({
    name: firstString(record, [
      "name",
      "test_name",
      "testName",
      "rule_name",
      "ruleName",
      "item",
      "current_item",
      "display_name",
      "displayName",
    ]),
    status:
      firstString(record, ["status", "outcome", "result"]) ??
      (passed === undefined ? undefined : passed ? "Pass" : "Fail"),
    passed,
    category: firstString(record, ["category", "test_category", "testCategory"]),
    severity: firstString(record, ["severity", "level"]),
    message: publicValidationText(firstString(record, ["message", "description"])),
    recommendation: publicValidationText(
      firstString(record, ["recommendation", "remediation"]),
    ),
    location: firstString(record, ["file_path", "filePath", "location"]),
    durationMs: firstNumber(record, ["duration_ms", "durationMs"]),
    documentationUrl: firstString(record, [
      "documentation_url",
      "documentationUrl",
      "help_url",
      "helpUrl",
    ]),
  }) as TemplateProgressItem;
};

const operationFromResult = (result: unknown): string | undefined => {
  const record = recordValue(result);
  if (!record) {
    return undefined;
  }
  if ("test_results" in record || "total_tests" in record) {
    return "template_test";
  }
  if ("filtered_results" in record || "results" in record || "summary" in record) {
    return "template_validate";
  }
  return undefined;
};

const progressEventFromStatus = (input: {
  phase: "submitted" | "status";
  jobId: string;
  status?: unknown;
  elapsedMs: number;
}): TemplateProgressEvent => {
  const statusRecord = recordValue(input.status);
  return compactRecord({
    phase: input.phase,
    jobId: input.jobId,
    operation: firstString(statusRecord, ["operation", "operation_type", "operationType"]),
    status: firstString(statusRecord, ["status", "state"]),
    progress: firstNumber(statusRecord, [
      "progress",
      "progress_percent",
      "progressPercent",
      "percentage",
      "percent",
    ]),
    completed: firstNumber(statusRecord, [
      "completed_items",
      "completedItems",
      "completed_tests",
      "completedTests",
      "completed_rules",
      "completedRules",
    ]),
    total: firstNumber(statusRecord, [
      "total_items",
      "totalItems",
      "total_tests",
      "totalTests",
      "total_rules",
      "totalRules",
    ]),
    currentItem: firstString(statusRecord, [
      "current_item",
      "currentItem",
      "current_test",
      "currentTest",
      "current_rule",
      "currentRule",
    ]),
    message: publicValidationText(
      firstString(statusRecord, ["message", "detail", "description"]),
    ),
    items: firstArray(statusRecord, [
      "recent_events",
      "recentEvents",
      "events",
      "progress_events",
      "progressEvents",
    ])
      .map(normalizeProgressItem)
      .filter((item) => item.name || item.message),
    elapsedMs: input.elapsedMs,
  }) as TemplateProgressEvent;
};

const failedStatus = (status?: string): boolean =>
  ["fail", "failed", "error"].includes(String(status ?? "").trim().toLowerCase());

const passedStatus = (status?: string): boolean =>
  ["pass", "passed", "success", "succeeded"].includes(
    String(status ?? "").trim().toLowerCase(),
  );

const progressItemsFromDetails = (
  details: Array<Record<string, unknown>>,
  nameFields: string[],
): TemplateProgressItem[] => {
  const targetLocation = (
    target: Record<string, unknown> | undefined,
  ): string | undefined => {
    const name = firstString(target, ["name", "id"]);
    const type = firstString(target, ["type"]);
    if (name && type) {
      return `${name} (${type})`;
    }
    return name ?? type;
  };

  return details
    .filter((detail) => failedStatus(firstString(detail, ["status", "outcome", "result"])))
    .map((detail) => {
      const evidence = recordValue(detail.evidence);
      return compactRecord({
        name: firstString(detail, nameFields),
        status: firstString(detail, ["status", "outcome", "result"]),
        category: firstString(detail, ["category", "test_category", "testCategory"]),
        severity: firstString(detail, ["severity", "level"]),
        message:
          publicValidationText(
            firstString(detail, ["message", "description"]) ??
              firstString(evidence, ["description", "synopsis"]),
          ),
        recommendation:
          publicValidationText(
            firstString(detail, ["recommendation", "remediation"]) ??
              firstString(evidence, ["recommendation", "remediation"]),
          ),
        location:
          firstString(detail, ["file_path", "filePath", "location"]) ??
          targetLocation(recordValue(detail.target)),
        durationMs: firstNumber(detail, ["duration_ms", "durationMs"]),
        documentationUrl:
          firstString(detail, [
            "documentation_url",
            "documentationUrl",
            "help_url",
            "helpUrl",
          ]) ??
          firstString(evidence, [
            "documentation_url",
            "documentationUrl",
            "help_url",
            "helpUrl",
          ]),
      }) as TemplateProgressItem;
    })
    .filter((item) => item.name || item.message);
};

const resultProgressSummary = (
  result: unknown,
  operation?: string,
): Pick<TemplateProgressEvent, "operation" | "message" | "items" | "progress"> => {
  const resultRecord = recordValue(result) ?? {};
  const summary = recordValue(resultRecord.summary) ?? {};
  const detectedOperation = operationFromResult(result);
  const resolvedOperation = detectedOperation ?? operation;
  const operationText = String(resolvedOperation ?? "").toLowerCase();

  if (detectedOperation === "template_test" || operationText.includes("test")) {
    const details = normalizeTemplateTestDetails(result);
    const passed = firstNumber(resultRecord, ["passed_tests", "passedTests"]) ??
      details.filter((detail) => detail.passed === true || passedStatus(firstString(detail, ["status"]))).length;
    const failed = firstNumber(resultRecord, ["failed_tests", "failedTests"]) ??
      details.filter((detail) => detail.passed === false || failedStatus(firstString(detail, ["status"]))).length;
    const skipped = firstNumber(resultRecord, ["skipped_tests", "skippedTests"]) ?? 0;
    return {
      operation: resolvedOperation,
      progress: 100,
      message: `Template tests complete: ${passed} passed, ${failed} failed, ${skipped} skipped`,
      items: progressItemsFromDetails(details, ["test_name", "testName", "name"]),
    };
  }

  const details = normalizeTemplateValidationDetails(result);
  const passed = firstNumber(summary, ["passed_rules", "passedRules"]) ??
    details.filter((detail) => passedStatus(firstString(detail, ["status"]))).length;
  const failed = firstNumber(summary, ["failed_rules", "failedRules"]) ??
    details.filter((detail) => failedStatus(firstString(detail, ["status"]))).length;
  const total = firstNumber(summary, ["total_rules", "totalRules"]) ?? details.length;
  return {
    operation: resolvedOperation ?? "template_validate",
    progress: 100,
    message: `Validation complete: ${passed} passed, ${failed} failed across ${total} checks`,
    items: progressItemsFromDetails(details, ["rule_id", "rule_name", "ruleName", "name"]),
  };
};

export const formatTemplateProgressEvent = (
  event: TemplateProgressEvent,
  command: string,
): string[] => {
  const appendItemDetails = (
    lines: string[],
    item: TemplateProgressItem,
  ): void => {
    const metadata = [
      item.category ? `category: ${item.category}` : undefined,
      item.severity ? `severity: ${item.severity}` : undefined,
      item.location ? `location: ${item.location}` : undefined,
      typeof item.durationMs === "number" ? `duration: ${item.durationMs}ms` : undefined,
    ].filter(Boolean);
    if (metadata.length) {
      lines.push(`    ${metadata.join(" | ")}`);
    }
    if (item.name && item.message) {
      lines.push(`    message: ${item.message}`);
    }
    if (item.recommendation) {
      lines.push(`    recommendation: ${item.recommendation}`);
    }
    if (item.documentationUrl) {
      lines.push(`    docs: ${item.documentationUrl}`);
    }
  };

  if (event.phase === "submitted") {
    return [`${command} job ${event.jobId} submitted`];
  }
  if (event.phase === "result") {
    const lines = event.message ? [event.message] : [`${command} job ${event.jobId} complete`];
    for (const item of event.items ?? []) {
      const status = item.status ? `${item.status} ` : "";
      lines.push(`  - ${status}${item.name ?? item.message ?? "item"}`);
      appendItemDetails(lines, item);
    }
    return lines;
  }

  const status = event.status ? event.status.toUpperCase() : "RUNNING";
  const progress =
    typeof event.progress === "number" ? ` ${Math.round(event.progress)}%` : "";
  const completed =
    typeof event.completed === "number" && typeof event.total === "number"
      ? ` (${event.completed}/${event.total})`
      : "";
  const current = event.currentItem ? ` current: ${event.currentItem}` : "";
  const message = event.message ? ` ${event.message}` : "";
  const lines = [
    `${command} job ${event.jobId}: ${status}${progress}${completed}${current}${message}`,
  ];
  for (const item of event.items ?? []) {
    const statusText = item.status ? `${item.status} ` : "";
    const passedText =
      item.status || item.passed === undefined
        ? ""
        : item.passed
          ? "Pass "
          : "Fail ";
    lines.push(`  - ${statusText}${passedText}${item.name ?? item.message ?? "item"}`);
    appendItemDetails(lines, item);
  }
  return lines;
};

export const templateProgressEventKey = (
  event: TemplateProgressEvent,
): string =>
  JSON.stringify({
    phase: event.phase,
    operation: event.operation,
    status: event.status,
    progress: event.progress,
    completed: event.completed,
    total: event.total,
    currentItem: event.currentItem,
    message: event.message,
    items: event.items,
  });

export const unwrapTemplateOperationResult = (value: unknown): unknown => {
  const record = recordValue(value);
  if (!record) {
    return value;
  }
  const result = recordValue(record.result);
  if (!result) {
    return value;
  }
  const nestedResult = recordValue(result.result);
  if (nestedResult) {
    return sanitizeTemplateOperationText(nestedResult);
  }
  return sanitizeTemplateOperationText(result);
};

const resolvedOperationResult = (
  value: unknown,
): Record<string, unknown> | undefined => recordValue(unwrapTemplateOperationResult(value));

const validationResults = (result: Record<string, unknown>): unknown[] => {
  const directResults = arrayValue(result.results);
  if (directResults.length) {
    return directResults;
  }
  const filteredResults = recordValue(result.filtered_results);
  return arrayValue(filteredResults?.results);
};

export const normalizeTemplateValidationDetails = (
  result: unknown,
): Array<Record<string, unknown>> =>
  validationResults(recordValue(result) ?? {}).map((item) => {
    const row = recordValue(item) ?? {};
    const info = recordValue(row.info);
    const ruleName = firstString(row, ["rule_name", "ruleName", "rule", "id"]);
    const outcome = firstString(row, ["outcome", "status", "result"]);
    const target = compactRecord({
      name: firstString(row, ["target_name", "targetName", "resource_name", "resourceName"]),
      type: firstString(row, ["target_type", "targetType", "resource_type", "resourceType"]),
      id: firstString(row, ["target_id", "targetId", "resource_id", "resourceId"]),
    });
    return compactRecord({
      source: "template_rules",
      rule_id: ruleName,
      rule_name: ruleName,
      display_name: firstString(row, ["display_name", "displayName"]) ??
        firstString(info, ["display_name", "displayName"]),
      status: outcome,
      severity: firstString(row, ["severity", "level"]),
      category: firstString(row, ["category"]),
      pillar: firstString(row, ["pillar"]),
      ...(Object.keys(target).length ? { target } : {}),
      evidence: compactRecord({
        description: publicValidationText(
          firstString(row, ["description", "message"]) ??
            firstString(info, ["description"]),
        ),
        synopsis: publicValidationText(
          firstString(row, ["synopsis"]) ?? firstString(info, ["synopsis"]),
        ),
        recommendation: publicValidationText(
          firstString(row, ["recommendation", "remediation"]),
        ),
        documentation_url: firstString(row, [
          "documentation_url",
          "documentationUrl",
          "help_url",
          "helpUrl",
        ]),
      }),
    });
  });

export const withTemplateValidationDetails = (value: unknown): unknown => {
  const result = resolvedOperationResult(value);
  if (!result) {
    return value;
  }
  const original = recordValue(value);
  const jobFields =
    original && ("jobId" in original || "status" in original)
      ? compactRecord({
          submitted: original.submitted,
          jobId: original.jobId,
          status: original.status,
        })
      : {};
  return compactRecord({
    ...jobFields,
    ...result,
    details: normalizeTemplateValidationDetails(result),
  });
};

export const normalizeTemplateTestDetails = (
  result: unknown,
): Array<Record<string, unknown>> =>
  arrayValue(recordValue(result)?.test_results).map((item) => {
    const row = recordValue(item) ?? {};
    const passed = typeof row.passed === "boolean" ? row.passed : undefined;
    return compactRecord({
      source: "template_tests",
      test_name: firstString(row, ["test_name", "testName", "name"]),
      category: firstString(row, ["test_category", "testCategory", "category"]),
      status: passed === undefined ? firstString(row, ["status"]) : passed ? "Pass" : "Fail",
      passed,
      severity: firstString(row, ["severity", "level"]),
      message: publicValidationText(firstString(row, ["message", "description"])),
      recommendation: publicValidationText(
        firstString(row, ["recommendation", "remediation"]),
      ),
      duration_ms:
        typeof row.duration_ms === "number"
          ? row.duration_ms
          : typeof row.durationMs === "number"
            ? row.durationMs
            : undefined,
      file_path: firstString(row, ["file_path", "filePath"]),
    });
  });

export const withTemplateTestDetails = (value: unknown): unknown => {
  const result = resolvedOperationResult(value);
  if (!result) {
    return value;
  }
  const original = recordValue(value);
  const jobFields =
    original && ("jobId" in original || "status" in original)
      ? compactRecord({
          submitted: original.submitted,
          jobId: original.jobId,
          status: original.status,
        })
      : {};
  return compactRecord({
    ...jobFields,
    ...result,
    summary: compactRecord({
      total_tests: result.total_tests,
      passed_tests: result.passed_tests,
      failed_tests: result.failed_tests,
      skipped_tests: result.skipped_tests,
    }),
    details: normalizeTemplateTestDetails(result),
  });
};

export const getTemplateValidationJobStatus = async (
  input: AuthenticatedTemplateRequest & { jobId: string },
): Promise<unknown> =>
  fetchCloudEvalJson({
    baseUrl: input.baseUrl,
    authToken: input.authToken,
    path: `/jobs/${encodeURIComponent(input.jobId)}`,
    query: { user_id: input.userId },
  });

export const getTemplateValidationJobResult = async (
  input: AuthenticatedTemplateRequest & { jobId: string },
): Promise<unknown> =>
  fetchCloudEvalJson({
    baseUrl: input.baseUrl,
    authToken: input.authToken,
    path: `/jobs/${encodeURIComponent(input.jobId)}/result`,
    query: { user_id: input.userId },
  });

export const waitForTemplateValidationResult = async (
  input: AuthenticatedTemplateRequest & {
    submitted: unknown;
    pollIntervalMs?: number;
    waitTimeoutMs?: number;
    onProgress?: (event: TemplateProgressEvent) => void | Promise<void>;
  },
): Promise<unknown> => {
  const jobId = extractJobId(input.submitted);
  if (!jobId) {
    return input.submitted;
  }

  const waitTimeoutMs = Math.max(1, input.waitTimeoutMs ?? 600_000);
  const pollIntervalMs = Math.max(500, input.pollIntervalMs ?? 2500);
  const deadline = Date.now() + waitTimeoutMs;
  const startedAt = Date.now();
  const elapsedMs = () => Date.now() - startedAt;
  await input.onProgress?.(
    progressEventFromStatus({
      phase: "submitted",
      jobId,
      status: input.submitted,
      elapsedMs: elapsedMs(),
    }),
  );
  let status: unknown;
  for (;;) {
    status = await getTemplateValidationJobStatus({ ...input, jobId });
    await input.onProgress?.(
      progressEventFromStatus({
        phase: "status",
        jobId,
        status,
        elapsedMs: elapsedMs(),
      }),
    );
    if (isTerminalJobStatus(status)) {
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Template validation job ${jobId} did not finish within ${waitTimeoutMs}ms.`,
      );
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }

  if (!isSuccessfulJobStatus(status)) {
    throw new Error(
      `Template validation job ${jobId} ended with status ${normalizedStatus(status) || "unknown"}.`,
    );
  }

  const result = unwrapTemplateOperationResult(
    await getTemplateValidationJobResult({ ...input, jobId }),
  );
  const statusEvent = progressEventFromStatus({
    phase: "status",
    jobId,
    status,
    elapsedMs: elapsedMs(),
  });
  await input.onProgress?.(
    compactRecord({
      ...statusEvent,
      phase: "result",
      ...resultProgressSummary(result, statusEvent.operation),
      elapsedMs: elapsedMs(),
    }) as TemplateProgressEvent,
  );

  return {
    submitted: input.submitted,
    jobId,
    status,
    result,
  } satisfies TemplateValidationWaitResult;
};

const templateTestRequestBody = async (
  files: TemplateFileInput,
  options: TemplateTestOptions,
): Promise<Record<string, unknown>> => {
  const { template, parameterFile } = await readTemplateFiles(files);
  return {
    template,
    ...(parameterFile === undefined ? {} : { parameter_file: parameterFile }),
    ...(options.testCategories?.length
      ? { test_categories: options.testCategories }
      : {}),
    ...(options.specificTests?.length
      ? { specific_tests: options.specificTests }
      : {}),
    ...(options.skipTests?.length ? { skip_tests: options.skipTests } : {}),
    ...(options.includeTests?.length
      ? { include_tests: options.includeTests }
      : {}),
    ...(options.testGroups?.length ? { test_groups: options.testGroups } : {}),
    ...(options.verboseOutput ? { verbose_output: true } : {}),
  };
};

export const testTemplate = async (
  input: AuthenticatedTemplateRequest & TemplateFileInput & TemplateTestOptions,
): Promise<unknown> =>
  fetchCloudEvalJson({
    baseUrl: input.baseUrl,
    authToken: input.authToken,
    path: "/arm-template/test",
    method: "POST",
    query: { user_id: input.userId },
    body: await templateTestRequestBody(input, input),
  });

export const parseTemplate = async (
  input: AuthenticatedTemplateRequest &
    TemplateFileInput & {
      location?: string;
      returnAll?: boolean;
    },
): Promise<unknown> => {
  const { template, parameterFile } = await readTemplateFiles(input);
  return fetchCloudEvalJson({
    baseUrl: input.baseUrl,
    authToken: input.authToken,
    path: "/arm-template/parse",
    method: "POST",
    query: { user_id: input.userId },
    body: {
      template,
      ...(parameterFile === undefined ? {} : { parameter_file: parameterFile }),
      ...(input.location ? { location: input.location } : {}),
      return_all: input.returnAll ?? true,
    },
  });
};

export const getRuleCategories = async (input: {
  baseUrl: string;
  authToken?: string;
}): Promise<unknown> =>
  fetchCloudEvalJson({
    baseUrl: input.baseUrl,
    authToken: input.authToken,
    path: "/rule/rules/categories",
  });

export const searchRules = async (input: {
  baseUrl: string;
  authToken?: string;
  query: string;
  category?: string;
  pillar?: string;
}): Promise<unknown> =>
  fetchCloudEvalJson({
    baseUrl: input.baseUrl,
    authToken: input.authToken,
    path: "/rule/rules/search",
    query: {
      query: input.query,
      category: input.category,
      pillar: input.pillar,
    },
  });

export const getRule = async (input: {
  baseUrl: string;
  authToken?: string;
  ruleId: string;
}): Promise<unknown> =>
  fetchCloudEvalJson({
    baseUrl: input.baseUrl,
    authToken: input.authToken,
    path: `/rule/rules/${encodeURIComponent(input.ruleId)}`,
  });

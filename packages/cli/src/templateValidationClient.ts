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
    return nestedResult;
  }
  return result;
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
        description: firstString(row, ["description", "message"]) ??
          firstString(info, ["description"]),
        synopsis: firstString(row, ["synopsis"]) ?? firstString(info, ["synopsis"]),
        recommendation: firstString(row, ["recommendation", "remediation"]),
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
      message: firstString(row, ["message", "description"]),
      recommendation: firstString(row, ["recommendation", "remediation"]),
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
  },
): Promise<unknown> => {
  const jobId = extractJobId(input.submitted);
  if (!jobId) {
    return input.submitted;
  }

  const waitTimeoutMs = Math.max(1, input.waitTimeoutMs ?? 600_000);
  const pollIntervalMs = Math.max(500, input.pollIntervalMs ?? 2500);
  const deadline = Date.now() + waitTimeoutMs;
  let status: unknown;
  for (;;) {
    status = await getTemplateValidationJobStatus({ ...input, jobId });
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

  return {
    submitted: input.submitted,
    jobId,
    status,
    result: unwrapTemplateOperationResult(
      await getTemplateValidationJobResult({ ...input, jobId }),
    ),
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

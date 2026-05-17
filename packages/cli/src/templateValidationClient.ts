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
    result: await getTemplateValidationJobResult({ ...input, jobId }),
  } satisfies TemplateValidationWaitResult;
};

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

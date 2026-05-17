import fs from "node:fs/promises";
import { fetchCloudEvalJson } from "./apiClient.js";

export type TemplateFileInput = {
  templatePath: string;
  parametersPath?: string;
};

export type ValidationOptions = {
  failedOnly?: boolean;
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

export type ReportKind = "cost" | "waf";
export type ReportFormatMode = "raw" | "parsed" | "formatted";
export type ReportOutputFormat = "tui" | "summary" | "json" | "ndjson" | "markdown";

export interface ReportFormattedSection {
  id: string;
  title: string;
  markdown: string;
}

export interface ReportFormattedContent {
  title: string;
  summary: string;
  sections: ReportFormattedSection[];
}

export interface ReportEnvelope<TRaw = unknown, TParsed = unknown> {
  id: string;
  kind: ReportKind;
  projectId: string;
  generatedAt: string;
  period?: { start: string; end: string };
  source: {
    provider: "azure" | "aws" | "gcp" | "unknown";
    backendVersion?: string;
    evidenceRefs?: string[];
  };
  raw: TRaw;
  parsed: TParsed;
  formatted?: ReportFormattedContent;
}

export interface MoneyAmount {
  amount: number;
  currency: string;
}

export interface CostGroup {
  name: string;
  amount: number;
  currency: string;
  changePercent?: number;
}

export interface CostRecommendation {
  id: string;
  title: string;
  monthlySavings: number;
  currency: string;
  risk: "low" | "medium" | "high" | "policy" | "commit";
  service?: string;
}

export interface CostAnomaly {
  id: string;
  service: string;
  date: string;
  amount: number;
  expectedAmount: number;
  currency: string;
}

export interface CostBudget {
  name: string;
  usedPercent: number;
  status: "ok" | "near_limit" | "over";
}

export interface CostParsedReport {
  totalSpend: MoneyAmount & { changePercent?: number };
  estimatedSavings: MoneyAmount & { percentOfSpend?: number };
  serviceGroups: CostGroup[];
  recommendations: CostRecommendation[];
  anomalies: CostAnomaly[];
  budgets: CostBudget[];
  trend: Array<{ date: string; amount: number; currency: string }>;
}

export interface WafPillarScore {
  id: string;
  label: string;
  score: number;
  passed: number;
  warned: number;
  failed: number;
}

export interface WafRuleResult {
  id: string;
  pillar: string;
  title: string;
  status: "pass" | "warn" | "fail";
  severity: "low" | "medium" | "high" | "critical";
  resource?: string;
  evidence?: string;
  recommendation?: string;
}

export interface WafParsedReport {
  score: {
    overall: number;
    pillars: WafPillarScore[];
  };
  counts: {
    passed: number;
    highRisk: number;
    mediumRisk: number;
    evidenceCoveragePercent: number;
  };
  rules: WafRuleResult[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringOr = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim() ? value : fallback;

const normalizeProvider = (
  value: unknown
): ReportEnvelope["source"]["provider"] => {
  if (value === "azure" || value === "aws" || value === "gcp") {
    return value;
  }
  return "unknown";
};

const normalizeSections = (value: unknown): ReportFormattedSection[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((section, index) => {
      if (!isObject(section)) {
        return undefined;
      }
      return {
        id: stringOr(section.id, `section-${index + 1}`),
        title: stringOr(section.title, `Section ${index + 1}`),
        markdown: stringOr(section.markdown, ""),
      };
    })
    .filter((section): section is ReportFormattedSection => Boolean(section));
};

export const normalizeReportEnvelope = (
  input: unknown
): ReportEnvelope => {
  const rawInput = isObject(input) && isObject(input.report) ? input.report : input;
  if (!isObject(rawInput)) {
    throw new Error("Report response must be an object.");
  }

  const source = isObject(rawInput.source) ? rawInput.source : {};
  const formatted = isObject(rawInput.formatted) ? rawInput.formatted : undefined;
  const period = isObject(rawInput.period)
    ? {
        start: stringOr(rawInput.period.start, ""),
        end: stringOr(rawInput.period.end, ""),
      }
    : undefined;

  return {
    id: stringOr(rawInput.id, "unknown-report"),
    kind: rawInput.kind === "waf" ? "waf" : "cost",
    projectId: stringOr(rawInput.projectId ?? rawInput.project_id, "unknown-project"),
    generatedAt: stringOr(
      rawInput.generatedAt ?? rawInput.generated_at,
      new Date(0).toISOString()
    ),
    period,
    source: {
      provider: normalizeProvider(source.provider ?? rawInput.provider),
      backendVersion:
        typeof source.backendVersion === "string"
          ? source.backendVersion
          : typeof source.backend_version === "string"
            ? source.backend_version
            : undefined,
      evidenceRefs: Array.isArray(source.evidenceRefs)
        ? source.evidenceRefs.filter((ref): ref is string => typeof ref === "string")
        : Array.isArray(source.evidence_refs)
          ? source.evidence_refs.filter((ref): ref is string => typeof ref === "string")
          : undefined,
    },
    raw: rawInput.raw ?? {},
    parsed: rawInput.parsed ?? {},
    formatted: formatted
      ? {
          title: stringOr(formatted.title, "Report"),
          summary: stringOr(formatted.summary, ""),
          sections: normalizeSections(formatted.sections),
        }
      : undefined,
  };
};

export const normalizeReportList = (input: unknown): ReportEnvelope[] => {
  const list = Array.isArray(input)
    ? input
    : isObject(input) && Array.isArray(input.reports)
      ? input.reports
      : isObject(input) && Array.isArray(input.data)
        ? input.data
        : isObject(input) && Array.isArray(input.items)
          ? input.items
          : [];

  return list.map((item) => normalizeReportEnvelope(item));
};

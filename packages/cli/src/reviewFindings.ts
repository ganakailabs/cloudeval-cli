export type ReviewFindingLevel = "failure" | "warning" | "notice";

export type ReviewFinding = {
  id: string;
  kind: "unit_test" | "policy_check" | "well_architected";
  title: string;
  message: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  level: ReviewFindingLevel;
  severity?: string;
};

export type GitHubCheckAnnotation = {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: ReviewFindingLevel;
  message: string;
  title?: string;
  raw_details?: string;
};

export type ReviewGithubConfig = {
  checks: {
    enabled: boolean;
    annotationLimit: number;
    changedFilesOnly: boolean;
    includeNotices: boolean;
    name: string;
  };
  sarif: {
    enabled: boolean;
    category: string;
    upload: boolean;
    failOnUploadError: boolean;
  };
};

const asRecord = (value: unknown): Record<string, any> =>
  value && typeof value === "object" ? (value as Record<string, any>) : {};

const numberFrom = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
};

const compactText = (value: unknown, fallback = ""): string => {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
  return text || fallback;
};

const normalizePath = (
  value: unknown,
  sourceRoot?: string,
  changedPaths?: Set<string>,
): string | undefined => {
  const raw = compactText(value)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^repo\//, "");
  if (!raw || raw === "-") return undefined;
  if (/^\.cloudeval\/(bundles|connections|template-cache|snapshots|ps-rule\.yaml)/.test(raw)) {
    return undefined;
  }
  if (changedPaths?.has(raw)) return raw;
  const root = compactText(sourceRoot).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (root && !raw.startsWith(`${root}/`)) {
    const withRoot = `${root}/${raw}`;
    if (!changedPaths || changedPaths.has(withRoot)) {
      return withRoot;
    }
  }
  return raw;
};

const severityLevel = (record: Record<string, any>): ReviewFindingLevel => {
  const value = String(
    record.annotation_level ??
      record.level ??
      record.severity ??
      record.status ??
      record.outcome ??
      "",
  ).toLowerCase();
  if (["critical", "error", "high", "fail", "failed", "failure"].includes(value)) {
    return "failure";
  }
  if (["warning", "warn", "medium"].includes(value)) {
    return "warning";
  }
  return "notice";
};

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "finding";

const failureName = (record: Record<string, any>, fallback: string): string =>
  compactText(
    record.test_name ??
      record.testName ??
      record.rule_name ??
      record.ruleName ??
      record.title ??
      record.name ??
      record.id,
    fallback,
  );

const failurePath = (record: Record<string, any>): unknown =>
  record.file_path ??
  record.filePath ??
  record.path ??
  record.source_file ??
  record.sourceFile ??
  asRecord(record.location).path ??
  record.target;

const failureLine = (record: Record<string, any>): number | undefined =>
  numberFrom(
    record.line,
    record.line_number,
    record.lineNumber,
    record.start_line,
    record.startLine,
    asRecord(record.location).line,
  );

const failureMessage = (record: Record<string, any>): string => {
  const message = compactText(
    record.message ?? record.reason ?? record.description ?? record.details,
    "",
  );
  const recommendation = compactText(
    record.recommendation ?? record.remediation ?? record.fix ?? record.next_step,
    "",
  );
  if (message && recommendation && message !== recommendation) {
    return `${message} ${recommendation}`;
  }
  return message || recommendation || "Cloudeval reported this finding without a detailed message.";
};

const fromFailures = ({
  kind,
  records,
  sourceRoot,
  changedPaths,
  fallbackPrefix,
}: {
  kind: ReviewFinding["kind"];
  records: unknown[];
  sourceRoot?: string;
  changedPaths?: Set<string>;
  fallbackPrefix: string;
}): ReviewFinding[] =>
  records.map((item, index) => {
    const record = asRecord(item);
    const title = failureName(record, `${fallbackPrefix} ${index + 1}`);
    const line = failureLine(record);
    return {
      id: compactText(record.id, `${kind}:${slug(title)}`),
      kind,
      title,
      message: failureMessage(record),
      path: normalizePath(failurePath(record), sourceRoot, changedPaths),
      startLine: line,
      endLine: numberFrom(record.end_line, record.endLine) ?? line,
      level: severityLevel(record),
      severity: compactText(record.severity ?? record.status ?? record.outcome, "failed"),
    };
  });

export const extractReviewFindings = (data: Record<string, any>): ReviewFinding[] => {
  const sourceRoot = compactText(data.sourceRoot ?? data.source_root, "");
  const changedPaths = new Set(
    (Array.isArray(data.changedFiles) ? data.changedFiles : [])
      .map((file) => compactText(asRecord(file).path))
      .filter(Boolean),
  );
  const validation = asRecord(data.gate?.validation);
  const wellArchitected = asRecord(data.gate?.wellArchitected);
  const unitFailures = Array.isArray(validation.unitTests?.failures)
    ? validation.unitTests.failures
    : [];
  const policyFailures = Array.isArray(validation.policyChecks?.failures)
    ? validation.policyChecks.failures
    : [];
  const topFindings = Array.isArray(wellArchitected.topFindings)
    ? wellArchitected.topFindings
    : [];

  return [
    ...fromFailures({
      kind: "unit_test",
      records: unitFailures,
      sourceRoot,
      changedPaths,
      fallbackPrefix: "Unit test",
    }),
    ...fromFailures({
      kind: "policy_check",
      records: policyFailures,
      sourceRoot,
      changedPaths,
      fallbackPrefix: "Policy check",
    }),
    ...fromFailures({
      kind: "well_architected",
      records: topFindings,
      sourceRoot,
      changedPaths,
      fallbackPrefix: "Architecture finding",
    }),
  ];
};

const yamlBlock = (configText: string | undefined, pathKeys: string[]): string | undefined => {
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
    if (found === -1) return undefined;
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

const scalar = (block: string | undefined, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const match = block?.match(
      new RegExp(`^\\s*${key}\\s*:\\s*["']?([^"'\\n#]+)["']?\\s*(?:#.*)?$`, "m"),
    );
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return undefined;
};

const boolValue = (block: string | undefined, ...keys: string[]): boolean | undefined => {
  const value = scalar(block, ...keys);
  if (value === undefined) return undefined;
  if (/^(true|yes|on|1)$/i.test(value)) return true;
  if (/^(false|no|off|0)$/i.test(value)) return false;
  return undefined;
};

const numberValue = (block: string | undefined, ...keys: string[]): number | undefined => {
  const value = scalar(block, ...keys);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

export const parseReviewGithubConfig = (configText?: string): ReviewGithubConfig => {
  const checks = yamlBlock(configText, ["ci", "review", "github", "checks"]);
  const sarif = yamlBlock(configText, ["ci", "review", "github", "sarif"]);
  return {
    checks: {
      enabled: boolValue(checks, "enabled") ?? false,
      annotationLimit: numberValue(checks, "annotation_limit", "annotationLimit") ?? 50,
      changedFilesOnly: boolValue(checks, "changed_files_only", "changedFilesOnly") ?? true,
      includeNotices: boolValue(checks, "include_notices", "includeNotices") ?? false,
      name: scalar(checks, "name") ?? "Cloudeval",
    },
    sarif: {
      enabled: boolValue(sarif, "enabled") ?? false,
      category: scalar(sarif, "category") ?? "cloudeval-iac",
      upload: boolValue(sarif, "upload") ?? false,
      failOnUploadError:
        boolValue(sarif, "fail_on_upload_error", "failOnUploadError") ?? false,
    },
  };
};

export const buildReviewAnnotations = (
  data: Record<string, any>,
  options: {
    changedFilesOnly: boolean;
    includeNotices: boolean;
    annotationLimit: number;
  },
): GitHubCheckAnnotation[] => {
  const changedPaths = new Set(
    (Array.isArray(data.changedFiles) ? data.changedFiles : [])
      .map((file) => compactText(asRecord(file).path))
      .filter(Boolean),
  );
  return extractReviewFindings(data)
    .filter((finding) => finding.path)
    .filter((finding) => options.includeNotices || finding.level !== "notice")
    .filter(
      (finding) =>
        !options.changedFilesOnly ||
        changedPaths.size === 0 ||
        changedPaths.has(String(finding.path)),
    )
    .slice(0, Math.max(0, options.annotationLimit))
    .map((finding) => ({
      path: String(finding.path),
      start_line: Math.max(1, Math.floor(finding.startLine ?? 1)),
      end_line: Math.max(1, Math.floor(finding.endLine ?? finding.startLine ?? 1)),
      annotation_level: finding.level,
      message: finding.message.slice(0, 60_000),
      title: finding.title.slice(0, 250),
      raw_details: `${finding.kind}${finding.severity ? ` · ${finding.severity}` : ""}`,
    }));
};

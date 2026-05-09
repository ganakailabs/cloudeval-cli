export type MachineOutputFormat = "text" | "json" | "ndjson" | "markdown";

let showSensitiveIdsByDefault = false;

const SENSITIVE_IDENTIFIER_KEYS = new Set([
  "accountid",
  "sessionid",
  "tenantid",
]);

const SENSITIVE_URL_PARAM_PATTERN =
  /([?&](?:account_id|accountId|session_id|sessionId|tenant_id|tenantId)=)([^&#\s]+)/gi;

export const setShowSensitiveIds = (enabled: boolean) => {
  showSensitiveIdsByDefault = enabled;
};

export const shouldShowSensitiveIds = (): boolean => showSensitiveIdsByDefault;

const normalizeSensitiveKey = (key: string): string =>
  key.toLowerCase().replace(/[^a-z0-9]/g, "");

const isSensitiveIdentifierKey = (key: string): boolean =>
  SENSITIVE_IDENTIFIER_KEYS.has(normalizeSensitiveKey(key));

export const redactSensitiveIdentifier = (value: unknown): string => {
  const text = String(value ?? "");
  if (!text) {
    return "";
  }
  if (text.length <= 8) {
    return "[redacted]";
  }
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
};

const redactSensitiveUrlParams = (value: string): string =>
  value.replace(
    SENSITIVE_URL_PARAM_PATTERN,
    (_match, prefix: string, rawValue: string) =>
      `${prefix}${redactSensitiveIdentifier(rawValue)}`
  );

export const redactSensitiveIds = <T>(
  value: T,
  options: { showSensitiveIds?: boolean } = {}
): T => {
  const showSensitiveIds = options.showSensitiveIds ?? showSensitiveIdsByDefault;
  if (showSensitiveIds) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveIds(item, options)) as T;
  }
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveIdentifierKey(key)) {
        redacted[key] =
          item === null || item === undefined
            ? item
            : redactSensitiveIdentifier(item);
      } else {
        redacted[key] = redactSensitiveIds(item, options);
      }
    }
    return redacted as T;
  }
  if (typeof value === "string") {
    return redactSensitiveUrlParams(value) as T;
  }
  return value;
};

export interface SuccessEnvelope<T = unknown> {
  ok: true;
  command: string;
  data: T;
  warnings?: string[];
  frontendUrl?: string;
  filesWritten?: string[];
  traceId?: string;
}

export interface ErrorEnvelope {
  ok: false;
  command: string;
  error: {
    message: string;
    code?: string;
    requestId?: string;
    requiredCapabilities?: string[];
    docsUrl?: string;
  };
}

export const formatSuccessEnvelope = <T>(input: {
  command: string;
  data: T;
  warnings?: string[];
  frontendUrl?: string;
  filesWritten?: string[];
  traceId?: string;
}): SuccessEnvelope<T> => {
  const envelope: SuccessEnvelope<T> = {
    ok: true,
    command: input.command,
    data: input.data,
  };
  if (input.warnings?.length) {
    envelope.warnings = input.warnings;
  }
  if (input.frontendUrl) {
    envelope.frontendUrl = input.frontendUrl;
  }
  if (input.filesWritten?.length) {
    envelope.filesWritten = input.filesWritten;
  }
  if (input.traceId) {
    envelope.traceId = input.traceId;
  }
  return envelope;
};

export const formatErrorEnvelope = (
  command: string,
  error: unknown,
  code?: string
): ErrorEnvelope => {
  const record =
    error && typeof error === "object" ? (error as Record<string, any>) : {};
  return {
    ok: false,
    command,
    error: {
      message: error instanceof Error ? error.message : String(error),
      ...(code || typeof record.code === "string" ? { code: code ?? record.code } : {}),
      ...(typeof record.requestId === "string" ? { requestId: record.requestId } : {}),
      ...(Array.isArray(record.requiredCapabilities)
        ? {
            requiredCapabilities: record.requiredCapabilities.filter(
              (item) => typeof item === "string"
            ),
          }
        : {}),
      ...(typeof record.docsUrl === "string" ? { docsUrl: record.docsUrl } : {}),
    },
  };
};

export interface TextTableColumn<T = Record<string, unknown>> {
  key?: string;
  header: string;
  width?: number;
  maxWidth?: number;
  align?: "left" | "right";
  value?: (row: T) => unknown;
}

export interface TextTableOptions {
  emptyMessage?: string;
  maxColumnWidth?: number;
}

const stringifyScalar = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
};

const normalizeCellText = (value: unknown): string =>
  stringifyScalar(value).replace(/\s+/g, " ").trim();

const truncateCell = (value: string, width: number): string => {
  if (value.length <= width) {
    return value;
  }
  if (width <= 3) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 3)}...`;
};

const padCell = (value: string, width: number, align: "left" | "right" = "left"): string =>
  align === "right" ? value.padStart(width) : value.padEnd(width);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isScalarLike = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

const isNonEmptyRecord = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && Object.keys(value).length > 0;

const titleizeKey = (value: string): string =>
  value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());

const deriveColumns = <T extends Record<string, unknown>>(
  rows: T[]
): Array<TextTableColumn<T>> => {
  const keys: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!keys.includes(key)) {
        keys.push(key);
      }
    }
  }
  return keys.map((key) => ({ key, header: key }));
};

export const formatTextTable = <T extends Record<string, unknown>>(
  rows: T[],
  columns?: Array<TextTableColumn<T>>,
  options: TextTableOptions = {}
): string => {
  if (!rows.length) {
    return options.emptyMessage ? `${options.emptyMessage}\n` : "";
  }

  const resolvedColumns = columns?.length ? columns : deriveColumns(rows);
  if (!resolvedColumns.length) {
    return "";
  }

  const maxColumnWidth = options.maxColumnWidth ?? 32;
  const matrix = rows.map((row) =>
    resolvedColumns.map((column) =>
      normalizeCellText(column.value ? column.value(row) : row[column.key ?? column.header])
    )
  );
  const widths = resolvedColumns.map((column, index) => {
    if (column.width) {
      return column.width;
    }
    const maxValueWidth = Math.max(
      column.header.length,
      ...matrix.map((row) => row[index]?.length ?? 0)
    );
    return Math.min(maxValueWidth, column.maxWidth ?? maxColumnWidth);
  });
  const renderRow = (values: string[], separator = "  ") =>
    values
      .map((value, index) =>
        padCell(
          truncateCell(value, widths[index]),
          widths[index],
          resolvedColumns[index]?.align
        )
      )
      .join(separator)
      .trimEnd();

  return [
    renderRow(resolvedColumns.map((column) => column.header)),
    renderRow(widths.map((width) => "-".repeat(width))),
    ...matrix.map((row) => renderRow(row)),
  ].join("\n") + "\n";
};

const formatKeyValueTable = (entries: Array<[string, unknown]>): string => {
  if (!entries.length) {
    return "";
  }
  return formatTextTable(
    entries.map(([field, value]) => ({
      field,
      value: isScalarLike(value) ? value : stringifyScalar(value),
    })),
    [
      { key: "field", header: "Field" },
      { key: "value", header: "Value", maxWidth: 80 },
    ],
    { maxColumnWidth: 80 }
  );
};

export const formatTextRecord = (data: unknown): string => {
  if (Array.isArray(data)) {
    if (data.every(isRecord)) {
      return formatTextTable(data);
    }
    return formatTextTable(
      data.map((value) => ({ value })),
      [{ key: "value", header: "Value", maxWidth: 80 }],
      { maxColumnWidth: 80 }
    );
  }
  if (typeof data === "object" && data) {
    const entries = Object.entries(data as Record<string, unknown>);
    const tableEntries = entries.filter(
      ([, value]) => Array.isArray(value) && value.every(isRecord)
    );
    const objectEntries = entries.filter(
      ([, value]) => !Array.isArray(value) && isNonEmptyRecord(value)
    );
    const scalarEntries = entries.filter(
      (entry) => !tableEntries.includes(entry) && !objectEntries.includes(entry)
    );

    const sections: string[] = [];
    for (const [key, value] of tableEntries) {
      sections.push(
        `${titleizeKey(key)}\n${formatTextTable(value as Array<Record<string, unknown>>).trimEnd()}`
      );
    }
    const scalarTable = formatKeyValueTable(scalarEntries);
    if (scalarTable) {
      sections.push(scalarTable.trimEnd());
    }
    for (const [key, value] of objectEntries) {
      const rendered = formatTextRecord(value).trimEnd();
      if (rendered) {
        sections.push(`${titleizeKey(key)}\n${rendered}`);
      }
    }
    if (sections.length) {
      return `${sections.join("\n\n")}\n`;
    }

    return formatKeyValueTable(entries);
  }
  return `${stringifyScalar(data)}\n`;
};

export const formatOutput = <T>(input: {
  command: string;
  data: T;
  format?: MachineOutputFormat;
  frontendUrl?: string;
  warnings?: string[];
  filesWritten?: string[];
  traceId?: string;
  showSensitiveIds?: boolean;
}): string => {
  const format = input.format ?? "text";
  const data = redactSensitiveIds(input.data, {
    showSensitiveIds: input.showSensitiveIds,
  });
  if (format === "json") {
    return `${JSON.stringify(
      formatSuccessEnvelope({
        command: input.command,
        data,
        frontendUrl: input.frontendUrl,
        warnings: input.warnings,
        filesWritten: input.filesWritten,
        traceId: input.traceId,
      }),
      null,
      2
    )}\n`;
  }
  if (format === "ndjson") {
    if (Array.isArray(data)) {
      return data.map((item) => JSON.stringify(item)).join("\n") + "\n";
    }
    return `${JSON.stringify(data)}\n`;
  }
  if (format === "markdown") {
    return `# ${input.command}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;
  }
  return formatTextRecord(data);
};

export const writeFormattedOutput = async <T>(input: {
  command: string;
  data: T;
  format?: MachineOutputFormat;
  output?: string;
  frontendUrl?: string;
  warnings?: string[];
  filesWritten?: string[];
  traceId?: string;
  showSensitiveIds?: boolean;
}) => {
  const text = formatOutput(input);
  if (input.output) {
    const fs = await import("node:fs/promises");
    await fs.writeFile(input.output, text, "utf8");
    return;
  }
  process.stdout.write(text);
};

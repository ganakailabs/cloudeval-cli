export const VISUALIZATION_SCHEMA = "cloudeval.visualization/v1" as const;

export const MAX_VISUALIZATION_ROWS = 200;
export const MAX_VISUALIZATION_FIELDS = 20;
export const MAX_MERMAID_SOURCE_LENGTH = 50_000;

export type PresentationProfile = "terminal" | "web" | "plain";
export type PresentationArtifactCapability =
  | "flint-v1"
  | "mermaid-v11"
  | "chartjs-v4"
  | "echarts-v5";
export type PresentationFallback =
  | "unicode"
  | "table"
  | "edge-list"
  | "source"
  | "plain-markdown";

export interface PresentationCapabilities {
  profile: PresentationProfile;
  artifact_schema: typeof VISUALIZATION_SCHEMA;
  accepts: PresentationArtifactCapability[];
  fallbacks: PresentationFallback[];
}

export type VisualizationScalar = string | number | boolean | null;
export type VisualizationRow = Record<string, VisualizationScalar>;

export interface TableVisualizationFallback {
  type: "table";
  columns: string[];
  rows: VisualizationScalar[][];
}

export interface EdgeListVisualizationFallback {
  type: "edge-list";
  edges: Array<[string, string] | [string, string, string]>;
  source?: string;
}

interface VisualizationArtifactBase {
  schema: typeof VISUALIZATION_SCHEMA;
  id: string;
  title: string;
  description?: string;
  warnings?: string[];
  evidence_refs?: string[];
}

export interface ChartVisualizationArtifact extends VisualizationArtifactBase {
  kind: "chart";
  format: "flint" | "chartjs";
  renderer: "chartjs" | "echarts";
  data: { values: VisualizationRow[] };
  spec: Record<string, unknown>;
  config: Record<string, unknown>;
  fallback: TableVisualizationFallback;
}

export interface MermaidVisualizationArtifact extends VisualizationArtifactBase {
  kind: "diagram";
  format: "mermaid";
  renderer: "mermaid";
  source: string;
  fallback: EdgeListVisualizationFallback;
}

export type VisualizationArtifact =
  | ChartVisualizationArtifact
  | MermaidVisualizationArtifact;

export type VisualizationArtifactParseResult =
  | { ok: true; artifact: VisualizationArtifact }
  | { ok: false; error: string };

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u009b]/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSafeString = (value: unknown, maxLength = 500): value is string =>
  typeof value === "string" &&
  value.length <= maxLength &&
  !CONTROL_CHARACTERS.test(value);

const isScalar = (value: unknown): value is VisualizationScalar =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

const isBoundedJson = (value: unknown): boolean => {
  try {
    const encoded = JSON.stringify(value);
    return encoded.length <= 100_000 && !CONTROL_CHARACTERS.test(encoded);
  } catch {
    return false;
  }
};

const parseCommon = (
  value: Record<string, unknown>,
): { ok: true; common: Omit<VisualizationArtifactBase, "schema"> } | { ok: false; error: string } => {
  if (value.schema !== VISUALIZATION_SCHEMA) {
    return { ok: false, error: "unsupported visualization schema" };
  }
  if (typeof value.id !== "string" || !SAFE_ID.test(value.id)) {
    return { ok: false, error: "invalid visualization id" };
  }
  if (!isSafeString(value.title, 300) || !value.title.trim()) {
    return { ok: false, error: "invalid visualization title" };
  }
  if (value.description !== undefined && !isSafeString(value.description, 2_000)) {
    return { ok: false, error: "invalid visualization description" };
  }
  const parseStringList = (raw: unknown, name: string) => {
    if (raw === undefined) return undefined;
    if (
      !Array.isArray(raw) ||
      raw.length > 20 ||
      !raw.every((entry) => isSafeString(entry, 500))
    ) {
      throw new Error(`invalid visualization ${name}`);
    }
    return [...raw] as string[];
  };

  try {
    return {
      ok: true,
      common: {
        id: value.id,
        title: value.title,
        description: value.description as string | undefined,
        warnings: parseStringList(value.warnings, "warnings"),
        evidence_refs: parseStringList(value.evidence_refs, "evidence refs"),
      },
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
};

const parseTableFallback = (value: unknown): TableVisualizationFallback | null => {
  if (!isRecord(value) || value.type !== "table") return null;
  if (
    !Array.isArray(value.columns) ||
    value.columns.length === 0 ||
    value.columns.length > MAX_VISUALIZATION_FIELDS ||
    !value.columns.every((entry) => isSafeString(entry, 200)) ||
    !Array.isArray(value.rows) ||
    value.rows.length > MAX_VISUALIZATION_ROWS
  ) {
    return null;
  }
  const columns = value.columns as string[];
  const rows = value.rows;
  if (
    !rows.every(
      (row) =>
        Array.isArray(row) &&
        row.length === columns.length &&
        row.every((cell) => isScalar(cell) && (typeof cell !== "string" || isSafeString(cell, 2_000))),
    )
  ) {
    return null;
  }
  return {
    type: "table",
    columns: [...columns],
    rows: rows.map((row) => [...row] as VisualizationScalar[]),
  };
};

const parseEdgeFallback = (value: unknown): EdgeListVisualizationFallback | null => {
  if (!isRecord(value) || value.type !== "edge-list" || !Array.isArray(value.edges)) {
    return null;
  }
  if (
    value.edges.length > MAX_VISUALIZATION_ROWS ||
    !value.edges.every(
      (edge) =>
        Array.isArray(edge) &&
        (edge.length === 2 || edge.length === 3) &&
        edge.every((entry) => isSafeString(entry, 500)),
    )
  ) {
    return null;
  }
  if (value.source !== undefined && !isSafeString(value.source, MAX_MERMAID_SOURCE_LENGTH)) {
    return null;
  }
  return {
    type: "edge-list",
    edges: value.edges.map((edge) => [...edge]) as EdgeListVisualizationFallback["edges"],
    source: value.source as string | undefined,
  };
};

export const parseVisualizationArtifact = (
  input: unknown,
): VisualizationArtifactParseResult => {
  if (!isRecord(input) || !isBoundedJson(input)) {
    return { ok: false, error: "visualization artifact must be bounded JSON" };
  }
  const common = parseCommon(input);
  if (!common.ok) return common;

  if (input.kind === "chart") {
    if (input.format !== "flint" && input.format !== "chartjs") {
      return { ok: false, error: "unsupported chart format" };
    }
    if (input.renderer !== "chartjs" && input.renderer !== "echarts") {
      return { ok: false, error: "unsupported chart renderer" };
    }
    if (!isRecord(input.data) || !Array.isArray(input.data.values)) {
      return { ok: false, error: "chart data.values is required" };
    }
    if (input.data.values.length > MAX_VISUALIZATION_ROWS) {
      return { ok: false, error: "chart has too many rows" };
    }
    const values: VisualizationRow[] = [];
    for (const row of input.data.values) {
      if (!isRecord(row) || Object.keys(row).length > MAX_VISUALIZATION_FIELDS) {
        return { ok: false, error: "invalid chart row" };
      }
      const parsedRow: VisualizationRow = {};
      for (const [key, cell] of Object.entries(row)) {
        if (!isSafeString(key, 200) || !isScalar(cell)) {
          return { ok: false, error: "invalid chart cell" };
        }
        if (typeof cell === "string" && !isSafeString(cell, 2_000)) {
          return { ok: false, error: "unsafe chart cell" };
        }
        parsedRow[key] = cell;
      }
      values.push(parsedRow);
    }
    if (!isRecord(input.spec) || !isRecord(input.config)) {
      return { ok: false, error: "chart spec and config are required" };
    }
    const fallback = parseTableFallback(input.fallback);
    if (!fallback) return { ok: false, error: "invalid chart fallback" };
    return {
      ok: true,
      artifact: {
        schema: VISUALIZATION_SCHEMA,
        ...common.common,
        kind: "chart",
        format: input.format,
        renderer: input.renderer,
        data: { values },
        spec: { ...input.spec },
        config: { ...input.config },
        fallback,
      },
    };
  }

  if (input.kind === "diagram") {
    if (
      input.format !== "mermaid" ||
      input.renderer !== "mermaid" ||
      !isSafeString(input.source, MAX_MERMAID_SOURCE_LENGTH)
    ) {
      return { ok: false, error: "invalid Mermaid diagram" };
    }
    const fallback = parseEdgeFallback(input.fallback);
    if (!fallback) return { ok: false, error: "invalid diagram fallback" };
    return {
      ok: true,
      artifact: {
        schema: VISUALIZATION_SCHEMA,
        ...common.common,
        kind: "diagram",
        format: "mermaid",
        renderer: "mermaid",
        source: input.source,
        fallback,
      },
    };
  }

  return { ok: false, error: "unsupported visualization kind" };
};

const stableHash = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const cleanMermaidLabel = (value: string): string =>
  value
    .trim()
    .replace(/^[(\[{]+|[)\]}]+$/g, "")
    .replace(/^['"]|['"]$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 500);

const mermaidNodeLabels = (source: string): Map<string, string> => {
  const labels = new Map<string, string>();
  const nodePattern = /\b([A-Za-z][\w-]*)\s*(?:\[\[([^\]]+)\]\]|\[\(([^\]]+)\)\]|\(\(([^)]+)\)\)|\[([^\]]+)\]|\(([^)]+)\)|\{([^}]+)\})/g;
  for (const match of source.matchAll(nodePattern)) {
    const label = match.slice(2).find((entry) => typeof entry === "string");
    if (label) labels.set(match[1], cleanMermaidLabel(label));
  }
  return labels;
};

const mermaidEdges = (
  source: string,
): EdgeListVisualizationFallback["edges"] => {
  const labels = mermaidNodeLabels(source);
  const edges: EdgeListVisualizationFallback["edges"] = [];
  const edgePattern = /^\s*([A-Za-z][\w-]*)(?:\s*(?:\[\[[^\]]+\]\]|\[\([^\]]+\)\]|\(\([^)]+\)\)|\[[^\]]+\]|\([^)]+\)|\{[^}]+\}))?\s*(?:-->|---|-.->|==>)\s*(?:\|([^|]+)\|\s*)?([A-Za-z][\w-]*)(?:\s*(?:\[\[[^\]]+\]\]|\[\([^\]]+\)\]|\(\([^)]+\)\)|\[[^\]]+\]|\([^)]+\)|\{[^}]+\}))?\s*$/gm;
  for (const match of source.matchAll(edgePattern)) {
    const from = labels.get(match[1]) ?? match[1];
    const to = labels.get(match[3]) ?? match[3];
    const label = match[2] ? cleanMermaidLabel(match[2]) : undefined;
    edges.push(label ? [from, to, label] : [from, to]);
    if (edges.length >= MAX_VISUALIZATION_ROWS) break;
  }
  return edges;
};

const legacyChartArtifact = (source: string): VisualizationArtifact | null => {
  let config: unknown;
  try {
    config = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isRecord(config) || !isRecord(config.data)) return null;
  const labels = Array.isArray(config.data.labels) ? config.data.labels : [];
  const datasets = Array.isArray(config.data.datasets)
    ? config.data.datasets.filter(isRecord)
    : [];
  if (labels.length > MAX_VISUALIZATION_ROWS || datasets.length > MAX_VISUALIZATION_FIELDS - 1) {
    return null;
  }
  const safeLabels = labels.filter(isScalar);
  const columns = [
    "label",
    ...datasets.map((dataset, index) =>
      isSafeString(dataset.label, 200) ? dataset.label : `series_${index + 1}`,
    ),
  ];
  const rows = safeLabels.map((label, rowIndex) => [
    label,
    ...datasets.map((dataset) => {
      const data = Array.isArray(dataset.data) ? dataset.data : [];
      const value = data[rowIndex];
      return isScalar(value) ? value : null;
    }),
  ]);
  const values = rows.map((row) =>
    Object.fromEntries(columns.map((column, index) => [column, row[index] ?? null])),
  ) as VisualizationRow[];
  return {
    schema: VISUALIZATION_SCHEMA,
    id: `legacy-chart-${stableHash(source)}`,
    kind: "chart",
    format: "chartjs",
    title: isSafeString(config.options, 300)
      ? config.options
      : "Chart",
    renderer: "chartjs",
    data: { values },
    spec: { type: isSafeString(config.type, 100) ? config.type : "bar" },
    config,
    fallback: { type: "table", columns, rows },
  };
};

const mermaidArtifact = (source: string): VisualizationArtifact | null => {
  const normalized = source.trim();
  if (!normalized || !isSafeString(normalized, MAX_MERMAID_SOURCE_LENGTH)) return null;
  const titleMatch = normalized.match(/^\s*(?:%%\s*)?title\s*[: ]\s*(.+)$/im);
  return {
    schema: VISUALIZATION_SCHEMA,
    id: `mermaid-${stableHash(normalized)}`,
    kind: "diagram",
    format: "mermaid",
    title: titleMatch ? cleanMermaidLabel(titleMatch[1]) : "Diagram",
    renderer: "mermaid",
    source: normalized,
    fallback: {
      type: "edge-list",
      edges: mermaidEdges(normalized),
      source: normalized,
    },
  };
};

export const extractVisualizationArtifactsFromMarkdown = (
  markdown: string,
): VisualizationArtifact[] => {
  if (!isSafeString(markdown, 1_000_000)) return [];
  const artifacts: VisualizationArtifact[] = [];
  const seen = new Set<string>();
  const fencePattern = /```([A-Za-z0-9_-]+)[^\n]*\n([\s\S]*?)```/g;
  for (const match of markdown.matchAll(fencePattern)) {
    const language = match[1].toLowerCase();
    const source = match[2].trim();
    let artifact: VisualizationArtifact | null = null;
    if (language === "flint") {
      try {
        const parsed = parseVisualizationArtifact(JSON.parse(source));
        artifact = parsed.ok ? parsed.artifact : null;
      } catch {
        artifact = null;
      }
    } else if (language === "chart") {
      artifact = legacyChartArtifact(source);
    } else if (language === "mermaid") {
      artifact = mermaidArtifact(source);
    }
    if (artifact && !seen.has(artifact.id)) {
      seen.add(artifact.id);
      artifacts.push(artifact);
    }
  }
  return artifacts;
};

/** Persist validated side-channel events in the same Markdown history readers consume. */
export const mergeVisualizationArtifactsIntoMarkdown = (
  markdown: string,
  artifacts: readonly unknown[],
): string => {
  const formats = new Set<string>();
  const fences: string[] = [];
  const seen = new Set<string>();
  for (const candidate of artifacts) {
    const parsed = parseVisualizationArtifact(candidate);
    if (!parsed.ok || seen.has(parsed.artifact.id)) continue;
    const artifact = parsed.artifact;
    seen.add(artifact.id);
    formats.add(artifact.format);
    // The Flint envelope reader accepts every v1 artifact kind. Keep metadata
    // and stable IDs; escaping backticks prevents JSON strings closing the fence.
    const source = JSON.stringify(artifact).replace(/`/g, "\\u0060");
    fences.push(`\`\`\`flint\n${source}\n\`\`\``);
  }
  if (fences.length === 0) return markdown;
  const canonical = fences.join("\n\n");
  let replaced = false;
  const result = markdown.replace(
    /^ {0,3}```(flint|chart|mermaid)[^\S\n]*(?:\n([\s\S]*?)(?:^ {0,3}```[^\S\n]*(?=\n|$)|$(?![\s\S]))|$(?![\s\S]))/gim,
    (match, language: string, source: string | undefined) => {
      let format = language.toLowerCase() === "chart" ? "chartjs" : language.toLowerCase();
      if (format === "flint" && source) {
        try {
          const parsed = parseVisualizationArtifact(JSON.parse(source));
          if (parsed.ok) format = parsed.artifact.format;
        } catch { /* Incomplete model echoes are replaced by the valid event. */ }
      }
      if (!formats.has(format)) return match;
      if (replaced) return "";
      replaced = true;
      return canonical;
    },
  );
  return replaced ? result.trimEnd() : `${result.trimEnd()}${result.trim() ? "\n\n" : ""}${canonical}`;
};

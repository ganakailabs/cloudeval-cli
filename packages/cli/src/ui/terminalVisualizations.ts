import { plot as plotAsciiChart } from "asciichart";
import type {
  ChartVisualizationArtifact,
  MermaidVisualizationArtifact,
  VisualizationArtifact,
  VisualizationScalar,
} from "@cloudeval/shared";

export type TerminalVisualizationMode =
  | "line"
  | "bar"
  | "proportional"
  | "scatter"
  | "heatmap"
  | "edge-list"
  | "source"
  | "table";

export interface TerminalVisualization {
  title: string;
  mode: TerminalVisualizationMode;
  lines: string[];
}

const ANSI_SEQUENCE = /[\u001b\u009b](?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)?)/g;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const sanitize = (value: unknown): string =>
  String(value ?? "")
    .replace(ANSI_SEQUENCE, "")
    .replace(UNSAFE_CONTROL, "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const truncate = (value: unknown, width: number): string => {
  const safe = [...sanitize(value)];
  if (safe.length <= width) return safe.join("");
  if (width <= 1) return safe.slice(0, Math.max(0, width)).join("");
  return `${safe.slice(0, width - 1).join("")}…`;
};

const limitLine = (line: string, width: number): string => truncate(line, width);

const asNumber = (value: VisualizationScalar | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const formatNumber = (value: number): string =>
  Math.abs(value) >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}m`
    : Math.abs(value) >= 1_000
      ? `${(value / 1_000).toFixed(1)}k`
      : Number.isInteger(value)
        ? String(value)
        : value.toFixed(2).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");

const fieldFromSpec = (
  spec: Record<string, unknown>,
  channel: "x" | "y" | "color",
): string | undefined => {
  const direct = spec[channel];
  if (typeof direct === "string") return direct;
  if (direct && typeof direct === "object" && "field" in direct) {
    const field = (direct as { field?: unknown }).field;
    if (typeof field === "string") return field;
  }
  const encoding = spec.encoding;
  if (encoding && typeof encoding === "object") {
    const encoded = (encoding as Record<string, unknown>)[channel];
    if (encoded && typeof encoded === "object" && "field" in encoded) {
      const field = (encoded as { field?: unknown }).field;
      if (typeof field === "string") return field;
    }
  }
  return undefined;
};

const chartType = (artifact: ChartVisualizationArtifact): string => {
  const candidates = [artifact.spec.type, artifact.spec.mark, artifact.config.type];
  for (const candidate of candidates) {
    if (typeof candidate === "string") return candidate.toLowerCase();
    if (candidate && typeof candidate === "object" && "type" in candidate) {
      const type = (candidate as { type?: unknown }).type;
      if (typeof type === "string") return type.toLowerCase();
    }
  }
  const series = artifact.config.series;
  if (Array.isArray(series)) {
    const first = series.find((entry) => entry && typeof entry === "object") as
      | { type?: unknown }
      | undefined;
    if (typeof first?.type === "string") return first.type.toLowerCase();
  }
  return "table";
};

const inferFields = (artifact: ChartVisualizationArtifact) => {
  const keys = Object.keys(artifact.data.values[0] ?? {});
  const numeric = keys.find((key) =>
    artifact.data.values.some((row) => typeof row[key] === "number"),
  );
  return {
    x: fieldFromSpec(artifact.spec, "x") ?? keys.find((key) => key !== numeric) ?? keys[0],
    y: fieldFromSpec(artifact.spec, "y") ?? numeric ?? keys[1] ?? keys[0],
    color: fieldFromSpec(artifact.spec, "color"),
  };
};

const renderTable = (
  artifact: ChartVisualizationArtifact,
  maxWidth: number,
): TerminalVisualization => {
  const columns = artifact.fallback.columns.slice(0, 8);
  const rows = artifact.fallback.rows.slice(0, 20);
  if (!columns.length) {
    return { title: sanitize(artifact.title), mode: "table", lines: ["No chart data."] };
  }
  const separatorWidth = Math.max(0, (columns.length - 1) * 3);
  const cellWidth = Math.max(3, Math.floor((maxWidth - separatorWidth) / columns.length));
  const line = (cells: unknown[]) =>
    limitLine(
      columns
        .map((_, index) => truncate(cells[index] ?? "", cellWidth).padEnd(cellWidth))
        .join(" │ ")
        .trimEnd(),
      maxWidth,
    );
  return {
    title: sanitize(artifact.title),
    mode: "table",
    lines: [
      line(columns),
      limitLine(columns.map(() => "─".repeat(cellWidth)).join("─┼─"), maxWidth),
      ...rows.map(line),
      ...(artifact.fallback.rows.length > rows.length ? ["…"] : []),
    ],
  };
};

const renderLine = (
  artifact: ChartVisualizationArtifact,
  maxWidth: number,
): TerminalVisualization => {
  const { x, y } = inferFields(artifact);
  const points = artifact.data.values
    .map((row) => asNumber(row[y]))
    .filter((value): value is number => value !== null);
  if (points.length < 2) return renderTable(artifact, maxWidth);
  const plotted = plotAsciiChart(points, {
    height: Math.min(10, Math.max(4, Math.floor(points.length / 2) + 3)),
    format: (value: number) => formatNumber(value).padStart(8),
  })
    .split("\n")
    .map((line) => limitLine(line, maxWidth));
  const labels = artifact.data.values
    .map((row) => sanitize(row[x]))
    .filter(Boolean);
  if (labels.length) plotted.push(limitLine(`${labels[0]} → ${labels.at(-1)}`, maxWidth));
  return { title: sanitize(artifact.title), mode: "line", lines: plotted };
};

const renderBars = (
  artifact: ChartVisualizationArtifact,
  maxWidth: number,
  proportional = false,
): TerminalVisualization => {
  const { x, y } = inferFields(artifact);
  const points = artifact.data.values
    .map((row) => ({ label: sanitize(row[x]), value: asNumber(row[y]) }))
    .filter((point): point is { label: string; value: number } => point.value !== null)
    .slice(0, 30);
  if (!points.length) return renderTable(artifact, maxWidth);
  const largest = Math.max(...points.map((point) => Math.abs(point.value)), 1);
  const total = points.reduce((sum, point) => sum + Math.max(0, point.value), 0);
  const labelWidth = Math.min(18, Math.max(7, Math.floor(maxWidth * 0.34)));
  const valueWidth = 10;
  const barWidth = Math.max(3, maxWidth - labelWidth - valueWidth - 2);
  const lines = points.map((point) => {
    const ratio = proportional && total > 0 ? Math.max(0, point.value) / total : Math.abs(point.value) / largest;
    const blocks = Math.max(point.value === 0 ? 0 : 1, Math.round(ratio * barWidth));
    const suffix = proportional && total > 0 ? `${Math.round(ratio * 100)}%` : formatNumber(point.value);
    return limitLine(
      `${truncate(point.label || "(blank)", labelWidth).padEnd(labelWidth)} ${"█".repeat(blocks)} ${suffix}`,
      maxWidth,
    );
  });
  return {
    title: sanitize(artifact.title),
    mode: proportional ? "proportional" : "bar",
    lines,
  };
};

const renderScatter = (
  artifact: ChartVisualizationArtifact,
  maxWidth: number,
): TerminalVisualization => {
  const { x, y } = inferFields(artifact);
  const points = artifact.data.values
    .map((row) => ({ x: asNumber(row[x]), y: asNumber(row[y]) }))
    .filter((point): point is { x: number; y: number } => point.x !== null && point.y !== null);
  if (!points.length) return renderTable(artifact, maxWidth);
  const gridWidth = Math.max(8, Math.min(48, maxWidth - 2));
  const gridHeight = 8;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const cells = Array.from({ length: gridHeight }, () => Array(gridWidth).fill(" "));
  for (const point of points) {
    const column = Math.round(((point.x - minX) / (maxX - minX || 1)) * (gridWidth - 1));
    const row = gridHeight - 1 - Math.round(((point.y - minY) / (maxY - minY || 1)) * (gridHeight - 1));
    cells[row][column] = cells[row][column] === " " ? "•" : "◆";
  }
  return {
    title: sanitize(artifact.title),
    mode: "scatter",
    lines: [
      ...cells.map((row) => limitLine(row.join(""), maxWidth)),
      limitLine(`x ${formatNumber(minX)} → ${formatNumber(maxX)} · y ${formatNumber(minY)} → ${formatNumber(maxY)}`, maxWidth),
    ],
  };
};

const renderHeatmap = (
  artifact: ChartVisualizationArtifact,
  maxWidth: number,
): TerminalVisualization => {
  const { x, y, color } = inferFields(artifact);
  const valueField = color ?? Object.keys(artifact.data.values[0] ?? {}).find((key) =>
    artifact.data.values.some((row) => typeof row[key] === "number"),
  );
  if (!x || !y || !valueField) return renderTable(artifact, maxWidth);
  const xValues = [...new Set(artifact.data.values.map((row) => sanitize(row[x])))].slice(0, 20);
  const yValues = [...new Set(artifact.data.values.map((row) => sanitize(row[y])))].slice(0, 20);
  const numeric = artifact.data.values
    .map((row) => asNumber(row[valueField]))
    .filter((value): value is number => value !== null);
  if (!numeric.length) return renderTable(artifact, maxWidth);
  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  const shades = ["░", "▒", "▓", "█"];
  const yLabelWidth = Math.min(10, Math.max(3, Math.floor(maxWidth * 0.25)));
  const lines = yValues.map((yValue) => {
    const cells = xValues.map((xValue) => {
      const row = artifact.data.values.find(
        (entry) => sanitize(entry[x]) === xValue && sanitize(entry[y]) === yValue,
      );
      const value = row ? asNumber(row[valueField]) : null;
      if (value === null) return " ";
      const shade = Math.min(shades.length - 1, Math.floor(((value - min) / (max - min || 1)) * shades.length));
      return shades[shade];
    });
    return limitLine(`${truncate(yValue, yLabelWidth).padEnd(yLabelWidth)} ${cells.join(" ")}`, maxWidth);
  });
  lines.unshift(limitLine(`${" ".repeat(yLabelWidth + 1)}${xValues.map((value) => truncate(value, 1)).join(" ")}`, maxWidth));
  return { title: sanitize(artifact.title), mode: "heatmap", lines };
};

const renderDiagram = (
  artifact: MermaidVisualizationArtifact,
  maxWidth: number,
): TerminalVisualization => {
  if (artifact.fallback.edges.length) {
    return {
      title: sanitize(artifact.title),
      mode: "edge-list",
      lines: artifact.fallback.edges.slice(0, 50).map(([from, to, label]) =>
        limitLine(
          label
            ? `${sanitize(from)} ──${sanitize(label)}──▶ ${sanitize(to)}`
            : `${sanitize(from)} ──▶ ${sanitize(to)}`,
          maxWidth,
        ),
      ),
    };
  }
  const lines = artifact.source
    .split(/\r?\n/)
    .map((line) => limitLine(line, maxWidth))
    .slice(0, 50);
  return {
    title: sanitize(artifact.title),
    mode: "source",
    lines: lines.length ? lines : ["No diagram data."],
  };
};

export const renderTerminalVisualization = (
  artifact: VisualizationArtifact,
  terminalWidth: number,
): TerminalVisualization => {
  const maxWidth = Math.max(12, Math.floor(terminalWidth) - 4);
  if (artifact.kind === "diagram") return renderDiagram(artifact, maxWidth);

  const type = chartType(artifact);
  if (["line", "area", "stepped", "spline"].some((name) => type.includes(name))) {
    return renderLine(artifact, maxWidth);
  }
  if (["bar", "column", "histogram"].some((name) => type.includes(name))) {
    return renderBars(artifact, maxWidth);
  }
  if (["pie", "doughnut", "donut", "rose", "radar", "polar"].some((name) => type.includes(name))) {
    return renderBars(artifact, maxWidth, true);
  }
  if (["scatter", "bubble"].some((name) => type.includes(name))) {
    return renderScatter(artifact, maxWidth);
  }
  if (type.includes("heatmap")) return renderHeatmap(artifact, maxWidth);
  return renderTable(artifact, maxWidth);
};

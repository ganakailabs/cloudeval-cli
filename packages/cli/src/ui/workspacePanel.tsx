import React from "react";
import { Box, Text } from "ink";
import { plot as plotAsciiChart } from "asciichart";
import type { Project } from "@cloudeval/core";
import { slashCommands } from "./commandCompletion.js";
import { buildFrontendUrl } from "../frontendLinks.js";
import { formatCredits, type BillingSummaryState } from "./billingSummary.js";
import { Spinner } from "./components/Spinner.js";
import { TitledBox } from "./components/TitledBox.js";
import { getTuiKeyBindings } from "./keyBindings.js";
import { truncateForTerminal } from "./layout.js";
import {
  buildOverviewDashboardModel,
  type OverviewBar,
  type OverviewDashboardModel,
  type OverviewTone,
  type OverviewTrend,
} from "./overviewDashboard.js";
import { buildReportsDashboardModel } from "./reportsDashboard.js";
import { raisedButtonStyle, terminalTheme } from "./theme.js";
import {
  workspaceTabButtonLabel,
  workspaceTabLabels,
  workspaceTabs,
  type WorkspaceTab,
} from "./workspaceTabs.js";

export type WorkspacePanelStatus = "idle" | "loading" | "ready" | "error";

export interface WorkspacePanelState {
  tab: WorkspaceTab;
  status: WorkspacePanelStatus;
  data: Record<string, unknown>;
  warnings: string[];
  error?: string;
  loadedAt?: number;
  staleAt?: number;
  cacheKey?: string;
  isRefreshing?: boolean;
  refreshStartedAt?: number;
  lastLoadReason?: "initial" | "manual" | "stale";
  lastRefreshToken?: number;
}

export interface WorkspacePanelProps {
  tab: WorkspaceTab;
  state: WorkspacePanelState;
  projects: Project[];
  selectedProject: Project | null;
  currentUserId?: string;
  selectedModel: string;
  selectedMode: string;
  apiBase: string;
  frontendUrl: string;
  terminalColumns: number;
  tablePage: number;
}

type Metric = {
  label: string;
  value: string;
  tone?: OverviewTone;
};

type TableRow = Record<string, string | number>;

const toRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const directArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value;
  }
  const record = toRecord(value);
  if (!record) {
    return [];
  }
  for (const key of [
    "data",
    "items",
    "rows",
    "results",
    "reports",
    "connections",
    "projects",
    "ledger",
    "invoices",
    "notifications",
    "topups",
    "top_ups",
    "purchases",
  ]) {
    const candidate = record[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
    const nested = toRecord(candidate);
    if (nested) {
      const nestedArray = directArray(nested);
      if (nestedArray.length) {
        return nestedArray;
      }
    }
  }
  return [];
};

const allNumbers = (value: unknown, limit = 36): number[] => {
  const output: number[] = [];
  const visit = (current: unknown) => {
    if (output.length >= limit) {
      return;
    }
    if (typeof current === "number" && Number.isFinite(current)) {
      output.push(current);
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) {
        visit(item);
      }
      return;
    }
    const record = toRecord(current);
    if (!record) {
      return;
    }
    for (const [key, nested] of Object.entries(record)) {
      const normalized = key.toLowerCase();
      if (
        normalized.includes("id") ||
        normalized.includes("timestamp") ||
        normalized.includes("date")
      ) {
        continue;
      }
      visit(nested);
    }
  };
  visit(value);
  return output;
};

const firstString = (
  value: unknown,
  keys: string[],
  fallback = "unknown"
): string => {
  const record = toRecord(value);
  if (!record) {
    return fallback;
  }
  for (const key of keys) {
    const current = record[key];
    if (typeof current === "string" && current.trim()) {
      return current.trim();
    }
    if (typeof current === "number" && Number.isFinite(current)) {
      return String(current);
    }
  }
  return fallback;
};

const firstNumber = (value: unknown, keys: string[]): number | undefined => {
  const record = toRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const current = record[key];
    const numberValue = typeof current === "number" ? current : Number(current);
    if (Number.isFinite(numberValue)) {
      return numberValue;
    }
  }
  return undefined;
};

const formatNumber = (value: number | undefined): string =>
  value === undefined
    ? "-"
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);

const formatPercent = (value: number | undefined): string =>
  value === undefined ? "-" : `${Math.round(value * 100)}%`;

const metricColor = (tone?: Metric["tone"]): string | undefined => {
  if (tone === "success") return terminalTheme.success;
  if (tone === "warning") return terminalTheme.warning;
  if (tone === "danger") return terminalTheme.danger;
  return undefined;
};

const billingToneColor = (tone?: string): string | undefined => {
  if (tone === "success") return terminalTheme.success;
  if (tone === "warning") return terminalTheme.warning;
  if (tone === "low") return terminalTheme.warning;
  if (tone === "exhausted") return terminalTheme.danger;
  if (tone === "danger") return terminalTheme.danger;
  if (tone === "normal") return terminalTheme.success;
  return terminalTheme.muted;
};

const metricToneFromBillingTone = (tone?: string): Metric["tone"] =>
  tone === "exhausted" ? "danger" : tone === "low" || tone === "warning" ? "warning" : "success";

const chartValue = (value: number): string =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);

const normalizeLabel = (value: string): string =>
  value.replace(/_/g, " ").replace(/\s+/g, " ").trim();

const sampleValues = (values: number[], width: number): number[] => {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length <= width) {
    return clean;
  }
  const step = (clean.length - 1) / Math.max(1, width - 1);
  return Array.from({ length: width }, (_, index) => clean[Math.round(index * step)]);
};

const sparkBlocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

const InlineSparkline: React.FC<{ values: number[]; width: number; tone?: Metric["tone"] }> = ({
  values,
  width,
  tone,
}) => {
  const sampled = sampleValues(values, Math.max(4, width));
  if (!sampled.length) {
    return <Text dimColor>no trend data</Text>;
  }
  const max = Math.max(...sampled);
  const min = Math.min(...sampled);
  const span = max - min || 1;
  return (
    <Text color={metricColor(tone) ?? terminalTheme.brand}>
      {sampled
        .map((value) => {
          const index = Math.min(
            sparkBlocks.length - 1,
            Math.max(0, Math.round(((value - min) / span) * (sparkBlocks.length - 1)))
          );
          return sparkBlocks[index];
        })
        .join("")}
    </Text>
  );
};

const AsciiLineChart: React.FC<{
  values: number[];
  width: number;
  height?: number;
  tone?: Metric["tone"];
}> = ({ values, width, height = 4, tone }) => {
  const sampled = sampleValues(values, Math.max(8, width - 8));
  if (sampled.length < 2) {
    return (
      <Box flexDirection="row">
        <InlineSparkline values={sampled} width={Math.max(8, width - 12)} tone={tone} />
        <Text dimColor> current only</Text>
      </Box>
    );
  }
  const chart = plotAsciiChart(sampled, {
    height,
    offset: 4,
    padding: "    ",
    format: (value: number) =>
      String(Math.round(value)).padStart(3, " ").slice(-3),
  });
  return (
    <Box flexDirection="column">
      {chart.split("\n").map((line, index) => (
        <Text
          key={`${line}-${index}`}
          color={metricColor(tone) ?? terminalTheme.brand}
          wrap="truncate"
        >
          {truncateForTerminal(line, width)}
        </Text>
      ))}
    </Box>
  );
};

const keySummary = (value: unknown): string => {
  const record = toRecord(value);
  if (!record) {
    return "no object payload";
  }
  const keys = Object.keys(record).slice(0, 8);
  return keys.length ? keys.join(", ") : "empty object";
};

const rowLabel = (value: unknown, fallback: string): string => {
  const record = toRecord(value);
  if (!record) {
    return typeof value === "string" ? value : fallback;
  }
  return firstString(
    record,
    [
      "name",
      "title",
      "report_type",
      "type",
      "action_type",
      "model_name",
      "status",
      "id",
    ],
    fallback
  );
};

const rowDetail = (value: unknown): string => {
  const record = toRecord(value);
  if (!record) {
    return "";
  }
  const parts = [
    firstString(record, ["cloud_provider", "provider"], ""),
    (() => {
      const status = firstString(record, ["effective_status", "status", "outcome"], "");
      return status.toLowerCase().replace(/[\s-]+/g, "_") === "trial_active" ? "" : status;
    })(),
    firstString(record, ["created_at", "updated_at", "timestamp", "period"], ""),
  ].filter(Boolean);
  return parts.join(" | ");
};

const Bar: React.FC<{ value?: number; width?: number; tone?: Metric["tone"] }> = ({
  value,
  width = 28,
  tone,
}) => {
  if (value === undefined) {
    return <Text dimColor>{"-".repeat(Math.min(width, 28))}</Text>;
  }
  const ratio = Math.max(0, Math.min(1, value));
  const filled = Math.round(ratio * width);
  if (filled <= 0) {
    return <Text>{" ".repeat(width)}</Text>;
  }
  return (
    <Text color={metricColor(tone) ?? terminalTheme.brand}>
      {"█".repeat(filled)}
      {" ".repeat(width - filled)}
    </Text>
  );
};

const BarList: React.FC<{
  bars: OverviewBar[];
  width: number;
  emptyLabel: string;
  labelWidth?: number;
}> = ({ bars, width, emptyLabel, labelWidth = 18 }) => {
  const barWidth = Math.max(12, Math.min(32, width));
  return (
    <Box flexDirection="column">
      {bars.length ? (
        bars.slice(0, 6).map((bar) => (
          <Box key={bar.label} flexDirection="row">
            <Box width={labelWidth}>
              <Text wrap="truncate">{truncateForTerminal(normalizeLabel(bar.label), labelWidth - 2)}</Text>
            </Box>
            <Bar value={bar.ratio} width={barWidth} tone={bar.tone} />
            <Text color={metricColor(bar.tone)}> {chartValue(bar.value)}</Text>
          </Box>
        ))
      ) : (
        <Text dimColor>{emptyLabel}</Text>
      )}
    </Box>
  );
};

const TrendSummary: React.FC<{ trend: OverviewTrend; width: number }> = ({
  trend,
  width,
}) => {
  const chartWidth = Math.max(18, Math.min(44, width));
  const labelWidth = Math.min(24, Math.max(14, Math.floor(chartWidth * 0.55)));
  const icon =
    trend.delta === undefined
      ? "•"
      : trend.delta > 0
        ? "↑"
        : trend.delta < 0
          ? "↓"
          : "→";
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={labelWidth}>
          <Text bold wrap="truncate">{truncateForTerminal(trend.label, labelWidth - 1)}</Text>
        </Box>
        <Text color={metricColor(trend.tone)}>
          {icon} {trend.summary}
        </Text>
      </Box>
      <AsciiLineChart values={trend.values} width={chartWidth} height={3} tone={trend.tone} />
    </Box>
  );
};

const SectionCard: React.FC<{
  title: string;
  children: React.ReactNode;
  borderColor?: string;
}> = ({ title, children, borderColor }) => (
  <TitledBox
    title={title}
    borderStyle="round"
    borderColor={borderColor ?? terminalTheme.muted}
    padding={0}
    paddingX={1}
  >
    <Box flexDirection="column" marginTop={1}>
      {children}
    </Box>
  </TitledBox>
);

const CreditProgress: React.FC<{
  remaining: number;
  total: number;
  width?: number;
  tone?: string;
}> = ({ remaining, total, width = 12, tone }) => {
  const ratio = total > 0 ? Math.min(1, Math.max(0, remaining / total)) : 0;
  const safeWidth = Math.max(6, width);
  const filled = Math.round(ratio * safeWidth);
  return (
    <Text>
      [
      <Text color={billingToneColor(tone)}>
        {"█".repeat(filled)}
      </Text>
      {" ".repeat(safeWidth - filled)}
      ] {Math.round(ratio * 100)}%
    </Text>
  );
};

const BillingSummaryLine: React.FC<{ billing: BillingSummaryState }> = ({ billing }) => (
  <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
    <Text dimColor>Plan: <Text>{billing.plan}</Text></Text>
    <Text dimColor>
      Credits: <Text color={billingToneColor(billing.tone)}>
        {formatCredits(billing.remaining)}/{formatCredits(billing.total)}
      </Text>
    </Text>
    <CreditProgress
      remaining={billing.remaining}
      total={billing.total}
      width={12}
      tone={billing.tone}
    />
    <Text dimColor>O opens billing</Text>
  </Box>
);

const MetricStrip: React.FC<{ metrics: Metric[]; compact: boolean }> = ({ metrics, compact }) => (
  <Box flexDirection={compact ? "column" : "row"} gap={1} flexWrap="wrap">
    {metrics.map((metric) => {
      const width = Math.max(
        metric.label.length + 8,
        metric.value.length + 6,
        compact ? 0 : 17
      );
      return (
        <TitledBox
          key={metric.label}
          title={metric.label}
          flexDirection="column"
          borderStyle="round"
          borderColor={metricColor(metric.tone) ?? terminalTheme.muted}
          padding={0}
          paddingX={1}
          width={width}
          flexShrink={0}
        >
          <Text bold color={metricColor(metric.tone)} wrap="truncate">{metric.value}</Text>
        </TitledBox>
      );
    })}
  </Box>
);

const ResponsiveTable: React.FC<{
  rows: TableRow[];
  columns: string[];
  terminalColumns: number;
  maxRows?: number;
  page?: number;
}> = ({ rows, columns, terminalColumns, maxRows = 12, page = 0 }) => {
  if (!rows.length) {
    return null;
  }
  const safeMaxRows = Math.max(1, maxRows);
  const pageCount = Math.max(1, Math.ceil(rows.length / safeMaxRows));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const startIndex = safePage * safeMaxRows;
  const visibleRows = rows.slice(startIndex, startIndex + safeMaxRows);
  const hiddenCount = Math.max(0, rows.length - visibleRows.length);
  const narrow = terminalColumns < 76;
  if (narrow) {
    return (
      <Box flexDirection="column">
        {visibleRows.map((row, index) => (
          <Box key={index} flexDirection="column" marginBottom={1}>
            {columns.map((column) => (
              <Text key={column} wrap="truncate">
                <Text color={terminalTheme.muted}>{column}: </Text>
                {String(row[column] ?? "")}
              </Text>
            ))}
          </Box>
        ))}
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>rows {startIndex + 1}-{startIndex + visibleRows.length} of {rows.length}</Text>
          <Text dimColor>[ prev | ] next | D download</Text>
        </Box>
      </Box>
    );
  }
  const availableWidth = Math.max(48, terminalColumns - 14);
  const minimumWidth = (column: string): number => (column === "#" || column === "" ? 3 : 8);
  const preferredWidths = columns.map((column) => {
    const contentWidth = Math.max(
      column.length,
      ...visibleRows.map((row) => String(row[column] ?? "").length)
    );
    return Math.max(minimumWidth(column), contentWidth + 1);
  });
  const totalGap = Math.max(0, columns.length - 1);
  const preferredTotal = preferredWidths.reduce((sum, width) => sum + width, 0) + totalGap;
  const widths =
    preferredTotal <= availableWidth
      ? preferredWidths
      : preferredWidths.map((width, index) => {
          const column = columns[index] ?? "";
          const min = minimumWidth(column);
          const scaled = Math.floor((width / preferredTotal) * (availableWidth - totalGap));
          return Math.max(min, scaled);
        });
  const columnWidth = (column: string): number => widths[columns.indexOf(column)] ?? 10;
  const renderRow = (row: TableRow, key: string, heading = false) => (
    <Box key={key} flexDirection="row">
      {columns.map((column) => {
        const width = columnWidth(column);
        const value = heading ? column : String(row[column] ?? "");
        return (
          <Box key={column} width={width} marginRight={1}>
            <Text
              bold={heading}
              color={heading ? terminalTheme.brand : undefined}
              wrap="truncate"
            >
              {value.length <= width - 1
                ? value
                : truncateForTerminal(value, Math.max(1, width - 1))}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
  return (
    <Box flexDirection="column">
      {renderRow({}, "header", true)}
      <Text dimColor>{truncateForTerminal("─".repeat(availableWidth), availableWidth)}</Text>
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1}>
          {visibleRows.map((row, index) => renderRow(row, String(index)))}
        </Box>
        {hiddenCount > 0 ? (
          <Box flexDirection="column" marginLeft={1}>
            <Text color={terminalTheme.brand}>┃</Text>
            {Array.from({ length: Math.max(1, visibleRows.length - 2) }, (_, index) => (
              <Text key={index} dimColor>│</Text>
            ))}
            <Text dimColor>╵</Text>
          </Box>
        ) : null}
      </Box>
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor>rows {startIndex + 1}-{startIndex + visibleRows.length} of {rows.length}</Text>
        <Text dimColor>
          page {safePage + 1}/{pageCount} | [ prev | ] next | D download
        </Text>
      </Box>
    </Box>
  );
};

const HelpLegend: React.FC<{ includeQuit?: boolean; wrap?: boolean }> = ({
  includeQuit = false,
  wrap = false,
}) => {
  const segments = [
    { key: `1-${workspaceTabs.length}`, label: "tabs", color: terminalTheme.brand },
    { key: "Left/Right", label: "switch", color: terminalTheme.brand },
    { key: "R", label: "refresh", color: terminalTheme.warning },
    { key: "O", label: "open", color: terminalTheme.success },
    { key: "D", label: "download", color: terminalTheme.success },
    ...(includeQuit
      ? [{ key: "Ctrl+Q", label: "quit", color: terminalTheme.danger }]
      : []),
  ];
  return (
    <Box flexDirection="row" flexWrap={wrap ? "wrap" : "nowrap"} columnGap={1}>
      {segments.map((segment, index) => (
        <Box key={segment.key} flexDirection="row">
          {index > 0 ? <Text dimColor>| </Text> : null}
          <Text bold color={segment.color}>{segment.key}</Text>
          <Text dimColor> {segment.label}</Text>
        </Box>
      ))}
    </Box>
  );
};

const ResourceSummary: React.FC<{
  label: string;
  value: unknown;
  terminalColumns: number;
}> = ({ label, value, terminalColumns }) => {
  const rows = directArray(value);
  return (
    <Box flexDirection="column">
      <Text bold>{label}</Text>
      <Text dimColor wrap="wrap">
        {rows.length
          ? `${rows.length} row(s) returned`
          : `keys: ${truncateForTerminal(keySummary(value), Math.max(32, terminalColumns - 14))}`}
      </Text>
      {rows.slice(0, 5).map((row, index) => (
        <Text key={`${label}-${index}`} wrap="truncate">
          {index + 1}. {truncateForTerminal(rowLabel(row, `row ${index + 1}`), 36)}
          {rowDetail(row) ? ` - ${truncateForTerminal(rowDetail(row), 64)}` : ""}
        </Text>
      ))}
      {!rows.length && !toRecord(value) ? <Text dimColor>No data returned.</Text> : null}
    </Box>
  );
};

const cleanBackendWarning = (warning: string, terminalColumns: number): string => {
  const compact = warning
    .replace(
      /:\s*\{"detail":"Device token not authorized for this endpoint"\}/g,
      " (backend denied CLI device-token access)"
    )
    .replace(/\s+/g, " ")
    .trim();
  return truncateForTerminal(compact, Math.max(72, Math.min(180, terminalColumns - 8)));
};

const ProjectsView: React.FC<{ projects: Project[]; selectedProject: Project | null }> = ({
  projects,
  selectedProject,
}) => (
  <Box flexDirection="column" gap={1}>
    <MetricStrip
      compact={false}
      metrics={[
        { label: "Projects", value: String(projects.length) },
        { label: "Selected", value: selectedProject?.name ?? "none" },
      ]}
    />
    {projects.length ? (
      projects.slice(0, 12).map((project, index) => (
        <Text
          key={project.id ?? index}
          color={project.id === selectedProject?.id ? terminalTheme.brand : undefined}
          wrap="truncate"
        >
          {project.id === selectedProject?.id ? ">" : " "} {project.name} |{" "}
          {project.cloud_provider ?? "cloud"} | {project.id}
        </Text>
      ))
    ) : (
      <Text dimColor>No projects returned by the backend.</Text>
    )}
  </Box>
);

const ConnectionsView: React.FC<{
  connections: unknown[];
}> = ({ connections }) => (
  <Box flexDirection="column" gap={1}>
    <MetricStrip
      compact={false}
      metrics={[{ label: "Connections", value: String(connections.length) }]}
    />
    {connections.length ? (
      connections.slice(0, 12).map((connection, index) => (
        <Text key={String(firstString(connection, ["id"], String(index)))} wrap="truncate">
          {index + 1}. {truncateForTerminal(rowLabel(connection, "connection"), 36)}
          {rowDetail(connection) ? ` - ${truncateForTerminal(rowDetail(connection), 72)}` : ""}
        </Text>
      ))
    ) : (
      <Text dimColor>No connections returned by the backend.</Text>
    )}
  </Box>
);

const BillingView: React.FC<{
  state: WorkspacePanelState;
  compact: boolean;
  terminalColumns: number;
  frontendUrl: string;
}> = ({ state, compact, terminalColumns, frontendUrl }) => {
  const creditStatus = toRecord(state.data.creditStatus);
  const entitlement = toRecord(state.data.entitlement);
  const plan = toRecord(entitlement?.plan);
  const usageValues = allNumbers(state.data.usageSummary);
  const ledger = directArray(state.data.ledger);
  const invoices = directArray(state.data.billingInfo);
  const topups = directArray(state.data.topups);
  const notifications = directArray(state.data.notifications);
  const remainingRatio = firstNumber(creditStatus, ["remainingRatio"]);
  const creditTone = firstString(creditStatus, ["tone"], "normal");
  const tone = metricToneFromBillingTone(creditTone);
  const remaining = firstNumber(creditStatus, ["remaining"]);
  const total = firstNumber(creditStatus, ["total"]);
  const plansUrl = buildFrontendUrl({ baseUrl: frontendUrl, target: "billing", tab: "plans" });
  const topUpUrl = buildFrontendUrl({ baseUrl: frontendUrl, target: "billing", tab: "usage" });
  const metrics: Metric[] = [
    { label: "Plan", value: firstString(creditStatus, ["planName"], firstString(plan, ["name"], "-")) },
    { label: "Remaining", value: formatNumber(remaining) },
    { label: "Used", value: formatNumber(firstNumber(creditStatus, ["used"])) },
    { label: "Top-up", value: formatNumber(firstNumber(creditStatus, ["topUpBalance"])) },
  ];
  return (
    <Box flexDirection="column" gap={1}>
      <MetricStrip metrics={metrics} compact={compact} />
      <Box flexDirection="row" gap={1}>
        <Text dimColor>Credit balance</Text>
        {remaining !== undefined && total !== undefined ? (
          <CreditProgress remaining={remaining} total={total} width={28} tone={creditTone} />
        ) : (
          <>
            <Bar value={remainingRatio} tone={tone} />
            <Text>{formatPercent(remainingRatio)}</Text>
          </>
        )}
      </Box>
      <Text dimColor wrap="wrap">
        Subscribe: {plansUrl} | Top up: {topUpUrl}
      </Text>
      <SectionCard title="Usage trend" borderColor={terminalTheme.brand}>
        <AsciiLineChart
          values={usageValues}
          width={Math.min(56, Math.max(24, terminalColumns - 28))}
          height={4}
          tone="normal"
        />
      </SectionCard>
      <ResourceSummary label="Recent ledger" value={ledger} terminalColumns={terminalColumns} />
      <ResourceSummary label="Invoices" value={invoices} terminalColumns={terminalColumns} />
      <ResourceSummary label="Top-ups" value={topups} terminalColumns={terminalColumns} />
      <ResourceSummary label="Notifications" value={notifications} terminalColumns={terminalColumns} />
    </Box>
  );
};

const statusTextColor = (status: string): string | undefined => {
  const normalized = status.toLowerCase();
  if (normalized === "completed" || normalized === "fresh") return terminalTheme.success;
  if (normalized === "running" || normalized === "partial" || normalized === "stale") {
    return terminalTheme.warning;
  }
  if (normalized === "failed" || normalized === "outdated" || normalized === "missing") {
    return terminalTheme.danger;
  }
  return terminalTheme.muted;
};

const compactStatusLabel = (status: string): string =>
  normalizeLabel(status || "not_started")
    .replace(/\b\w/g, (match) => match.toUpperCase());

const statusHeatColor = (status: string): string | undefined => {
  const normalized = status.toLowerCase();
  if (normalized === "completed" || normalized === "fresh") return terminalTheme.success;
  if (normalized === "running" || normalized === "partial" || normalized === "stale") {
    return terminalTheme.warning;
  }
  if (normalized === "failed" || normalized === "missing" || normalized === "outdated") {
    return terminalTheme.danger;
  }
  return terminalTheme.muted;
};

const ReportsHeatmap: React.FC<{
  rows: ReturnType<typeof buildReportsDashboardModel>["projectRows"];
  terminalColumns: number;
  page?: number;
}> = ({ rows, terminalColumns, page = 0 }) => {
  const maxRows = terminalColumns < 88 ? 6 : 10;
  const pageCount = Math.max(1, Math.ceil(rows.length / maxRows));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const startIndex = safePage * maxRows;
  const visibleRows = rows.slice(startIndex, startIndex + maxRows);
  if (!visibleRows.length) {
    return <Text dimColor>No project report status data returned.</Text>;
  }

  const statusCell = (status: string, width: number) => {
    const label = compactStatusLabel(status);
    return (
      <Box width={width}>
        <Text color={statusHeatColor(status)}>● </Text>
        <Text wrap="truncate">{truncateForTerminal(label, Math.max(4, width - 2))}</Text>
      </Box>
    );
  };

  const nameWidth = Math.max(18, Math.min(34, Math.floor(terminalColumns * 0.28)));
  const statusWidth = terminalColumns < 100 ? 12 : 16;
  const columns = [
    { key: "costStatus", label: "Cost report" },
    { key: "architectureStatus", label: "WAF report" },
    { key: "unitTestsStatus", label: "Tests" },
    { key: "freshness", label: "Freshness" },
  ] as const;
  return (
    <Box flexDirection="column" gap={1}>
      <Text dimColor wrap="wrap">
        Each row shows whether the selected project has generated report artifacts and whether they are current.
      </Text>
      <Text dimColor>
        <Text color={terminalTheme.success}>● ready</Text>
        <Text>  </Text>
        <Text color={terminalTheme.warning}>● running/partial/stale</Text>
        <Text>  </Text>
        <Text color={terminalTheme.danger}>● failed/missing/outdated</Text>
      </Text>
      <Box flexDirection="row">
        <Box width={nameWidth}><Text color={terminalTheme.brand} bold>Project</Text></Box>
        {columns.map((column) => (
          <Box key={column.key} width={statusWidth}>
            <Text color={terminalTheme.brand} bold>{column.label}</Text>
          </Box>
        ))}
        <Text color={terminalTheme.brand} bold>Critical issues</Text>
      </Box>
      {visibleRows.map((row) => (
        <Box key={row.projectId} flexDirection="row">
          <Box width={nameWidth}>
            <Text wrap="truncate">{row.projectName}</Text>
          </Box>
          {columns.map((column) => {
            const status = row[column.key];
            return (
              <React.Fragment key={column.key}>
                {statusCell(status, statusWidth)}
              </React.Fragment>
            );
          })}
          <Text color={row.criticalIssues ? terminalTheme.danger : terminalTheme.success}>
            {row.criticalIssues}
          </Text>
        </Box>
      ))}
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor>rows {startIndex + 1}-{startIndex + visibleRows.length} of {rows.length}</Text>
        <Text dimColor>page {safePage + 1}/{pageCount} | [ prev | ] next | D download</Text>
      </Box>
    </Box>
  );
};

const ReportRunActions: React.FC<{ compact: boolean }> = ({ compact }) => (
  <Box flexDirection="column" gap={1}>
    <Text dimColor wrap="wrap">
      Run report generation directly through backend report APIs using the selected project context.
    </Text>
    <Box flexDirection="row" gap={1} flexWrap="wrap">
      {[
        ["W", "Well-Architected"],
        ["K", "Cost"],
        ["U", "Unit tests"],
        ["A", "All reports"],
        ["O", "Open frontend"],
      ].map(([keyName, label]) => (
        <Box
          key={keyName}
          borderStyle={raisedButtonStyle.border}
          borderColor={terminalTheme.muted}
          paddingX={1}
          minWidth={compact ? undefined : 18}
        >
          <Text>
            <Text color={terminalTheme.brand} bold>{keyName}</Text>
            <Text> {label}</Text>
          </Text>
        </Box>
      ))}
    </Box>
  </Box>
);

const ProjectDropdownButton: React.FC<{ projectName: string; compact: boolean }> = ({
  projectName,
  compact,
}) => (
  <Box
    borderStyle={raisedButtonStyle.border}
    borderColor={terminalTheme.brand}
    paddingX={1}
    minWidth={compact ? undefined : 28}
  >
    <Text color={terminalTheme.brand} bold wrap="truncate">
      {raisedButtonStyle.activeMarker} Project [{truncateForTerminal(projectName, compact ? 28 : 36)}] ▾
    </Text>
  </Box>
);

const ReportsView: React.FC<{
  state: WorkspacePanelState;
  projects: Project[];
  selectedProject: Project | null;
  compact: boolean;
  terminalColumns: number;
  tablePage: number;
}> = ({ state, projects, selectedProject, compact, terminalColumns, tablePage }) => {
  const model = buildReportsDashboardModel({
    dashboard: state.data.dashboard,
    reportsSummary: state.data.reportsSummary,
    selectedProject,
    costReport: state.data.costReport,
    wafReport: state.data.wafReport,
  });
  const barWidth = compact ? Math.max(14, terminalColumns - 42) : 24;
  const chartWidth = compact ? Math.max(24, terminalColumns - 28) : 42;
  const selectedSummary = model.selectedProjectSummary;
  const selectedStatuses = selectedSummary.reportStatuses;
  const hasReportData = Boolean(toRecord(state.data.reportsSummary));

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection={compact ? "column" : "row"} justifyContent="space-between" gap={1}>
        <Box flexDirection="column" flexShrink={1}>
          <Text bold>Reports home</Text>
          <Text dimColor wrap="wrap">
            Portfolio summary, score signals, report health, and selected project drilldown.
          </Text>
        </Box>
        <Box flexDirection="column">
          <ProjectDropdownButton
            projectName={selectedProject?.name ?? selectedSummary.projectName}
            compact={compact}
          />
          <Text dimColor>Press P or Enter to choose project</Text>
        </Box>
      </Box>

      {!hasReportData ? (
        <Text dimColor>No report summary returned yet. Generate a report or refresh this tab.</Text>
      ) : null}

      <MetricStrip metrics={model.metrics} compact={compact} />

      <SectionCard title="Run reports">
        <ReportRunActions compact={compact} />
      </SectionCard>

      <SectionCard title="Project report status">
        <ReportsHeatmap
          rows={model.projectRows}
          terminalColumns={terminalColumns}
          page={tablePage}
        />
      </SectionCard>

      <Box flexDirection={compact ? "column" : "row"} gap={2}>
        <Box flexDirection="column" gap={1} flexGrow={1}>
          <SectionCard title="Portfolio coverage">
            <Box flexDirection="row" gap={1}>
              <Text wrap="truncate">{model.coverageLabel}</Text>
              <Bar value={model.coverageRatio} width={compact ? 16 : 24} tone="success" />
              <Text>{formatPercent(model.coverageRatio)}</Text>
            </Box>
            <Box marginTop={1}>
              <TrendSummary trend={model.activityTrend} width={chartWidth} />
            </Box>
          </SectionCard>
          <SectionCard title="Report types">
            <BarList
              bars={model.reportTypeBars}
              width={barWidth}
              emptyLabel="No report type counts returned."
            />
          </SectionCard>
        </Box>
        <Box flexDirection="column" gap={1} flexGrow={1}>
          <SectionCard title="Report pipeline">
            <BarList
              bars={model.statusBars}
              width={barWidth}
              emptyLabel="No report status breakdown returned."
            />
          </SectionCard>
          <SectionCard title="Freshness">
            <BarList
              bars={model.freshnessBars}
              width={barWidth}
              emptyLabel="No report freshness breakdown returned."
            />
          </SectionCard>
        </Box>
      </Box>

      <SectionCard title="Project reports">
        <Box flexDirection={compact ? "column" : "row"} justifyContent="space-between" gap={1}>
          <Box flexDirection="column" flexShrink={1}>
            <Text bold wrap="truncate">{selectedSummary.projectName}</Text>
            {selectedSummary.projectId ? (
              <Text dimColor wrap="truncate">{selectedSummary.projectId}</Text>
            ) : (
              <Text dimColor>Select a project to load cost and architecture report details.</Text>
            )}
          </Box>
          {selectedSummary.lastReportAt ? (
            <Text dimColor>last report {selectedSummary.lastReportAt}</Text>
          ) : null}
        </Box>
        <Box marginTop={1}>
          <MetricStrip metrics={selectedSummary.metrics} compact={compact} />
        </Box>
        {selectedStatuses ? (
          <Box flexDirection={compact ? "column" : "row"} gap={1} marginTop={1}>
            <Text>
              <Text dimColor>Cost </Text>
              <Text color={statusTextColor(selectedStatuses.cost ?? "")}>
                {compactStatusLabel(selectedStatuses.cost ?? "not_started")}
              </Text>
            </Text>
            <Text>
              <Text dimColor>Architecture </Text>
              <Text color={statusTextColor(selectedStatuses.architecture ?? "")}>
                {compactStatusLabel(selectedStatuses.architecture ?? "not_started")}
              </Text>
            </Text>
            <Text>
              <Text dimColor>Unit tests </Text>
              <Text color={statusTextColor(selectedStatuses.unitTests ?? "")}>
                {compactStatusLabel(selectedStatuses.unitTests ?? "not_started")}
              </Text>
            </Text>
          </Box>
        ) : null}
        <Box marginTop={1}>
          <BarList
            bars={selectedSummary.pillarScores}
            width={barWidth}
            emptyLabel="No Well-Architected pillar scores returned for this project."
          />
        </Box>
      </SectionCard>

      {model.projectRows.length ? (
        <SectionCard title="Project health">
          <ResponsiveTable
            terminalColumns={terminalColumns}
            columns={["", "Project", "Cost", "Architecture", "Fresh", "Coverage", "Critical"]}
            rows={model.projectRows.map((row) => ({
              "": row.isSelected ? ">" : "",
              Project: row.projectName,
              Cost: compactStatusLabel(row.costStatus),
              Architecture: compactStatusLabel(row.architectureStatus),
              Fresh: compactStatusLabel(row.freshness),
              Coverage: `${row.coveragePercent}%`,
              Critical: row.criticalIssues,
            }))}
            page={tablePage}
          />
        </SectionCard>
      ) : null}

      {model.topActions.length ? (
        <SectionCard title="Top actions">
          <ResponsiveTable
            terminalColumns={terminalColumns}
            columns={["#", "Action", "Issues", "Pillar", "Priority"]}
            rows={model.topActions.map((action, index) => ({
              "#": index + 1,
              Action: action.label,
              Issues: action.issueCount ?? "-",
              Pillar: action.pillar ?? "-",
              Priority: action.priority ?? "-",
            }))}
            page={tablePage}
          />
        </SectionCard>
      ) : null}

      {model.topInsights.length ? (
        <SectionCard title="Key insights">
          <ResponsiveTable
            terminalColumns={terminalColumns}
            columns={["#", "Insight"]}
            rows={model.topInsights.map((insight, index) => ({
              "#": index + 1,
              Insight: insight,
            }))}
            page={tablePage}
          />
        </SectionCard>
      ) : null}

      {projects.length && !model.projectRows.length ? (
        <Text dimColor>
          {projects.length} project(s) available. Pick a project from the dropdown to inspect specific reports.
        </Text>
      ) : null}
    </Box>
  );
};

const OverviewView: React.FC<{
  state: WorkspacePanelState;
  projects: Project[];
  selectedProject: Project | null;
  compact: boolean;
  terminalColumns: number;
  tablePage: number;
}> = ({ state, projects, selectedProject, compact, terminalColumns, tablePage }) => {
  const connections = directArray(state.data.connections);
  const model: OverviewDashboardModel = buildOverviewDashboardModel({
    dashboard: state.data.dashboard,
    reportsSummary: state.data.reportsSummary,
    fallbackProjectCount: projects.length,
    fallbackConnectionCount: connections.length,
  });
  const chartWidth = compact ? Math.max(24, terminalColumns - 28) : 42;
  const barWidth = compact ? Math.max(14, terminalColumns - 42) : 24;
  return (
    <Box flexDirection="column" gap={1}>
      <MetricStrip metrics={model.metrics} compact={compact} />
      <Text wrap="wrap">
        Project: {selectedProject?.name ?? "none"}{" "}
        <Text dimColor>{selectedProject?.id ? `(${selectedProject.id})` : ""}</Text>
      </Text>
      <Box flexDirection={compact ? "column" : "row"} gap={2}>
        <Box flexDirection="column" gap={1} flexGrow={1}>
          <SectionCard title="Trends">
            <TrendSummary trend={model.trends.score} width={chartWidth} />
            <Box marginTop={1}>
              <TrendSummary trend={model.trends.cost} width={chartWidth} />
            </Box>
            <Box marginTop={1}>
              <TrendSummary trend={model.trends.reports} width={chartWidth} />
            </Box>
          </SectionCard>
        </Box>
        <Box flexDirection="column" gap={1} flexGrow={1}>
          <SectionCard title="Architecture scores">
            <BarList
              bars={model.pillarScores}
              width={barWidth}
              emptyLabel="No pillar scores returned by /dashboard/user."
            />
          </SectionCard>
        </Box>
      </Box>
      <Box flexDirection={compact ? "column" : "row"} gap={2}>
        <Box flexDirection="column" gap={1} flexGrow={1}>
          <SectionCard title="Issues by pillar">
            <BarList
              bars={model.issuesByPillar}
              width={barWidth}
              emptyLabel="No issue breakdown returned by /dashboard/user."
            />
          </SectionCard>
          <SectionCard title="Project health">
            <BarList
              bars={model.projectHealth}
              width={barWidth}
              emptyLabel="No project health data returned."
            />
          </SectionCard>
        </Box>
        <Box flexDirection="column" gap={1} flexGrow={1}>
          <SectionCard title="Monthly cost by service">
            <BarList
              bars={model.serviceCosts}
              width={barWidth}
              emptyLabel="No service cost breakdown returned."
            />
          </SectionCard>
          <SectionCard title="Report pipeline">
            <BarList
              bars={model.reportStatus}
              width={barWidth}
              emptyLabel="No report status breakdown returned."
            />
          </SectionCard>
        </Box>
      </Box>
      <SectionCard title="Report freshness">
        <BarList
          bars={model.reportFreshness}
          width={compact ? Math.max(14, terminalColumns - 42) : 36}
          emptyLabel="No report freshness breakdown returned."
        />
      </SectionCard>
      {model.topActions.length ? (
        <SectionCard title="Top actions">
          <ResponsiveTable
            terminalColumns={terminalColumns}
            columns={["#", "Action", "Issues", "Pillar", "Priority"]}
            rows={model.topActions.map((action, index) => ({
              "#": index + 1,
              Action: action.label,
              Issues: action.issueCount ?? "-",
              Pillar: action.pillar ?? "-",
              Priority: action.priority ?? "-",
            }))}
            page={tablePage}
          />
        </SectionCard>
      ) : null}
      {model.topRecommendations.length ? (
        <SectionCard title="Recommendations">
          <ResponsiveTable
            terminalColumns={terminalColumns}
            columns={["#", "Recommendation", "Impact", "Pillar"]}
            rows={model.topRecommendations.map((recommendation, index) => ({
              "#": index + 1,
              Recommendation: recommendation.label,
              Impact: recommendation.impact ?? "-",
              Pillar: recommendation.pillar ?? "-",
            }))}
            page={tablePage}
          />
        </SectionCard>
      ) : null}
      {model.topInsights.length ? (
        <SectionCard title="Key insights">
          <ResponsiveTable
            terminalColumns={terminalColumns}
            columns={["#", "Insight"]}
            rows={model.topInsights.map((insight, index) => ({
              "#": index + 1,
              Insight: insight,
            }))}
            page={tablePage}
          />
        </SectionCard>
      ) : null}
    </Box>
  );
};

const OptionsView: React.FC<WorkspacePanelProps> = ({
  selectedProject,
  selectedModel,
  selectedMode,
  currentUserId,
  apiBase,
  frontendUrl,
}) => {
  const keys = getTuiKeyBindings();
  return (
    <Box flexDirection="column" gap={1}>
      <MetricStrip
        compact={false}
        metrics={[
          { label: "Project", value: selectedProject?.name ?? "none" },
          { label: "Model", value: selectedModel || "auto" },
          { label: "Mode", value: selectedMode },
        ]}
      />
      <Text wrap="wrap">User: {currentUserId ?? "unknown"}</Text>
      <Text wrap="wrap">API: {apiBase}</Text>
      <Text wrap="wrap">Frontend: {frontendUrl}</Text>
      <Text dimColor wrap="wrap">
        Keys: 1-{workspaceTabs.length} jump tabs | {keys.tabSwitch} tabs | {keys.refresh} | {keys.open} | Ctrl+Q quit
      </Text>
    </Box>
  );
};

const HelpView: React.FC = () => {
  const keys = getTuiKeyBindings();
  const cliCommands = [
    "cloudeval - open the Terminal UI",
    "cloudeval tui --tab <tab> - open a specific TUI tab",
    "cloudeval chat - start an interactive chat session",
    "cloudeval ask <question> - run a one-shot prompt",
    "cloudeval projects - list, create, and inspect projects",
    "cloudeval connections - list configured cloud connections",
    "cloudeval reports - list, show, download, cost, and WAF reports",
    "cloudeval billing - inspect plans, usage, invoices, ledgers, and top-ups",
    "cloudeval open <target> - open frontend deep links",
    "cloudeval capabilities - print agent and frontend capability details",
    "cloudeval login|logout|auth status - manage authentication",
    "cloudeval completion <shell> - install shell completion",
    "cloudeval banner - print the ASCII banner",
  ];
  return (
    <Box flexDirection="column" gap={1}>
      <SectionCard title="Navigation" borderColor={terminalTheme.brand}>
        <HelpLegend includeQuit wrap />
        <Text wrap="wrap">
          {keys.mouse} | {keys.scroll}
        </Text>
      </SectionCard>
      <SectionCard title="Prompt Input" borderColor={terminalTheme.brand}>
        <Text wrap="wrap">
          {keys.submit} | {keys.newline} | {keys.commandComplete} | {keys.historySearch} | {keys.cancel} | {keys.quit}
        </Text>
      </SectionCard>
      <SectionCard title="Slash Commands" borderColor={terminalTheme.brand}>
        {slashCommands.map((command) => (
          <Text key={command.name} wrap="wrap">
            {command.name.padEnd(10)} {command.description}
          </Text>
        ))}
      </SectionCard>
      <SectionCard title="CLI Commands" borderColor={terminalTheme.muted}>
        {cliCommands.map((command) => (
          <Text key={command} wrap="wrap">
            {command}
          </Text>
        ))}
        <Text dimColor wrap="wrap">
          Common flags: --base-url, --api-key, --api-key-stdin, --machine, --frontend-url, --format, --json, --verbose, --help
        </Text>
      </SectionCard>
    </Box>
  );
};

export const WorkspaceTabBar: React.FC<{
  activeTab: WorkspaceTab;
  showBrand?: boolean;
  billingSummary?: BillingSummaryState | null;
}> = ({ activeTab, showBrand = false, billingSummary }) => {
  return (
    <Box flexDirection="column" gap={0}>
      {showBrand ? (
        <TitledBox
          title="Console"
          flexDirection="row"
          justifyContent="space-between"
          borderStyle="round"
          borderColor={terminalTheme.muted}
          padding={0}
          paddingX={1}
        >
          <Box flexDirection="row" gap={1}>
            <Text bold color={terminalTheme.brand}>CloudEval</Text>
            <Text dimColor>agent console</Text>
          </Box>
        </TitledBox>
      ) : null}
      <Box flexDirection="row" gap={0} flexWrap="wrap">
        {workspaceTabs.map((tab) => {
          const active = tab === activeTab;
          return (
            <Box
              key={tab}
              borderStyle={active ? "bold" : raisedButtonStyle.border}
              borderColor={active ? terminalTheme.brand : terminalTheme.muted}
              paddingX={1}
              marginRight={1}
            >
              <Text
                bold={active}
                color={active ? terminalTheme.brand : undefined}
              >
                {active ? raisedButtonStyle.activeMarker : raisedButtonStyle.inactiveMarker}{" "}
                {workspaceTabButtonLabel(tab)}
              </Text>
            </Box>
          );
        })}
      </Box>
      <HelpLegend />
      {billingSummary ? (
        <BillingSummaryLine billing={billingSummary} />
      ) : null}
    </Box>
  );
};

export const WorkspacePanel: React.FC<WorkspacePanelProps> = (props) => {
  const compact = props.terminalColumns < 88;
  const state = props.state;
  const connections = directArray(state.data.connections);
  const isInitialLoading = state.status === "loading";
  const isBackgroundRefreshing = Boolean(state.isRefreshing && !isInitialLoading);

  return (
    <TitledBox
      title={workspaceTabLabels[props.tab]}
      borderStyle="round"
      borderColor={terminalTheme.muted}
      padding={1}
      gap={1}
    >
      {state.loadedAt && !isInitialLoading && !isBackgroundRefreshing ? (
        <Box flexDirection="row" justifyContent="flex-end">
          <Text dimColor>loaded {new Date(state.loadedAt).toLocaleTimeString()}</Text>
        </Box>
      ) : null}
      {isInitialLoading ? (
        <Box flexDirection="row" gap={1}>
          <Spinner type="dots" />
          <Text color={terminalTheme.brand}>Loading real API data...</Text>
        </Box>
      ) : null}
      {isBackgroundRefreshing ? (
        <Box flexDirection="row" gap={1}>
          <Spinner type="dots" />
          <Text color={terminalTheme.brand}>Refreshing in background, showing cached data...</Text>
        </Box>
      ) : null}
      {state.status === "error" ? (
        <TitledBox
          title="Backend Data Unavailable"
          borderStyle="single"
          borderColor={terminalTheme.danger}
          padding={0}
          paddingX={1}
        >
          <Text color={terminalTheme.danger} wrap="wrap">
            {" "}{state.error ?? "Unable to load this tab."}
          </Text>
        </TitledBox>
      ) : null}
      {state.warnings.length ? (
        <TitledBox
          title="Backend Warnings"
          borderStyle="single"
          borderColor={terminalTheme.warning}
          padding={0}
          paddingX={1}
        >
          {state.warnings.slice(0, 4).map((warning) => (
            <Text key={warning} color={terminalTheme.warning} wrap="truncate">
              {cleanBackendWarning(warning, props.terminalColumns)}
            </Text>
          ))}
          {state.warnings.length > 4 ? (
            <Text dimColor>+{state.warnings.length - 4} more warning(s)</Text>
          ) : null}
        </TitledBox>
      ) : null}
      {props.tab === "overview" ? (
        <OverviewView
          state={state}
          projects={props.projects}
          selectedProject={props.selectedProject}
          compact={compact}
          terminalColumns={props.terminalColumns}
          tablePage={props.tablePage}
        />
      ) : null}
      {props.tab === "reports" ? (
        <ReportsView
          state={state}
          projects={props.projects}
          selectedProject={props.selectedProject}
          compact={compact}
          terminalColumns={props.terminalColumns}
          tablePage={props.tablePage}
        />
      ) : null}
      {props.tab === "projects" ? (
        <ProjectsView projects={props.projects} selectedProject={props.selectedProject} />
      ) : null}
      {props.tab === "connections" ? <ConnectionsView connections={connections} /> : null}
      {props.tab === "billing" ? (
        <BillingView
          state={state}
          compact={compact}
          terminalColumns={props.terminalColumns}
          frontendUrl={props.frontendUrl}
        />
      ) : null}
      {props.tab === "options" ? <OptionsView {...props} /> : null}
      {props.tab === "help" ? <HelpView /> : null}
    </TitledBox>
  );
};

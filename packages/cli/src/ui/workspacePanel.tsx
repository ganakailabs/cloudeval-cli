import React from "react";
import { Box, Text } from "ink";
import { plot as plotAsciiChart } from "asciichart";
import type { Project } from "@cloudeval/core";
import { truncateForTerminal } from "./layout.js";
import {
  buildOverviewDashboardModel,
  type OverviewBar,
  type OverviewDashboardModel,
  type OverviewTone,
  type OverviewTrend,
} from "./overviewDashboard.js";
import { raisedButtonStyle, terminalTheme } from "./theme.js";
import {
  workspaceTabButtonContent,
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
}

type Metric = {
  label: string;
  value: string;
  tone?: OverviewTone;
};

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
        <Text dimColor> single point</Text>
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
    firstString(record, ["effective_status", "status", "outcome"], ""),
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
  return (
    <Text color={metricColor(tone) ?? terminalTheme.brand}>
      {"█".repeat(filled)}
      <Text dimColor>{"░".repeat(width - filled)}</Text>
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
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={labelWidth}>
          <Text bold wrap="truncate">{truncateForTerminal(trend.label, labelWidth - 1)}</Text>
        </Box>
        <Text color={metricColor(trend.tone)}>{trend.summary}</Text>
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
  <Box flexDirection="column" borderStyle="round" borderColor={borderColor ?? terminalTheme.muted} paddingX={1}>
    <Text bold color={borderColor ?? undefined}>
      {title}
    </Text>
    <Box flexDirection="column" marginTop={1}>
      {children}
    </Box>
  </Box>
);

const MetricStrip: React.FC<{ metrics: Metric[]; compact: boolean }> = ({ metrics, compact }) => (
  <Box flexDirection={compact ? "column" : "row"} gap={1} flexWrap="wrap">
    {metrics.map((metric) => (
      <Box
        key={metric.label}
        flexDirection="column"
        borderStyle="round"
        borderColor={metricColor(metric.tone) ?? terminalTheme.muted}
        paddingX={1}
        minWidth={compact ? undefined : 15}
      >
        <Text dimColor>{metric.label}</Text>
        <Text bold color={metricColor(metric.tone)}>{metric.value}</Text>
      </Box>
    ))}
  </Box>
);

const statusColor = (status?: string): string | undefined => {
  if (!status) return terminalTheme.muted;
  if (["ready", "complete", "idle"].includes(status)) return terminalTheme.success;
  if (["loading", "connecting", "thinking", "streaming", "tool_running"].includes(status)) {
    return terminalTheme.brand;
  }
  if (["hitl_waiting", "canceled"].includes(status)) return terminalTheme.warning;
  if (status === "error") return terminalTheme.danger;
  return terminalTheme.muted;
};

const statusLabel = (status?: string): string => {
  if (!status) return "idle";
  return status.replace(/_/g, " ");
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
}> = ({ state, compact, terminalColumns }) => {
  const creditStatus = toRecord(state.data.creditStatus);
  const entitlement = toRecord(state.data.entitlement);
  const plan = toRecord(entitlement?.plan);
  const usageValues = allNumbers(state.data.usageSummary);
  const ledger = directArray(state.data.ledger);
  const invoices = directArray(state.data.billingInfo);
  const topups = directArray(state.data.topups);
  const notifications = directArray(state.data.notifications);
  const remainingRatio = firstNumber(creditStatus, ["remainingRatio"]);
  const tone = firstString(creditStatus, ["tone"], "normal") as Metric["tone"];
  const metrics: Metric[] = [
    { label: "Plan", value: firstString(creditStatus, ["planName"], firstString(plan, ["name"], "-")) },
    { label: "Remaining", value: formatNumber(firstNumber(creditStatus, ["remaining"])) },
    { label: "Used", value: formatNumber(firstNumber(creditStatus, ["used"])) },
    { label: "Top-up", value: formatNumber(firstNumber(creditStatus, ["topUpBalance"])) },
    { label: "Status", value: firstString(entitlement, ["effective_status"], "-"), tone },
  ];
  return (
    <Box flexDirection="column" gap={1}>
      <MetricStrip metrics={metrics} compact={compact} />
      <Box flexDirection="row" gap={1}>
        <Text dimColor>Credit balance</Text>
        <Bar value={remainingRatio} tone={tone} />
        <Text>{formatPercent(remainingRatio)}</Text>
      </Box>
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

const ReportsView: React.FC<{
  state: WorkspacePanelState;
  terminalColumns: number;
}> = ({ state, terminalColumns }) => (
  <Box flexDirection="column" gap={1}>
    <ResourceSummary
      label="Reports summary"
      value={state.data.reportsSummary}
      terminalColumns={terminalColumns}
    />
    <ResourceSummary
      label="Cost report"
      value={state.data.costReport}
      terminalColumns={terminalColumns}
    />
    <ResourceSummary
      label="Well-Architected report"
      value={state.data.wafReport}
      terminalColumns={terminalColumns}
    />
  </Box>
);

const OverviewView: React.FC<{
  state: WorkspacePanelState;
  projects: Project[];
  selectedProject: Project | null;
  compact: boolean;
  terminalColumns: number;
}> = ({ state, projects, selectedProject, compact, terminalColumns }) => {
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
          <SectionCard title="Trends" borderColor={terminalTheme.brand}>
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
          <SectionCard title="Architecture scores" borderColor={terminalTheme.success}>
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
          <SectionCard title="Issues by pillar" borderColor={terminalTheme.warning}>
            <BarList
              bars={model.issuesByPillar}
              width={barWidth}
              emptyLabel="No issue breakdown returned by /dashboard/user."
            />
          </SectionCard>
          <SectionCard title="Project health" borderColor={terminalTheme.success}>
            <BarList
              bars={model.projectHealth}
              width={barWidth}
              emptyLabel="No project health data returned."
            />
          </SectionCard>
        </Box>
        <Box flexDirection="column" gap={1} flexGrow={1}>
          <SectionCard title="Monthly cost by service" borderColor={terminalTheme.warning}>
            <BarList
              bars={model.serviceCosts}
              width={barWidth}
              emptyLabel="No service cost breakdown returned."
            />
          </SectionCard>
          <SectionCard title="Report pipeline" borderColor={terminalTheme.brand}>
            <BarList
              bars={model.reportStatus}
              width={barWidth}
              emptyLabel="No report status breakdown returned."
            />
          </SectionCard>
        </Box>
      </Box>
      <SectionCard title="Report freshness" borderColor={terminalTheme.danger}>
        <BarList
          bars={model.reportFreshness}
          width={compact ? Math.max(14, terminalColumns - 42) : 36}
          emptyLabel="No report freshness breakdown returned."
        />
      </SectionCard>
      {model.topActions.length ? (
        <Box flexDirection="column">
          <Text bold>Top Actions</Text>
          {model.topActions.map((action, index) => (
            <Text
              key={`${action.label}-${index}`}
              color={metricColor(action.priority === "urgent" ? "danger" : action.priority === "high" ? "warning" : "normal")}
              wrap="truncate"
            >
              {index + 1}. {truncateForTerminal(action.label, Math.max(32, terminalColumns - 22))}
              {action.issueCount !== undefined ? ` | ${action.issueCount} issue(s)` : ""}
              {action.pillar ? ` | ${action.pillar}` : ""}
            </Text>
          ))}
        </Box>
      ) : null}
      {model.topInsights.length ? (
        <Box flexDirection="column">
          <Text bold>Key Insights</Text>
          {model.topInsights.map((insight, index) => (
            <Text key={`${insight}-${index}`} wrap="wrap">
              {index + 1}. {insight}
            </Text>
          ))}
        </Box>
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
}) => (
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
    <Text dimColor>Keys: 1-7 jump tabs | Left/Right switch tabs | R refresh | O open frontend | Ctrl+Q quit</Text>
  </Box>
);

export const WorkspaceTabBar: React.FC<{
  activeTab: WorkspaceTab;
  activeStatus?: string;
  showBrand?: boolean;
}> = ({ activeTab, activeStatus, showBrand = false }) => (
  <Box flexDirection="column" gap={1}>
    {showBrand ? (
      <Box
        flexDirection="row"
        justifyContent="space-between"
        borderStyle="round"
        borderColor={terminalTheme.muted}
        paddingX={1}
      >
        <Box flexDirection="row" gap={1}>
          <Text bold color={terminalTheme.brand}>CloudEval</Text>
          <Text dimColor>agent console</Text>
        </Box>
        <Text color={statusColor(activeStatus)}>
          ● {statusLabel(activeStatus)}
        </Text>
      </Box>
    ) : null}
    <Box flexDirection="row" gap={1} flexWrap="wrap">
      {workspaceTabs.map((tab) => {
        const active = tab === activeTab;
        return (
          <Box
            key={tab}
            borderStyle={raisedButtonStyle.border}
            borderColor={active ? terminalTheme.brand : terminalTheme.muted}
            paddingX={1}
          >
            <Text
              bold={active}
              color={active ? terminalTheme.brand : undefined}
              inverse={active}
            >
              {active ? raisedButtonStyle.activeMarker : raisedButtonStyle.inactiveMarker}{" "}
              {workspaceTabButtonLabel(tab)}
            </Text>
          </Box>
        );
      })}
    </Box>
    <Box flexDirection="row" justifyContent="space-between">
      <Text dimColor wrap="truncate">
        1-7 tabs | L/R switch | R refresh | O open
      </Text>
      <Text color={statusColor(activeStatus)} wrap="truncate">
        {workspaceTabButtonContent(activeTab, true)} · {statusLabel(activeStatus)}
      </Text>
    </Box>
  </Box>
);

export const WorkspacePanel: React.FC<WorkspacePanelProps> = (props) => {
  const compact = props.terminalColumns < 88;
  const state = props.state;
  const connections = directArray(state.data.connections);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={terminalTheme.muted} padding={1} gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={terminalTheme.brand}>
          {workspaceTabLabels[props.tab]}
        </Text>
        <Text dimColor>
          {state.status === "loading"
            ? "loading real API data"
            : state.loadedAt
              ? `loaded ${new Date(state.loadedAt).toLocaleTimeString()}`
              : "not loaded"}
        </Text>
      </Box>
      {state.status === "loading" ? <Text dimColor>Fetching backend data...</Text> : null}
      {state.status === "error" ? (
        <Box borderStyle="single" borderColor={terminalTheme.danger} paddingX={1}>
          <Text color={terminalTheme.danger} bold>Backend data unavailable</Text>
          <Text color={terminalTheme.danger} wrap="wrap">
            {" "}{state.error ?? "Unable to load this tab."}
          </Text>
        </Box>
      ) : null}
      {state.warnings.length ? (
        <Box flexDirection="column" borderStyle="single" borderColor={terminalTheme.warning} paddingX={1}>
          <Text bold color={terminalTheme.warning}>Backend warnings</Text>
          {state.warnings.slice(0, 4).map((warning) => (
            <Text key={warning} color={terminalTheme.warning} wrap="truncate">
              {cleanBackendWarning(warning, props.terminalColumns)}
            </Text>
          ))}
          {state.warnings.length > 4 ? (
            <Text dimColor>+{state.warnings.length - 4} more warning(s)</Text>
          ) : null}
        </Box>
      ) : null}
      {props.tab === "overview" ? (
        <OverviewView
          state={state}
          projects={props.projects}
          selectedProject={props.selectedProject}
          compact={compact}
          terminalColumns={props.terminalColumns}
        />
      ) : null}
      {props.tab === "reports" ? (
        <ReportsView state={state} terminalColumns={props.terminalColumns} />
      ) : null}
      {props.tab === "projects" ? (
        <ProjectsView projects={props.projects} selectedProject={props.selectedProject} />
      ) : null}
      {props.tab === "connections" ? <ConnectionsView connections={connections} /> : null}
      {props.tab === "billing" ? (
        <BillingView state={state} compact={compact} terminalColumns={props.terminalColumns} />
      ) : null}
      {props.tab === "options" ? <OptionsView {...props} /> : null}
      <Text dimColor>
        1-7 tabs | Left/Right switch | R refresh | O open frontend | Ctrl+Q quit
      </Text>
    </Box>
  );
};

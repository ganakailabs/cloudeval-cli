import React, { useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import {
  type CostParsedReport,
  type ReportEnvelope,
  type ReportFormatMode,
  type WafParsedReport,
} from "@cloudeval/shared";
import { terminalTheme } from "../ui/theme.js";

export interface ReportDashboardProps {
  report: ReportEnvelope;
  initialMode?: ReportFormatMode | "overview";
}

const modeOrder: Array<ReportFormatMode | "overview"> = [
  "overview",
  "formatted",
  "parsed",
  "raw",
];

const isCostReport = (
  report: ReportEnvelope
): report is ReportEnvelope<unknown, CostParsedReport> => report.kind === "cost";

const isWafReport = (
  report: ReportEnvelope
): report is ReportEnvelope<unknown, WafParsedReport> => report.kind === "waf";

const formatCurrency = (amount: number, currency = "USD") => {
  const prefix = currency === "USD" ? "$" : `${currency} `;
  return amount >= 1000 ? `${prefix}${(amount / 1000).toFixed(1)}k` : `${prefix}${amount}`;
};

const truncate = (value: string, width: number) =>
  value.length > width ? `${value.slice(0, Math.max(0, width - 3))}...` : value;

const statusColor = (status: string) => {
  if (status === "pass" || status === "ok") return terminalTheme.success;
  if (status === "fail" || status === "over") return terminalTheme.danger;
  return terminalTheme.warning;
};

const Panel: React.FC<{
  title: string;
  label?: string;
  children: React.ReactNode;
}> = ({ title, label, children }) => (
  <Box flexDirection="column" borderStyle="single" borderColor={terminalTheme.muted} paddingX={1}>
    <Box justifyContent="space-between">
      <Text bold>{title}</Text>
      {label ? <Text color={terminalTheme.accent}>{label}</Text> : null}
    </Box>
    <Box marginTop={1} flexDirection="column">
      {children}
    </Box>
  </Box>
);

const Metric: React.FC<{ label: string; value: string; note?: string; color?: string }> = ({
  label,
  value,
  note,
  color,
}) => (
  <Box flexDirection="column" borderStyle="single" borderColor={terminalTheme.muted} paddingX={1} minWidth={22}>
    <Text dimColor>{label}</Text>
    <Text bold color={color}>{value}</Text>
    {note ? <Text dimColor>{note}</Text> : null}
  </Box>
);

const Bar: React.FC<{ value: number; max?: number; color?: string; width?: number }> = ({
  value,
  max = 100,
  color,
  width = 24,
}) => {
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return (
    <Text color={color}>
      {"█".repeat(filled)}
      <Text dimColor>{"░".repeat(width - filled)}</Text>
    </Text>
  );
};

const JsonBlock: React.FC<{ value: unknown }> = ({ value }) => (
  <Text wrap="wrap">{JSON.stringify(value, null, 2)}</Text>
);

const FormattedBlock: React.FC<{ report: ReportEnvelope }> = ({ report }) => {
  const formatted = report.formatted;
  if (!formatted) {
    return <Text dimColor>No formatted report returned. Use parsed/raw view.</Text>;
  }
  return (
    <Box flexDirection="column">
      <Text bold>{formatted.title}</Text>
      <Text wrap="wrap">{formatted.summary}</Text>
      {formatted.sections.map((section) => (
        <Box key={section.id} flexDirection="column" marginTop={1}>
          <Text bold color={terminalTheme.brand}>{section.title}</Text>
          <Text wrap="wrap">{section.markdown}</Text>
        </Box>
      ))}
    </Box>
  );
};

const CostOverview: React.FC<{ report: ReportEnvelope<unknown, CostParsedReport> }> = ({
  report,
}) => {
  const parsed = report.parsed;
  const maxService = Math.max(...parsed.serviceGroups.map((group) => group.amount), 1);
  const compact = (process.stdout.columns || 100) < 110;
  const chartWidth = compact ? 16 : 24;
  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1} flexWrap="wrap">
        <Metric
          label="Monthly spend"
          value={formatCurrency(parsed.totalSpend.amount, parsed.totalSpend.currency)}
          note={`${parsed.totalSpend.changePercent?.toFixed(1) ?? "0"}% vs previous`}
          color={terminalTheme.warning}
        />
        <Metric
          label="Estimated savings"
          value={formatCurrency(parsed.estimatedSavings.amount, parsed.estimatedSavings.currency)}
          note={`${parsed.estimatedSavings.percentOfSpend?.toFixed(1) ?? "0"}% addressable`}
          color={terminalTheme.success}
        />
        <Metric
          label="Anomalies"
          value={String(parsed.anomalies.length)}
          note="spend spikes"
          color={terminalTheme.warning}
        />
      </Box>
      <Box gap={1} flexDirection={compact ? "column" : "row"}>
        <Panel title="Spend mix" label="top services">
          {parsed.serviceGroups.slice(0, 6).map((group) => (
            <Box key={group.name} gap={1}>
              <Text>{truncate(group.name, 12).padEnd(12)}</Text>
              <Bar value={group.amount} max={maxService} color={terminalTheme.brand} width={chartWidth} />
              <Text>{formatCurrency(group.amount, group.currency)}</Text>
            </Box>
          ))}
        </Panel>
        <Panel title="Savings recommendations" label={`${formatCurrency(parsed.estimatedSavings.amount)}/mo`}>
          {parsed.recommendations.slice(0, 5).map((item, index) => (
            <Text key={item.id} wrap="wrap">
              <Text dimColor>{String(index + 1).padStart(2, "0")}. </Text>
              {item.title}{" "}
              <Text color={terminalTheme.success}>
                {formatCurrency(item.monthlySavings, item.currency)}/mo
              </Text>{" "}
              <Text color={statusColor(item.risk)}>risk {item.risk}</Text>
            </Text>
          ))}
        </Panel>
      </Box>
      <Panel title="Budgets" label="usage">
        {parsed.budgets.map((budget) => (
          <Box key={budget.name} gap={1}>
            <Text>{budget.name.padEnd(8)}</Text>
            <Bar value={budget.usedPercent} max={110} color={statusColor(budget.status)} />
            <Text color={statusColor(budget.status)}>{budget.usedPercent}%</Text>
          </Box>
        ))}
      </Panel>
    </Box>
  );
};

const WafOverview: React.FC<{ report: ReportEnvelope<unknown, WafParsedReport> }> = ({
  report,
}) => {
  const parsed = report.parsed;
  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1} flexWrap="wrap">
        <Metric label="WAF score" value={`${parsed.score.overall}/100`} color={terminalTheme.warning} />
        <Metric label="Passed controls" value={String(parsed.counts.passed)} color={terminalTheme.success} />
        <Metric label="High risk" value={String(parsed.counts.highRisk)} color={terminalTheme.danger} />
        <Metric label="Evidence coverage" value={`${parsed.counts.evidenceCoveragePercent}%`} color={terminalTheme.brand} />
      </Box>
      <Panel title="Pillar distribution" label="score">
        {parsed.score.pillars.map((pillar) => (
          <Box key={pillar.id} gap={1}>
            <Text>{truncate(pillar.label, 12).padEnd(12)}</Text>
            <Bar value={pillar.score} color={statusColor(pillar.score < 70 ? "fail" : pillar.score < 80 ? "warn" : "pass")} width={30} />
            <Text>{String(pillar.score).padStart(3)}</Text>
            <Text dimColor>
              {pillar.passed} pass / {pillar.warned} warn / {pillar.failed} fail
            </Text>
          </Box>
        ))}
      </Panel>
      <Panel title="Rule matrix" label="priority">
        {parsed.rules.slice(0, 8).map((rule) => (
          <Box key={rule.id} gap={1}>
            <Text>{rule.id.padEnd(8)}</Text>
            <Text color={statusColor(rule.status)}>{rule.status.padEnd(4)}</Text>
            <Text>{truncate(rule.pillar, 12).padEnd(12)}</Text>
            <Text>{truncate(rule.title, 52)}</Text>
          </Box>
        ))}
      </Panel>
    </Box>
  );
};

export const ReportDashboard: React.FC<ReportDashboardProps> = ({
  report,
  initialMode = "overview",
}) => {
  const { exit } = useApp();
  const [mode, setMode] = useState<ReportFormatMode | "overview">(initialMode);
  const modeIndex = modeOrder.indexOf(mode);
  const generated = useMemo(() => new Date(report.generatedAt).toISOString(), [report.generatedAt]);

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      exit();
      return;
    }
    if (input === "1") setMode("overview");
    if (input === "2") setMode("formatted");
    if (input === "3") setMode("parsed");
    if (input === "4") setMode("raw");
    if (key.leftArrow || key.rightArrow || key.tab) {
      const direction = key.leftArrow ? -1 : 1;
      setMode(modeOrder[(modeIndex + direction + modeOrder.length) % modeOrder.length]);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Box justifyContent="space-between">
        <Text color={terminalTheme.success}>CloudEval {report.kind.toUpperCase()} report</Text>
        <Text dimColor>{report.id}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text dimColor>
          Project {report.projectId} | Generated {generated} | Source {report.source.provider}
        </Text>
        <Text>
          [1] overview [2] formatted [3] parsed [4] raw | q quit
        </Text>
      </Box>
      <Text color={terminalTheme.brand}>View: {mode}</Text>
      {mode === "overview" && isCostReport(report) ? <CostOverview report={report} /> : null}
      {mode === "overview" && isWafReport(report) ? <WafOverview report={report} /> : null}
      {mode === "formatted" ? (
        <Panel title="Formatted report" label="human">
          <FormattedBlock report={report} />
        </Panel>
      ) : null}
      {mode === "parsed" ? (
        <Panel title="Parsed report" label="normalized">
          <JsonBlock value={report.parsed} />
        </Panel>
      ) : null}
      {mode === "raw" ? (
        <Panel title="Raw report" label="provider">
          <JsonBlock value={report.raw} />
        </Panel>
      ) : null}
    </Box>
  );
};

import {
  type CostParsedReport,
  type ReportEnvelope,
  type ReportFormatMode,
  type ReportOutputFormat,
  type WafParsedReport,
} from "@cloudeval/shared";

export interface SerializeReportOptions {
  format: Exclude<ReportOutputFormat, "tui">;
  mode?: ReportFormatMode;
}

const isCostReport = (
  report: ReportEnvelope
): report is ReportEnvelope<unknown, CostParsedReport> => report.kind === "cost";

const isWafReport = (
  report: ReportEnvelope
): report is ReportEnvelope<unknown, WafParsedReport> => report.kind === "waf";

export const selectReportModePayload = (
  report: ReportEnvelope,
  mode: ReportFormatMode = "formatted"
): unknown => {
  if (mode === "raw") {
    return report.raw;
  }
  if (mode === "parsed") {
    return report.parsed;
  }
  return (
    report.formatted ?? {
      title: report.id,
      summary: renderReportSummary(report),
      sections: [],
    }
  );
};

const formatCurrency = (amount: number, currency = "USD"): string => {
  const prefix = currency === "USD" ? "$" : `${currency} `;
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1000) {
    return `${sign}${prefix}${(abs / 1000).toFixed(1)}k`;
  }
  return `${sign}${prefix}${abs.toFixed(0)}`;
};

const formatPercent = (value: number | undefined): string =>
  typeof value === "number" ? `${value.toFixed(1)}%` : "n/a";

const pad = (value: string, width: number): string =>
  value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;

const renderCostSummary = (report: ReportEnvelope<unknown, CostParsedReport>): string => {
  const parsed = report.parsed;
  const lines = [
    `${pad("Report", 20)} ${report.id}`,
    `${pad("Kind", 20)} cost`,
    `${pad("Generated", 20)} ${report.generatedAt}`,
    `${pad("Monthly spend", 20)} ${formatCurrency(parsed.totalSpend.amount, parsed.totalSpend.currency)} (${formatPercent(parsed.totalSpend.changePercent)} vs previous period)`,
    `${pad("Estimated savings", 20)} ${formatCurrency(parsed.estimatedSavings.amount, parsed.estimatedSavings.currency)} (${formatPercent(parsed.estimatedSavings.percentOfSpend)} of spend)`,
    `${pad("Anomalies", 20)} ${parsed.anomalies.length}`,
    "",
    "Top services",
    ...parsed.serviceGroups
      .slice(0, 5)
      .map(
        (group) =>
          `  ${pad(group.name, 14)} ${pad(formatCurrency(group.amount, group.currency), 8)} ${formatPercent(group.changePercent)}`
      ),
    "",
    "Recommendations",
    ...parsed.recommendations
      .slice(0, 5)
      .map(
        (item) =>
          `  ${item.id}: ${item.title} (${formatCurrency(item.monthlySavings, item.currency)}/mo, risk ${item.risk})`
      ),
  ];
  return `${lines.join("\n")}\n`;
};

const renderWafSummary = (report: ReportEnvelope<unknown, WafParsedReport>): string => {
  const parsed = report.parsed;
  const lines = [
    `${pad("Report", 20)} ${report.id}`,
    `${pad("Kind", 20)} waf`,
    `${pad("Generated", 20)} ${report.generatedAt}`,
    `${pad("WAF score", 20)} ${parsed.score.overall}/100`,
    `${pad("Passed controls", 20)} ${parsed.counts.passed}`,
    `${pad("High risk", 20)} ${parsed.counts.highRisk}`,
    `${pad("Medium risk", 20)} ${parsed.counts.mediumRisk}`,
    `${pad("Evidence coverage", 20)} ${parsed.counts.evidenceCoveragePercent}%`,
    "",
    "Pillars",
    ...parsed.score.pillars.map(
      (pillar) =>
        `  ${pad(pillar.label, 14)} ${pad(String(pillar.score), 4)} ${pillar.passed} pass / ${pillar.warned} warn / ${pillar.failed} fail`
    ),
    "",
    "Rules",
    ...parsed.rules
      .slice(0, 8)
      .map(
        (rule) =>
          `  ${rule.id} ${pad(rule.status, 4)} ${pad(rule.severity, 8)} ${rule.title}`
      ),
  ];
  return `${lines.join("\n")}\n`;
};

export const renderReportSummary = (report: ReportEnvelope): string => {
  if (isCostReport(report)) {
    return renderCostSummary(report);
  }
  if (isWafReport(report)) {
    return renderWafSummary(report);
  }
  return `${report.id}\n${report.formatted?.summary ?? ""}\n`;
};

export const renderReportMarkdown = (report: ReportEnvelope): string => {
  const formatted = report.formatted;
  if (!formatted) {
    return `# ${report.id}\n\n${renderReportSummary(report)}`;
  }

  const sections = formatted.sections
    .map((section) => `## ${section.title}\n\n${section.markdown.trim()}`)
    .join("\n\n");
  return `# ${formatted.title}\n\n${formatted.summary.trim()}${
    sections ? `\n\n${sections}` : ""
  }\n`;
};

export const serializeReportOutput = (
  report: ReportEnvelope,
  options: SerializeReportOptions
): string => {
  if (options.format === "summary") {
    return renderReportSummary(report);
  }
  if (options.format === "markdown") {
    return renderReportMarkdown(report);
  }

  const payload = selectReportModePayload(report, options.mode);
  if (options.format === "ndjson") {
    if (Array.isArray(payload)) {
      return payload.map((item) => JSON.stringify(item)).join("\n") + "\n";
    }
    return `${JSON.stringify(payload)}\n`;
  }
  return `${JSON.stringify(payload, null, 2)}\n`;
};

export const renderReportList = (
  reports: ReportEnvelope[],
  format: Exclude<ReportOutputFormat, "tui"> = "summary"
): string => {
  if (format === "json") {
    return `${JSON.stringify(reports, null, 2)}\n`;
  }
  if (format === "ndjson") {
    return reports.map((report) => JSON.stringify(report)).join("\n") + "\n";
  }
  if (format === "markdown") {
    return [
      "# Reports",
      "",
      "| id | kind | project | generated |",
      "| --- | --- | --- | --- |",
      ...reports.map(
        (report) =>
          `| ${report.id} | ${report.kind} | ${report.projectId} | ${report.generatedAt} |`
      ),
      "",
    ].join("\n");
  }

  const lines = [
    `${pad("id", 28)} ${pad("kind", 6)} ${pad("project", 18)} generated`,
    ...reports.map(
      (report) =>
        `${pad(report.id, 28)} ${pad(report.kind, 6)} ${pad(report.projectId, 18)} ${report.generatedAt}`
    ),
  ];
  return `${lines.join("\n")}\n`;
};

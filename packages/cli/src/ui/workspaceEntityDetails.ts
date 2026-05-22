import type { Project } from "@cloudeval/core";

export type EntityTone = "brand" | "success" | "warning" | "danger" | "muted";

export interface EntityMetric {
  label: string;
  value: string;
  tone?: EntityTone;
}

export interface EntityDetailRow {
  label: string;
  value: string;
  tone?: EntityTone;
}

export interface EntityRelatedItem {
  label: string;
  detail?: string;
  tone?: EntityTone;
}

export interface EntityDetailModel {
  title: string;
  subtitle?: string;
  metrics: EntityMetric[];
  detailRows: EntityDetailRow[];
  relatedItems: EntityRelatedItem[];
}

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
  for (const key of ["items", "data", "rows", "results", "connections", "projects"]) {
    const candidate = record[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
};

const firstString = (
  value: unknown,
  keys: string[],
  fallback = ""
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
    if (typeof current === "boolean") {
      return current ? "on" : "off";
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

const statusTone = (value: string): EntityTone => {
  const normalized = value.toLowerCase();
  if (["completed", "ready", "fresh", "synced", "success", "active"].includes(normalized)) {
    return "success";
  }
  if (["running", "partial", "pending", "stale"].includes(normalized)) {
    return "warning";
  }
  if (["failed", "error", "missing", "outdated", "disabled"].includes(normalized)) {
    return "danger";
  }
  return "muted";
};

const truncateDetail = (value: string, limit = 96): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;

const projectIdsForConnection = (connection: unknown): string[] => {
  const record = toRecord(connection);
  if (!record) {
    return [];
  }
  const values = [
    record.project_id,
    record.projectId,
    record.project,
    record.project_name,
  ];
  const arrayValues = [
    record.project_ids,
    record.projectIds,
    record.projects,
    record.linked_project_ids,
  ].flatMap((value) => directArray(value));
  return [...values, ...arrayValues]
    .map((value) => firstString({ value }, ["value"]))
    .filter(Boolean);
};

const connectionMatchesProject = (connection: unknown, project: Project): boolean => {
  const haystack = projectIdsForConnection(connection).map((value) => value.toLowerCase());
  const id = String(project.id ?? "").toLowerCase();
  const name = String(project.name ?? "").toLowerCase();
  return Boolean((id && haystack.includes(id)) || (name && haystack.includes(name)));
};

const projectHealthFor = (reportsSummary: unknown, project: Project): Record<string, unknown> | undefined => {
  const rows = directArray(toRecord(reportsSummary)?.project_health);
  return rows
    .map(toRecord)
    .find((row) => {
      if (!row) {
        return false;
      }
      return (
        String(row.project_id ?? row.projectId ?? "").toLowerCase() ===
          String(project.id ?? "").toLowerCase() ||
        String(row.project_name ?? row.projectName ?? "").toLowerCase() ===
          String(project.name ?? "").toLowerCase()
      );
    });
};

export const buildProjectDetailModel = ({
  project,
  connections,
  reportsSummary,
}: {
  project: Project | null | undefined;
  connections: unknown[];
  reportsSummary?: unknown;
}): EntityDetailModel | null => {
  if (!project) {
    return null;
  }
  const linkedConnections = connections.filter((connection) =>
    connectionMatchesProject(connection, project)
  );
  const status = firstString(project, ["status", "sync_status", "last_sync_status"], "unknown");
  const health = projectHealthFor(reportsSummary, project);
  const coverage = firstNumber(health, ["coverage_percent", "coveragePercent"]);
  const critical = firstNumber(health, ["critical_issues", "criticalIssues", "critical_count"]);
  const lastReport = firstString(health, ["last_report_at", "lastReportAt", "generated_at"]);

  return {
    title: firstString(project, ["name"], "Project"),
    subtitle: firstString(project, ["id"]),
    metrics: [
      {
        label: "Provider",
        value: firstString(project, ["cloud_provider", "provider"], "cloud"),
        tone: "brand",
      },
      { label: "Type", value: firstString(project, ["type", "source_type"], "project") },
      { label: "Status", value: status, tone: statusTone(status) },
      { label: "Connections", value: String(linkedConnections.length), tone: "brand" },
    ],
    detailRows: [
      { label: "Created", value: firstString(project, ["created_at", "createdAt"], "-") },
      { label: "Updated", value: firstString(project, ["updated_at", "updatedAt"], "-") },
      ...(coverage !== undefined
        ? [{ label: "Report coverage", value: `${Math.round(coverage)}%`, tone: "brand" as const }]
        : []),
      ...(critical !== undefined
        ? [{ label: "Critical issues", value: String(critical), tone: critical > 0 ? "danger" as const : "success" as const }]
        : []),
      ...(lastReport ? [{ label: "Last report", value: lastReport }] : []),
    ],
    relatedItems: linkedConnections.map((connection) => ({
      label: firstString(connection, ["name"], "Connection"),
      detail: firstString(connection, ["last_sync_status", "status", "type"], ""),
      tone: statusTone(firstString(connection, ["last_sync_status", "status"], "")),
    })),
  };
};

const linkedProjectForConnection = (
  connection: unknown,
  projects: Project[]
): Project | undefined => {
  const ids = projectIdsForConnection(connection).map((value) => value.toLowerCase());
  return projects.find((project) => {
    const id = String(project.id ?? "").toLowerCase();
    const name = String(project.name ?? "").toLowerCase();
    return (id && ids.includes(id)) || (name && ids.includes(name));
  });
};

export const buildConnectionDetailModel = ({
  connection,
  projects,
}: {
  connection: unknown;
  projects: Project[];
}): EntityDetailModel | null => {
  const record = toRecord(connection);
  if (!record) {
    return null;
  }
  const linkedProject = linkedProjectForConnection(connection, projects);
  const sync = firstString(connection, ["last_sync_status", "sync_status", "status"], "unknown");
  const autoSync = firstString(connection, ["auto_sync", "autoSync"], "off");
  const source = firstString(connection, [
    "template_url",
    "source_url",
    "repo_url",
    "repository_url",
    "visualization_source_path",
    "workspace_file_paths",
  ]);

  return {
    title: firstString(connection, ["name"], "Connection"),
    subtitle: firstString(connection, ["id"]),
    metrics: [
      {
        label: "Provider",
        value: firstString(connection, ["cloud_provider", "provider"], "cloud"),
        tone: "brand",
      },
      { label: "Type", value: firstString(connection, ["type", "connection_type"], "connection") },
      { label: "Sync", value: sync, tone: statusTone(sync) },
      { label: "Auto", value: autoSync, tone: autoSync === "on" ? "success" : "muted" },
    ],
    detailRows: [
      { label: "Project", value: linkedProject?.name ?? firstString(connection, ["project_name", "project_id"], "-") },
      { label: "Last synced", value: firstString(connection, ["last_synced", "lastSynced", "updated_at"], "-") },
      ...(source ? [{ label: "Source", value: truncateDetail(source), tone: "brand" as const }] : []),
      { label: "Created", value: firstString(connection, ["created_at", "createdAt"], "-") },
    ],
    relatedItems: linkedProject
      ? [{ label: linkedProject.name, detail: linkedProject.cloud_provider ?? "project", tone: "brand" }]
      : [],
  };
};

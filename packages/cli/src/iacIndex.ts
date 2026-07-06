import fs from "node:fs/promises";
import path from "node:path";

export type IacAdapterId = "arm" | "bicep" | "terraform" | "opentofu";
export type SupportLevel = "full" | "indexed_only" | "unsupported";
export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface TextRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface ResourceIndexItem {
  adapter: IacAdapterId;
  filePath: string;
  range: TextRange;
  address?: string;
  resourceType?: string;
  resourceName?: string;
  cloudResourceId?: string;
  supportLevel: SupportLevel;
}

export interface IacTarget {
  adapter: IacAdapterId;
  path: string;
  supportLevel: SupportLevel;
}

export interface IacDetectionResult {
  targets: IacTarget[];
  summary: {
    total: number;
    full: number;
    indexedOnly: number;
    unsupported: number;
  };
}

export interface IacDocumentIndex {
  adapter: IacAdapterId;
  filePath: string;
  supportLevel: SupportLevel;
  resources: ResourceIndexItem[];
}

const FULL_SUPPORT = new Set<IacAdapterId>(["arm", "bicep"]);

const normalizeWorkspacePath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^\.\//, "");

const adapterForPath = (filePath: string): IacAdapterId | undefined => {
  const normalized = filePath.toLowerCase();
  if (normalized.endsWith(".bicep")) {
    return "bicep";
  }
  if (normalized.endsWith(".tofu")) {
    return "opentofu";
  }
  if (normalized.endsWith(".tf")) {
    return "terraform";
  }
  if (normalized.endsWith(".json")) {
    return "arm";
  }
  return undefined;
};

const supportLevelForAdapter = (adapter: IacAdapterId): SupportLevel =>
  FULL_SUPPORT.has(adapter) ? "full" : "indexed_only";

const isIgnoredWorkspacePath = (relativePath: string): boolean => {
  const normalized = normalizeWorkspacePath(relativePath);
  return (
    normalized === ".DS_Store" ||
    normalized.startsWith(".git/") ||
    normalized.startsWith(".vscode/") ||
    normalized.startsWith("node_modules/") ||
    normalized.startsWith(".terraform/") ||
    normalized.startsWith(".cloudeval/bundles/") ||
    normalized.startsWith(".cloudeval/template-cache/")
  );
};

export const detectIacTargets = (paths: string[]): IacDetectionResult => {
  const targets = paths
    .map(normalizeWorkspacePath)
    .filter((item) => item && !isIgnoredWorkspacePath(item))
    .flatMap((item): IacTarget[] => {
      const adapter = adapterForPath(item);
      if (!adapter) {
        return [];
      }
      return [{ adapter, path: item, supportLevel: supportLevelForAdapter(adapter) }];
    });

  return {
    targets,
    summary: {
      total: targets.length,
      full: targets.filter((target) => target.supportLevel === "full").length,
      indexedOnly: targets.filter((target) => target.supportLevel === "indexed_only").length,
      unsupported: targets.filter((target) => target.supportLevel === "unsupported").length,
    },
  };
};

const lineStarts = (content: string): number[] => {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
};

const positionAt = (starts: number[], offset: number): { line: number; character: number } => {
  let line = 0;
  for (let index = 0; index < starts.length; index += 1) {
    if (starts[index] <= offset) {
      line = index;
      continue;
    }
    break;
  }
  return { line, character: Math.max(0, offset - starts[line]) };
};

const rangeFromOffsets = (content: string, startOffset: number, endOffset: number): TextRange => {
  const starts = lineStarts(content);
  const start = positionAt(starts, startOffset);
  const end = positionAt(starts, endOffset);
  return {
    startLine: start.line,
    startCharacter: start.character,
    endLine: end.line,
    endCharacter: end.character,
  };
};

const jsonObjectEndOffset = (content: string, startOffset: number): number => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startOffset; index < content.length; index += 1) {
    const char = content[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return startOffset;
};

const firstStringField = (value: Record<string, unknown>, fields: string[]): string | undefined => {
  for (const field of fields) {
    const raw = value[field];
    if (typeof raw === "string" && raw.trim()) {
      return raw;
    }
  }
  return undefined;
};

const indexArmDocument = (filePath: string, content: string, adapter: IacAdapterId): IacDocumentIndex => {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { adapter, filePath, supportLevel: "full", resources: [] };
  }
  const resources = Array.isArray(parsed.resources) ? parsed.resources : [];
  const indexed: ResourceIndexItem[] = [];
  let searchOffset = 0;
  for (const resource of resources) {
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
      continue;
    }
    const record = resource as Record<string, unknown>;
    const resourceType = firstStringField(record, ["type"]);
    const resourceName = firstStringField(record, ["name"]);
    const typePattern = resourceType
      ? new RegExp(`"type"\\s*:\\s*${JSON.stringify(resourceType).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
      : undefined;
    const typeMatch = typePattern ? typePattern.exec(content.slice(searchOffset)) : undefined;
    const typeOffset = typeMatch ? searchOffset + typeMatch.index : searchOffset;
    const objectStart = content.lastIndexOf("{", typeOffset);
    const startOffset = objectStart >= 0 ? objectStart : typeOffset;
    const endOffset = jsonObjectEndOffset(content, startOffset);
    searchOffset = Math.max(endOffset, typeOffset + 1);
    indexed.push({
      adapter,
      filePath,
      range: rangeFromOffsets(content, startOffset, endOffset),
      ...(resourceType && resourceName ? { address: `${resourceType}.${resourceName}` } : {}),
      ...(resourceType ? { resourceType } : {}),
      ...(resourceName ? { resourceName } : {}),
      supportLevel: "full",
    });
  }
  return { adapter, filePath, supportLevel: "full", resources: indexed };
};

const blockEndLine = (lines: string[], startLine: number): number => {
  let depth = 0;
  for (let index = startLine; index < lines.length; index += 1) {
    for (const char of lines[index] ?? "") {
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth <= 0) {
          return index;
        }
      }
    }
  }
  return startLine;
};

const indexTerraformLikeDocument = (
  filePath: string,
  content: string,
  adapter: "terraform" | "opentofu",
): IacDocumentIndex => {
  const lines = content.split(/\r?\n/);
  const resources: ResourceIndexItem[] = [];
  lines.forEach((line, index) => {
    const match = line.match(/^\s*resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/);
    if (!match) {
      return;
    }
    const endLine = blockEndLine(lines, index);
    resources.push({
      adapter,
      filePath,
      range: {
        startLine: index,
        startCharacter: line.indexOf("resource"),
        endLine,
        endCharacter: lines[endLine]?.length ?? 0,
      },
      address: `${match[1]}.${match[2]}`,
      resourceType: match[1],
      resourceName: match[2],
      supportLevel: "indexed_only",
    });
  });
  return { adapter, filePath, supportLevel: "indexed_only", resources };
};

const indexBicepDocument = (filePath: string, content: string): IacDocumentIndex => {
  const lines = content.split(/\r?\n/);
  const resources: ResourceIndexItem[] = [];
  lines.forEach((line, index) => {
    const match = line.match(/^\s*resource\s+([A-Za-z_][\w]*)\s+'([^'@]+)(?:@[^']+)?'\s*=/);
    if (!match) {
      return;
    }
    resources.push({
      adapter: "bicep",
      filePath,
      range: {
        startLine: index,
        startCharacter: line.indexOf("resource"),
        endLine: blockEndLine(lines, index),
        endCharacter: lines[blockEndLine(lines, index)]?.length ?? line.length,
      },
      address: `bicep.${match[1]}`,
      resourceType: match[2],
      resourceName: match[1],
      supportLevel: "full",
    });
  });
  return { adapter: "bicep", filePath, supportLevel: "full", resources };
};

export const indexIacDocument = (input: {
  path: string;
  content: string;
}): IacDocumentIndex => {
  const normalizedPath = normalizeWorkspacePath(input.path);
  const adapter = adapterForPath(normalizedPath);
  if (adapter === "arm") {
    return indexArmDocument(normalizedPath, input.content, adapter);
  }
  if (adapter === "bicep") {
    return indexBicepDocument(normalizedPath, input.content);
  }
  if (adapter === "terraform" || adapter === "opentofu") {
    return indexTerraformLikeDocument(normalizedPath, input.content, adapter);
  }
  return {
    adapter: "arm",
    filePath: normalizedPath,
    supportLevel: "unsupported",
    resources: [],
  };
};

export const readWorkspaceFilePaths = async (workspace: string): Promise<string[]> => {
  const root = path.resolve(workspace);
  const paths: string[] = [];
  const visit = async (directory: string) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = normalizeWorkspacePath(path.relative(root, absolute));
      if (!relative || isIgnoredWorkspacePath(relative)) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        paths.push(relative);
      }
    }
  };
  await visit(root);
  return paths.sort((left, right) => left.localeCompare(right));
};

export const normalizeSeverity = (value: unknown): FindingSeverity => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["critical", "blocker"].includes(normalized)) {
    return "critical";
  }
  if (["high", "error", "fail", "failed"].includes(normalized)) {
    return "high";
  }
  if (["medium", "warning", "warn"].includes(normalized)) {
    return "medium";
  }
  if (["low"].includes(normalized)) {
    return "low";
  }
  return "info";
};

export const summarizeFindings = (
  findings: Array<{ severity?: unknown }>,
): {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  statusText: string;
} => {
  const counts = {
    total: findings.length,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const finding of findings) {
    counts[normalizeSeverity(finding.severity)] += 1;
  }
  const statusText = [
    counts.critical ? `${counts.critical} critical` : undefined,
    counts.high ? `${counts.high} high` : undefined,
    counts.medium ? `${counts.medium} medium` : undefined,
    counts.low ? `${counts.low} low` : undefined,
    counts.info ? `${counts.info} info` : undefined,
  ]
    .filter(Boolean)
    .join(" • ");
  return {
    ...counts,
    statusText: statusText || "No findings",
  };
};

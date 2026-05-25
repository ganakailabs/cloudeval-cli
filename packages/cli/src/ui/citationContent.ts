import type { ChatCitationEntry, ChatToolSourceEntry } from "@cloudeval/shared";

const CITATION_TAG_RE = /\[S([A-Za-z0-9_\-]+)\]/g;
const CITATION_TAG_ALT_RE = /\[(tool_[A-Za-z0-9_\-]+)\]/g;
const DEFAULT_MAX_INLINE_CITATIONS_PER_SOURCE = 3;
const ALIGNMENT_LOW_SCORE = 70;
const QUOTE_EXCERPT_MAX = 120;

interface CitationMatch {
  index: number;
  end: number;
  sourceId: string;
}

export interface CitationReference {
  number: number;
  sourceId: string;
  label: string;
  url?: string;
  quote?: string;
  loc?: string;
  alignment_score?: number;
  origin?: string;
}

export const normalizeCitationSourceId = (sourceId: string): string =>
  sourceId.startsWith("_tool_") ? sourceId.slice(1) : sourceId;

const findCitationMatches = (value: string): CitationMatch[] => {
  const matches: CitationMatch[] = [];
  let match: RegExpExecArray | null;

  CITATION_TAG_RE.lastIndex = 0;
  while ((match = CITATION_TAG_RE.exec(value)) !== null) {
    matches.push({
      index: match.index,
      end: match.index + match[0].length,
      sourceId: normalizeCitationSourceId(match[1] ?? ""),
    });
  }

  CITATION_TAG_ALT_RE.lastIndex = 0;
  while ((match = CITATION_TAG_ALT_RE.exec(value)) !== null) {
    matches.push({
      index: match.index,
      end: match.index + match[0].length,
      sourceId: normalizeCitationSourceId(match[1] ?? ""),
    });
  }

  matches.sort((a, b) => a.index - b.index);
  const seenIndexes = new Set<number>();
  return matches.filter((candidate) => {
    if (seenIndexes.has(candidate.index)) {
      return false;
    }
    seenIndexes.add(candidate.index);
    return true;
  });
};

export const getCitationSourceOrder = (content: string): string[] => {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const { sourceId } of findCitationMatches(content)) {
    if (!sourceId || seen.has(sourceId)) {
      continue;
    }
    seen.add(sourceId);
    order.push(sourceId);
  }
  return order;
};

const citationNumberMap = (content: string): Map<string, number> => {
  const map = new Map<string, number>();
  getCitationSourceOrder(content).forEach((sourceId, index) => {
    map.set(sourceId, index + 1);
  });
  return map;
};

export const toDisplayCitationContent = (
  content: string,
  options: { maxInlinePerSource?: number } = {}
): string => {
  if (!content) {
    return content;
  }
  const matches = findCitationMatches(content);
  if (!matches.length) {
    return content;
  }

  const sourceIdToNumber = citationNumberMap(content);
  const perSourceCount = new Map<string, number>();
  const maxInlinePerSource =
    options.maxInlinePerSource ?? DEFAULT_MAX_INLINE_CITATIONS_PER_SOURCE;
  let cursor = 0;
  let result = "";

  for (const match of matches) {
    result += content.slice(cursor, match.index);
    const count = (perSourceCount.get(match.sourceId) ?? 0) + 1;
    perSourceCount.set(match.sourceId, count);
    const number = sourceIdToNumber.get(match.sourceId);
    if (number !== undefined && count <= maxInlinePerSource) {
      result += `[${number}]`;
    }
    cursor = match.end;
  }

  return result + content.slice(cursor);
};

const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
};

const fallbackSourceLabel = (sourceId: string): string =>
  sourceId
    .replace(/^tool_/, "")
    .replace(/[_:-]+/g, " ")
    .trim() || sourceId;

export const buildCitationReferences = ({
  content,
  toolsUsed,
  citations,
}: {
  content: string;
  toolsUsed?: ChatToolSourceEntry[];
  citations?: ChatCitationEntry[];
}): CitationReference[] => {
  const order = getCitationSourceOrder(content);
  if (!order.length) {
    return [];
  }

  const toolBySourceId = new Map<string, ChatToolSourceEntry>();
  for (const tool of toolsUsed ?? []) {
    const sourceId =
      typeof tool.source_id === "string"
        ? normalizeCitationSourceId(tool.source_id.trim())
        : "";
    if (sourceId && !toolBySourceId.has(sourceId)) {
      toolBySourceId.set(sourceId, tool);
    }
  }

  const citationBySourceId = new Map<string, ChatCitationEntry>();
  for (const citation of citations ?? []) {
    const sourceId =
      typeof citation.source_id === "string"
        ? normalizeCitationSourceId(citation.source_id.trim())
        : "";
    if (sourceId && !citationBySourceId.has(sourceId)) {
      citationBySourceId.set(sourceId, citation);
    }
  }

  return order.map((sourceId, index) => {
    const tool = toolBySourceId.get(sourceId);
    const citation = citationBySourceId.get(sourceId);
    const alignmentScore =
      typeof citation?.alignment_score === "number"
        ? citation.alignment_score
        : undefined;
    return {
      number: index + 1,
      sourceId,
      label:
        firstString(
          citation?.title,
          tool?.title,
          tool?.tool_friendly_name,
          tool?.tool_name
        ) ?? fallbackSourceLabel(sourceId),
      url: firstString(citation?.url, tool?.source_url),
      quote: firstString(citation?.quote),
      loc: firstString(citation?.loc),
      alignment_score: alignmentScore,
      origin:
        typeof citation?.origin === "string" ? citation.origin : undefined,
    };
  });
};

const truncateQuote = (quote: string): string =>
  quote.length <= QUOTE_EXCERPT_MAX
    ? quote
    : `${quote.slice(0, QUOTE_EXCERPT_MAX - 1)}…`;

export const buildReferencesSection = (
  references: CitationReference[]
): string => {
  if (!references.length) {
    return "";
  }
  return [
    "---",
    "## References",
    ...references.map((reference) => {
      const lowConfidence =
        typeof reference.alignment_score === "number" &&
        reference.alignment_score < ALIGNMENT_LOW_SCORE;
      const quotePart = reference.quote
        ? ` — "${truncateQuote(reference.quote)}"`
        : "";
      const locPart = reference.loc ? ` (${reference.loc})` : "";
      const confidencePart = lowConfidence ? " ~low confidence" : "";
      return `- [${reference.number}] ${reference.label}${
        reference.url ? ` - ${reference.url}` : ""
      }${quotePart}${locPart}${confidencePart}`;
    }),
  ].join("\n");
};

export const toCitationExportContent = ({
  content,
  toolsUsed,
  citations,
}: {
  content: string;
  toolsUsed?: ChatToolSourceEntry[];
  citations?: ChatCitationEntry[];
}): string => {
  const displayContent = toDisplayCitationContent(content);
  const references = buildReferencesSection(
    buildCitationReferences({ content, toolsUsed, citations })
  );
  return references ? `${displayContent.trim()}\n\n${references}` : displayContent;
};

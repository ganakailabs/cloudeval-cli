import { render as renderMermaidArt } from "grok-mermaid";

export type GraphDiagramMode = "auto" | "unicode" | "ascii" | "off";
export type ResolvedGraphDiagramMode = Exclude<GraphDiagramMode, "auto">;

export type GraphInsightContentBlock =
  | { type: "text"; content: string }
  | { type: "mermaid"; content: string; language: "mermaid" }
  | { type: "code"; content: string; language: string };

export type TerminalMermaidRenderResult =
  | { status: "rendered"; content: string }
  | { status: "fallback"; content: string; reason?: string }
  | { status: "disabled"; content: string };

type MermaidRenderer = (
  source: string
) => { plain: string[]; width?: number } | null;

const GRAPH_DIAGRAM_MODES = new Set<GraphDiagramMode>([
  "auto",
  "unicode",
  "ascii",
  "off",
]);

const MIN_AUTO_RENDER_COLUMNS = 60;

const normalizeFenceLanguage = (language?: string): string =>
  (language ?? "").trim().split(/\s+/)[0]?.toLowerCase() || "text";

export const parseGraphInsightContentBlocks = (
  content: string
): GraphInsightContentBlock[] => {
  const blocks: GraphInsightContentBlock[] = [];
  const parts = content.replace(/\r\n/g, "\n").split(/```/g);

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? "";
    if (index % 2 === 0) {
      if (part.trim()) {
        blocks.push({ type: "text", content: part });
      }
      continue;
    }

    const newlineIndex = part.indexOf("\n");
    const rawLanguage =
      newlineIndex === -1 ? "" : part.substring(0, newlineIndex).trim();
    const language = normalizeFenceLanguage(rawLanguage);
    const code = newlineIndex === -1 ? part : part.substring(newlineIndex + 1);
    if (language === "mermaid") {
      blocks.push({ type: "mermaid", content: code.trim(), language: "mermaid" });
    } else {
      blocks.push({ type: "code", content: code, language });
    }
  }

  return blocks;
};

export const resolveGraphDiagramMode = ({
  requested,
  isTTY = process.stdout.isTTY,
  columns = process.stdout.columns,
}: {
  requested?: string;
  isTTY?: boolean;
  columns?: number;
} = {}): ResolvedGraphDiagramMode => {
  const rawMode =
    requested ?? process.env.CLOUDEVAL_GRAPH_DIAGRAM ?? "auto";
  const mode = rawMode.trim().toLowerCase();
  if (!GRAPH_DIAGRAM_MODES.has(mode as GraphDiagramMode)) {
    throw new Error(
      "Graph diagram mode must be one of: auto, unicode, ascii, off."
    );
  }
  if (mode !== "auto") {
    return mode as ResolvedGraphDiagramMode;
  }
  if (!isTTY) {
    return "off";
  }
  if (typeof columns === "number" && columns < MIN_AUTO_RENDER_COLUMNS) {
    return "off";
  }
  return "unicode";
};

const toMermaidSourceBlock = (source: string): string =>
  ["```mermaid", source.trim(), "```"].join("\n");

const ensureAscii = (content: string): string =>
  content
    .replace(/[┌┐└┘┬┴┼├┤╭╮╰╯]/g, "+")
    .replace(/[─━]/g, "-")
    .replace(/[│┃]/g, "|")
    .replace(/[►▶→]/g, ">")
    .replace(/[◄◀←]/g, "<")
    .replace(/[▲↑]/g, "^")
    .replace(/[▼↓]/g, "v")
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "?");

export const renderTerminalMermaid = (
  source: string,
  {
    mode,
    renderer = renderMermaidArt,
    columns = process.stdout.columns,
  }: {
    mode: ResolvedGraphDiagramMode;
    renderer?: MermaidRenderer;
    columns?: number;
  }
): TerminalMermaidRenderResult => {
  const mermaidSource = toMermaidSourceBlock(source);
  if (mode === "off") {
    return { status: "disabled", content: mermaidSource };
  }

  try {
    const art = renderer(source);
    if (!art) {
      return {
        status: "fallback",
        content: mermaidSource,
        reason: "Mermaid renderer did not support this diagram.",
      };
    }
    if (
      typeof columns === "number" &&
      columns > 0 &&
      typeof art.width === "number" &&
      art.width > columns
    ) {
      return {
        status: "fallback",
        content: mermaidSource,
        reason: `Mermaid diagram needs ${art.width} columns; terminal has ${columns}.`,
      };
    }

    const rendered = art.plain.join("\n").trimEnd();
    if (!rendered.trim()) {
      return {
        status: "fallback",
        content: mermaidSource,
        reason: "Mermaid renderer returned empty output.",
      };
    }
    return {
      status: "rendered",
      content: mode === "ascii" ? ensureAscii(rendered) : rendered,
    };
  } catch (error) {
    return {
      status: "fallback",
      content: mermaidSource,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

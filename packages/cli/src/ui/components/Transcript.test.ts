import assert from "node:assert/strict";
import test from "node:test";
import "../../runtime/prepareInk";
import type { ChatMessage } from "@cloudeval/shared";
import { hasRenderableTranscriptMessages } from "../transcriptModel";
import {
  getTranscriptRoleColor,
  getSyntaxHighlightLanguage,
  getGraphInsightDiagramWrapMode,
  parseAssistantMarkdownBlocks,
  summarizeThinkingLedger,
  tokenizeInlineMarkdown,
} from "./Transcript.js";
import { terminalPalette, terminalTheme } from "../theme";

test("hasRenderableTranscriptMessages reports empty threads", () => {
  assert.equal(hasRenderableTranscriptMessages([]), false);
});

test("hasRenderableTranscriptMessages treats content, errors, and thinking as visible thread content", () => {
  const base = {
    id: "message-1",
    role: "assistant",
    createdAt: 1,
  } satisfies Partial<ChatMessage>;

  assert.equal(
    hasRenderableTranscriptMessages([{ ...base, content: "hello" } as ChatMessage]),
    true
  );
  assert.equal(
    hasRenderableTranscriptMessages([{ ...base, error: "failed" } as ChatMessage]),
    true
  );
  assert.equal(
    hasRenderableTranscriptMessages([
      {
        ...base,
        thinkingSteps: [{ node: "plan", status: "completed", timestamp: 1 }],
      } as ChatMessage,
    ]),
    true
  );
});

test("hasRenderableTranscriptMessages can exclude pending assistant streams", () => {
  const message = {
    id: "message-1",
    role: "assistant",
    content: "streaming",
    pending: true,
    createdAt: 1,
  } as ChatMessage;

  assert.equal(hasRenderableTranscriptMessages([message], true), false);
  assert.equal(hasRenderableTranscriptMessages([message], false), true);
});

test("getSyntaxHighlightLanguage falls back for unsupported mermaid fences", () => {
  assert.equal(getSyntaxHighlightLanguage("mermaid"), "text");
  assert.equal(getSyntaxHighlightLanguage("```mermaid"), "text");
  assert.equal(getSyntaxHighlightLanguage("typescript"), "typescript");
});

test("summarizeThinkingLedger names task-ledger progress with failed and running counts", () => {
  const summary = summarizeThinkingLedger([
    { node: "plan", type: "thinking", status: "completed", timestamp: 1 },
    { node: "fetch", type: "thinking", status: "streaming", timestamp: 2 },
    { node: "report", type: "thinking", status: "error", timestamp: 3 },
  ]);

  assert.equal(summary.title, "Task Ledger");
  assert.deepEqual(summary.parts, ["1/3 done", "1 failed", "1 running"]);
});

test("tokenizeInlineMarkdown marks citation numbers for colored rendering", () => {
  assert.deepEqual(tokenizeInlineMarkdown("Uses Azure [1] and cost data [2]."), [
    { type: "text", text: "Uses Azure " },
    { type: "citation", text: "[1]" },
    { type: "text", text: " and cost data " },
    { type: "citation", text: "[2]" },
    { type: "text", text: "." },
  ]);
});

test("parseAssistantMarkdownBlocks promotes graph insight marker to a card block", () => {
  const blocks = parseAssistantMarkdownBlocks(
    "Intro.[S_tool_graph_insights_0]\n\n<!-- graph-insight:compact -->\n\n## **Topology**\n- VM to NIC."
  );

  assert.deepEqual(
    blocks.map((block) => block.type),
    ["text", "graphInsight"]
  );
  assert.match(blocks[0]?.content ?? "", /Intro/);
  assert.match(blocks[1]?.content ?? "", /Topology/);
  assert.doesNotMatch(blocks[1]?.content ?? "", /graph-insight/);
});

test("parseAssistantMarkdownBlocks keeps mermaid fences inside graph insight cards", () => {
  const blocks = parseAssistantMarkdownBlocks(
    [
      "Intro.[S_tool_graph_insights_0]",
      "",
      "<!-- graph-insight:compact -->",
      "",
      "## **Topology**",
      "```mermaid",
      "flowchart LR",
      "  VM1[VM 1] --> Pool[Backend Pool]",
      "```",
      "",
      "## **Risk**",
      "- Backend pool drift.",
    ].join("\n")
  );

  assert.deepEqual(
    blocks.map((block) => block.type),
    ["text", "graphInsight"]
  );
  assert.match(blocks[1]?.content ?? "", /```mermaid\nflowchart LR/);
  assert.match(blocks[1]?.content ?? "", /Backend pool drift/);
});

test("rendered graph insight diagrams do not use prose wrapping", () => {
  assert.equal(getGraphInsightDiagramWrapMode("rendered"), "truncate");
  assert.equal(getGraphInsightDiagramWrapMode("fallback"), "wrap");
  assert.equal(getGraphInsightDiagramWrapMode("disabled"), "wrap");
});

test("transcript role labels use distinct bright persona colors", () => {
  assert.deepEqual(terminalPalette.userName, {
    dark: "cyanBright",
    light: "blue",
  });
  assert.deepEqual(terminalPalette.aiName, {
    dark: "magentaBright",
    light: "magenta",
  });
  assert.equal(getTranscriptRoleColor("user"), terminalTheme.userName);
  assert.equal(getTranscriptRoleColor("assistant"), terminalTheme.aiName);
});

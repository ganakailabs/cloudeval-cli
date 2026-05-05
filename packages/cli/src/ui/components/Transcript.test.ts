import assert from "node:assert/strict";
import test from "node:test";
import "../../runtime/prepareInk";
import type { ChatMessage } from "@cloudeval/shared";
import { hasRenderableTranscriptMessages } from "../transcriptModel";
import { getSyntaxHighlightLanguage } from "./Transcript.js";

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

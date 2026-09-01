import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "@cloudeval/shared";
import {
  buildChatTranscriptMarkdown,
  buildLatestAssistantResponseText,
  copyTextToClipboard,
  getClipboardCommand,
} from "./chatResponseActions";

const assistantMessage = (content: string): ChatMessage => ({
  id: "assistant-1",
  role: "assistant",
  content,
  createdAt: 1,
});

test("buildLatestAssistantResponseText uses copy-friendly citations", () => {
  const text = buildLatestAssistantResponseText([
    {
      ...assistantMessage("Architecture risk summary.[S_tool_architecture_dashboard_0]"),
      toolsUsed: [
        {
          source_id: "tool_architecture_dashboard_0",
          title: "Architecture dashboard",
        },
      ],
    },
  ]);

  assert.equal(
    text,
    [
      "Architecture risk summary.[1]",
      "",
      "---",
      "## References",
      "- [1] Architecture dashboard",
    ].join("\n")
  );
});

test("buildChatTranscriptMarkdown exports user and assistant turns", () => {
  const markdown = buildChatTranscriptMarkdown({
    messages: [
      {
        id: "user-1",
        role: "user",
        content: "What projects are available?",
        createdAt: 1,
      },
      assistantMessage("Only one project is available.[S_tool_graph_schema_0]"),
    ],
    userName: "Manu",
    threadId: "thread-test",
    exportedAt: new Date("2026-05-22T00:00:00.000Z"),
  });

  assert.match(markdown, /^# Cloudeval chat transcript/);
  assert.match(markdown, /Thread: thread-test/);
  assert.match(markdown, /## Manu\n\nWhat projects are available\?/);
  assert.match(markdown, /## Cloudeval AI\n\nOnly one project is available\.\[1\]/);
  assert.doesNotMatch(markdown, /\[S_tool_graph_schema_0\]/);
});

test("getClipboardCommand chooses platform clipboard commands", () => {
  assert.deepEqual(getClipboardCommand("darwin"), { command: "pbcopy", args: [] });
  assert.deepEqual(getClipboardCommand("win32"), {
    command: "cmd",
    args: ["/c", "clip"],
  });
  assert.equal(getClipboardCommand("linux").command, "sh");
});

test("copyTextToClipboard reports missing clipboard commands", () => {
  assert.throws(
    () =>
      copyTextToClipboard("hello", {
        platform: "linux",
        spawnSyncImpl: () =>
          ({
            pid: 1,
            output: [],
            stdout: "",
            stderr: "",
            status: 127,
            signal: null,
          }) as any,
      }),
    /No clipboard command/
  );
});

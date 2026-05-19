import assert from "node:assert/strict";
import test from "node:test";
import {
  buildThreadSelectItems,
  localSessionMessagesToChatMessages,
  remoteThreadMessagesToChatMessages,
  threadPanelTitle,
} from "./sessionThreads";
import type { LocalSession } from "../sessionsStore";

const session = {
  threadId: "thread-cost",
  title: "Cost risk review",
  projectId: "project-1",
  projectName: "Production",
  model: "gpt-5-mini",
  profile: "default",
  createdAt: "2026-05-18T10:00:00.000Z",
  updatedAt: "2026-05-18T10:10:00.000Z",
  messageCount: 2,
  messages: [
    {
      role: "user",
      content: "Review monthly spend",
      createdAt: "2026-05-18T10:00:00.000Z",
    },
    {
      role: "assistant",
      content: "Compute is the main cost driver.",
      createdAt: "2026-05-18T10:01:00.000Z",
    },
  ],
} satisfies LocalSession;

test("buildThreadSelectItems includes new thread and recent local session titles", () => {
  const items = buildThreadSelectItems([session], "thread-cost", [], {
    now: Date.parse("2026-05-18T12:05:00.000Z"),
  });

  assert.equal(items[0].label, "New thread");
  assert.deepEqual(items[0].value, { kind: "new" });
  assert.equal(items[1].label, "Cost risk review · 2h");
  assert.equal(
    items[1].description,
    "Local session · created 2h ago · Production · 2 messages"
  );
  assert.equal(items[1].value.kind, "session");
});

test("buildThreadSelectItems prefers cloud threads and deduplicates local matches", () => {
  const items = buildThreadSelectItems([session], "thread-cost", [
    {
      thread_id: "thread-cost",
      title: "Cost risk review from web",
      project_name: "Production",
      message_count: 4,
      created_at: "2026-05-18T12:03:00.000Z",
    },
  ], { now: Date.parse("2026-05-18T12:05:00.000Z") });

  assert.equal(items.length, 2);
  assert.equal(items[1].label, "Cost risk review from web · 2m");
  assert.equal(
    items[1].description,
    "Cloud thread · created 2m ago · Production · 4 messages"
  );
  assert.equal(items[1].value.kind, "remote");
});

test("localSessionMessagesToChatMessages restores transcript-compatible messages", () => {
  const messages = localSessionMessagesToChatMessages(session);

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content, "Review monthly spend");
  assert.equal(messages[0].createdAt, Date.parse("2026-05-18T10:00:00.000Z"));
  assert.equal(messages[1].role, "assistant");
});

test("remoteThreadMessagesToChatMessages restores backend thread history", () => {
  const messages = remoteThreadMessagesToChatMessages({
    thread_id: "thread-web",
    title: "Web thread",
    messages_page: [
      {
        message_id: "u1",
        role: "user",
        content: [{ text: "Explain topology" }],
        created_at: "2026-05-18T10:00:00.000Z",
      },
      {
        message_id: "a1",
        role: "assistant",
        content: { text: "Topology has a VNet and two subnets." },
        created_at: "2026-05-18T10:01:00.000Z",
        follow_up_questions: ["Show dependencies"],
      },
    ],
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, "u1");
  assert.equal(messages[0].content, "Explain topology");
  assert.equal(messages[1].role, "assistant");
  assert.deepEqual(messages[1].followUpQuestions, ["Show dependencies"]);
});

test("threadPanelTitle prefers the session title and falls back to readable state", () => {
  assert.equal(threadPanelTitle({ session, threadId: "thread-cost", hasMessages: true }), "Cost risk review");
  assert.equal(
    threadPanelTitle({
      remoteThread: { thread_id: "thread-web", title: "Web architecture review" },
      threadId: "thread-web",
      hasMessages: true,
    }),
    "Web architecture review"
  );
  assert.equal(threadPanelTitle({ threadId: "abcd-1234-efgh-5678", hasMessages: false }), "abcd-1234-efgh-5678");
  assert.equal(threadPanelTitle({ hasMessages: false }), "New thread");
});

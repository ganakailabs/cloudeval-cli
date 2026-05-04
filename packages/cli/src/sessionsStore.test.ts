import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listSessions,
  recordSessionTurn,
  renameSession,
  resolveSessionReference,
  searchSessions,
} from "./sessionsStore.js";

const withTempHome = async (fn: (home: string) => Promise<void>) => {
  const previousHome = process.env.HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-session-store-home-"));
  process.env.HOME = home;
  try {
    await fn(home);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await fs.rm(home, { recursive: true, force: true });
  }
};

test("recordSessionTurn creates deterministic concise titles", async () => {
  await withTempHome(async () => {
    await recordSessionTurn({
      threadId: "thread-cost",
      question: "Can you investigate the production cost spike in Azure?",
      response: "Production cost increased because compute usage doubled.",
      project: { id: "project-main", name: "Production" },
      model: "gpt-5-mini",
      profile: "agent",
    });

    const sessions = await listSessions(10, "agent");
    assert.equal(sessions[0].title, "Investigate production cost spike in Azure");
  });
});

test("searchSessions ranks matching sessions and resolveSessionReference handles titles", async () => {
  await withTempHome(async () => {
    await recordSessionTurn({
      threadId: "thread-cost",
      question: "Review monthly Azure cost anomalies",
      response: "Compute has the highest cost anomaly.",
      project: { id: "project-cost", name: "Cost Project" },
      profile: "agent",
    });
    await recordSessionTurn({
      threadId: "thread-waf",
      question: "Triage WAF identity findings",
      response: "Managed identity has one high severity finding.",
      project: { id: "project-waf", name: "WAF Project" },
      profile: "agent",
    });

    const results = await searchSessions("identity high severity", { profile: "agent", limit: 5 });
    assert.equal(results[0].threadId, "thread-waf");
    assert(results[0].score > results[1].score);
    assert.match(results[0].preview, /Managed identity/);

    const renamed = await renameSession("thread-waf", "WAF identity triage", "agent");
    assert.equal(renamed?.title, "WAF identity triage");

    const resolved = await resolveSessionReference("waf identity triage", "agent");
    assert.equal(resolved?.threadId, "thread-waf");
  });
});

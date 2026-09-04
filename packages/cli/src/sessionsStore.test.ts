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
  const previousUserProfile = process.env.USERPROFILE;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-session-store-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await fn(home);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
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
    const sqlitePath = path.join(
      os.homedir(),
      ".config",
      "cloudeval",
      "profiles",
      "agent",
      "sessions.sqlite"
    );
    const sqliteStat = await fs.stat(sqlitePath);
    assert(sqliteStat.isFile());
  });
});

test("concurrent session operations preserve all turns without temporary-file races", async () => {
  await withTempHome(async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) => recordSessionTurn({
        threadId: `concurrent-thread-${index}`,
        question: `Show chart ${index}`,
        response: `Chart response ${index}`,
        profile: "agent",
      })),
    );
    assert.deepEqual(results.filter((result) => result.status === "rejected"), []);
    const sessions = await listSessions(20, "agent");
    assert.equal(sessions.length, 12);
    assert.equal(new Set(sessions.map((session) => session.threadId)).size, 12);
  });
});

test("listSessions migrates legacy JSON sessions into SQLite", async () => {
  await withTempHome(async () => {
    const legacyDir = path.join(
      os.homedir(),
      ".config",
      "cloudeval",
      "profiles",
      "agent",
      "sessions"
    );
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyDir, "legacy-thread.json"),
      `${JSON.stringify(
        {
          threadId: "legacy-thread",
          title: "Legacy imported session",
          profile: "agent",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          messageCount: 1,
          messages: [
            {
              role: "user",
              content: "Legacy question",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        null,
        2
      )}\n`
    );

    const sessions = await listSessions(10, "agent");

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].threadId, "legacy-thread");
    assert.equal(sessions[0].messages[0].content, "Legacy question");
    await fs.access(
      path.join(
        os.homedir(),
        ".config",
        "cloudeval",
        "profiles",
        "agent",
        "sessions.sqlite"
      )
    );
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

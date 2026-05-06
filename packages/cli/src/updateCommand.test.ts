import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import {
  compareVersionStrings,
  formatUpdateStatusText,
  getUpdateStatus,
  runInstaller,
  shouldAttemptVersionNudge,
} from "./updateCommand.js";

const jsonResponse = (body: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
    text: async () => String(body),
  }) as Response;

test("compareVersionStrings handles v-prefixes and prerelease ordering", () => {
  assert.equal(compareVersionStrings("v0.12.0", "0.11.4"), 1);
  assert.equal(compareVersionStrings("0.11.4", "v0.11.4"), 0);
  assert.equal(compareVersionStrings("0.11.4-beta.1", "0.11.4"), -1);
  assert.equal(compareVersionStrings("0.11.4-beta.2", "0.11.4-beta.1"), 1);
});

test("getUpdateStatus reports latest GitHub release availability", async () => {
  const status = await getUpdateStatus({
    currentVersion: "0.11.4",
    latestReleaseUrl: "https://example.test/latest",
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://example.test/latest");
      assert.equal((init?.headers as Record<string, string>).Accept, "application/vnd.github+json");
      return jsonResponse({
        tag_name: "v0.12.0",
        html_url: "https://example.test/releases/v0.12.0",
        published_at: "2026-05-05T00:00:00.000Z",
      });
    },
  });

  assert.equal(status.currentVersion, "0.11.4");
  assert.equal(status.latestVersion, "0.12.0");
  assert.equal(status.latestTag, "v0.12.0");
  assert.equal(status.updateAvailable, true);
  assert.equal(status.releaseUrl, "https://example.test/releases/v0.12.0");
});

test("formatUpdateStatusText renders human output without a field/value table", () => {
  const text = formatUpdateStatusText({
    currentVersion: "0.11.7",
    latestVersion: "0.11.7",
    latestTag: "v0.11.7",
    updateAvailable: false,
    checkedAt: "2026-05-06T22:52:26.910Z",
    releaseUrl: "https://example.test/releases/v0.11.7",
    publishedAt: "2026-05-06T22:43:27Z",
    action: "current",
  });

  assert.match(text, /^CloudEval CLI Update\n/);
  assert.match(text, /Status: up to date/);
  assert.match(text, /Current version: 0.11.7/);
  assert.doesNotMatch(text, /^Field\s+Value/m);
  assert.doesNotMatch(text, /^-+\s+-+/m);
});

test("runInstaller pipes installer script to bash with the resolved release tag", async () => {
  const stderrChunks: Buffer[] = [];
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
  }) as unknown as ChildProcess;

  const receivedScript = new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

  const run = runInstaller({
    installerUrl: "https://example.test/install.sh",
    targetTag: "v0.12.0",
    platform: "linux",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "echo installing \"$1\"\n",
    }) as Response,
    output: new Writable({
      write(chunk, _encoding, callback) {
        stderrChunks.push(Buffer.from(chunk));
        callback();
      },
    }),
    spawnImpl: (command, args, options) => {
      assert.equal(command, "bash");
      assert.deepEqual(args, ["-s", "--", "v0.12.0"]);
      assert.equal(options.env?.CLOUDEVAL_ASSUME_YES, "1");
      queueMicrotask(() => {
        stdout.end("installer stdout\n");
        stderr.end("installer stderr\n");
        child.emit("close", 0);
      });
      return child;
    },
  });

  assert.equal(await receivedScript, "echo installing \"$1\"\n");
  await run;
  assert.match(Buffer.concat(stderrChunks).toString("utf8"), /installer stdout/);
  assert.match(Buffer.concat(stderrChunks).toString("utf8"), /installer stderr/);
});

test("runInstaller reports a helpful error on Windows", async () => {
  await assert.rejects(
    runInstaller({
      installerUrl: "https://example.test/install.sh",
      targetTag: "v0.12.0",
      platform: "win32",
      fetchImpl: async () => {
        throw new Error("fetch should not run on Windows");
      },
      spawnImpl: () => {
        throw new Error("spawn should not run on Windows");
      },
    }),
    /Automatic update currently requires bash/
  );
});

test("shouldAttemptVersionNudge avoids machine-readable and noninteractive contexts", () => {
  assert.equal(
    shouldAttemptVersionNudge({
      commandName: "ask",
      args: ["ask", "hello"],
      options: { format: "text" },
      env: {},
      stdinIsTTY: true,
      stdoutIsTTY: true,
      stderrIsTTY: true,
    }),
    true
  );
  assert.equal(
    shouldAttemptVersionNudge({
      commandName: "ask",
      args: ["ask", "hello", "--format", "json"],
      options: { format: "json" },
      env: {},
      stdinIsTTY: true,
      stdoutIsTTY: true,
      stderrIsTTY: true,
    }),
    false
  );
  assert.equal(
    shouldAttemptVersionNudge({
      commandName: "update",
      args: ["update"],
      options: { format: "text" },
      env: {},
      stdinIsTTY: true,
      stdoutIsTTY: true,
      stderrIsTTY: true,
    }),
    false
  );
  assert.equal(
    shouldAttemptVersionNudge({
      commandName: "reports",
      args: ["reports", "list"],
      options: { format: "text" },
      env: { CI: "true" },
      stdinIsTTY: true,
      stdoutIsTTY: true,
      stderrIsTTY: true,
    }),
    false
  );
});

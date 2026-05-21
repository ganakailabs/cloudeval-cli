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

test("formatUpdateStatusText mentions agent onboarding after updates", () => {
  const text = formatUpdateStatusText({
    currentVersion: "0.14.3",
    latestVersion: "0.14.4",
    latestTag: "v0.14.4",
    updateAvailable: true,
    checkedAt: "2026-05-10T22:00:00.000Z",
    releaseUrl: "https://example.test/releases/v0.14.4",
    publishedAt: "2026-05-10T21:59:00Z",
    action: "updated",
  });

  assert.match(text, /Status: updated/);
  assert.match(text, /MCP onboarding/);
  assert.match(text, /Codex, Claude, Cursor, or VS Code/);
  assert.match(text, /Restart or reload configured MCP clients when you are ready/);
  assert.match(text, /CloudEval does not restart those apps for you/);
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
      assert.equal(options.env?.CLOUDEVAL_INSTALL_AGENT_SETUP_PROMPT, undefined);
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

test("runInstaller can allow agent setup prompts while keeping install prompts skipped", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
  }) as unknown as ChildProcess;

  const run = runInstaller({
    installerUrl: "https://example.test/install.sh",
    targetTag: "v0.14.3",
    platform: "linux",
    env: { PATH: "/tmp/test-bin" },
    promptAgentSetup: true,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "echo installing \"$1\"\n",
    }) as Response,
    spawnImpl: (command, args, options) => {
      assert.equal(command, "bash");
      assert.deepEqual(args, ["-s", "--", "v0.14.3"]);
      assert.equal(options.env?.PATH, "/tmp/test-bin");
      assert.equal(options.env?.CLOUDEVAL_ASSUME_YES, "1");
      assert.equal(options.env?.CLOUDEVAL_INSTALL_AGENT_SETUP_PROMPT, "1");
      queueMicrotask(() => {
        stdout.end();
        stderr.end();
        child.emit("close", 0);
      });
      return child;
    },
  });

  await run;
});

test("runInstaller uses PowerShell on Windows", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
  }) as unknown as ChildProcess;

  const run = runInstaller({
    targetTag: "v0.12.0",
    platform: "win32",
    fetchImpl: async (url) => {
      assert.equal(url, "https://cli.cloudeval.ai/install.ps1");
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "Write-Host installing",
      } as Response;
    },
    spawnImpl: (command, args, options) => {
      assert.equal(command, "pwsh");
      assert.match(args[4] ?? "", /\.ps1$/);
      assert.equal(args[5], "v0.12.0");
      assert.equal(options.env?.CLOUDEVAL_ASSUME_YES, "1");
      queueMicrotask(() => {
        stdout.end("installer stdout\n");
        stderr.end("installer stderr\n");
        child.emit("close", 0);
      });
      return child;
    },
  });

  await run;
});

test("runInstaller reports a helpful error when pwsh is missing on Windows", async () => {
  await assert.rejects(
    runInstaller({
      installerUrl: "https://example.test/install.ps1",
      targetTag: "v0.12.0",
      platform: "win32",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "Write-Host installing",
      }) as Response,
      spawnImpl: () => {
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        }) as unknown as ChildProcess;
        queueMicrotask(() => child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })));
        return child;
      },
    }),
    /PowerShell 7 \(pwsh\)/
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

import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import {
  formatOutput,
  formatErrorEnvelope,
  formatSuccessEnvelope,
  writeTextToStream,
} from "./outputFormatter";

test("formatSuccessEnvelope creates stable machine envelope", () => {
  assert.deepEqual(
    formatSuccessEnvelope({
      command: "credits",
      data: { remaining: 42 },
      frontendUrl: "https://www.cloudeval.ai/app/subscription?tab=usage",
      warnings: ["low credits"],
      filesWritten: ["credits.json"],
      traceId: "trace-1",
      schemaVersion: "2026-07-ide-v1",
      freshness: { source: "report", observedAt: "2026-07-07T00:00:00.000Z", stale: false },
      evidence: [{ id: "ev-1", source: "report" }],
    }),
    {
      ok: true,
      command: "credits",
      data: { remaining: 42 },
      warnings: ["low credits"],
      frontendUrl: "https://www.cloudeval.ai/app/subscription?tab=usage",
      filesWritten: ["credits.json"],
      traceId: "trace-1",
      schemaVersion: "2026-07-ide-v1",
      freshness: { source: "report", observedAt: "2026-07-07T00:00:00.000Z", stale: false },
      evidence: [{ id: "ev-1", source: "report" }],
    }
  );
});

test("formatSuccessEnvelope includes IDE evidence metadata when provided", () => {
  assert.deepEqual(
    formatSuccessEnvelope({
      command: "review local",
      data: { runId: "run-1" },
      schemaVersion: "2026-07-ide-v1",
      freshness: {
        source: "local",
        observedAt: "2026-07-06T00:00:00.000Z",
        stale: false,
      },
      evidence: [
        {
          id: "evidence-1",
          source: "local",
          observedAt: "2026-07-06T00:00:00.000Z",
          description: "Local template validation evidence",
        },
      ],
    }),
    {
      ok: true,
      command: "review local",
      data: { runId: "run-1" },
      schemaVersion: "2026-07-ide-v1",
      freshness: {
        source: "local",
        observedAt: "2026-07-06T00:00:00.000Z",
        stale: false,
      },
      evidence: [
        {
          id: "evidence-1",
          source: "local",
          observedAt: "2026-07-06T00:00:00.000Z",
          description: "Local template validation evidence",
        },
      ],
    }
  );
});

test("formatErrorEnvelope creates stable machine error envelope", () => {
  assert.deepEqual(formatErrorEnvelope("auth", new Error("login required")), {
    ok: false,
    command: "auth",
    error: {
      message: "login required",
    },
  });
});

test("formatOutput serializes json markdown text and ndjson", () => {
  assert.equal(
    formatOutput({ format: "json", command: "test", data: { a: 1 } }),
    '{\n  "ok": true,\n  "command": "test",\n  "data": {\n    "a": 1\n  }\n}\n'
  );
  assert.equal(
    formatOutput({ format: "ndjson", command: "test", data: [{ a: 1 }, { b: 2 }] }),
    '{"a":1}\n{"b":2}\n'
  );
  assert.equal(
    formatOutput({ format: "markdown", command: "test", data: { a: 1 } }),
    "# test\n\n```json\n{\n  \"a\": 1\n}\n```\n"
  );
  assert.equal(
    formatOutput({ format: "text", command: "test", data: { a: 1 } }),
    "Field  Value\n-----  -----\na      1\n"
  );
});

test("formatOutput renders arrays of records as text tables", () => {
  assert.equal(
    formatOutput({
      format: "text",
      command: "test list",
      data: [
        { id: "one", name: "First", credits: 10 },
        { id: "two", name: "Second", credits: 20 },
      ],
    }),
    [
      "id   name    credits",
      "---  ------  -------",
      "one  First   10",
      "two  Second  20",
      "",
    ].join("\n")
  );
});

test("formatOutput renders arrays of scalar values as one-column text tables", () => {
  assert.equal(
    formatOutput({
      format: "text",
      command: "config profiles",
      data: ["default", "prod"],
    }),
    [
      "Value",
      "-------",
      "default",
      "prod",
      "",
    ].join("\n")
  );
});

test("formatOutput renders object array properties as named text tables", () => {
  assert.equal(
    formatOutput({
      format: "text",
      command: "models list",
      data: {
        models: [
          { id: "gpt-5-nano", provider: "OpenAI", availability: "available" },
        ],
        source: "backend",
      },
    }),
    [
      "Models",
      "id          provider  availability",
      "----------  --------  ------------",
      "gpt-5-nano  OpenAI    available",
      "",
      "Field   Value",
      "------  -------",
      "source  backend",
      "",
    ].join("\n")
  );
});

test("formatOutput renders nested objects as named text tables", () => {
  assert.equal(
    formatOutput({
      format: "text",
      command: "status",
      data: {
        profile: "default",
        auth: {
          authenticated: true,
          storageBackend: "macos-keychain",
        },
      },
    }),
    [
      "Field    Value",
      "-------  -------",
      "profile  default",
      "",
      "Auth",
      "Field           Value",
      "--------------  --------------",
      "authenticated   true",
      "storageBackend  macos-keychain",
      "",
    ].join("\n")
  );
});

test("formatOutput redacts sensitive account and session identifiers by default", () => {
  const sessionId = "63da1973-e92a-4d2e-8d01-4d8e131b3f21";
  const accountId = "5ed935a4-0814-4099-8b10-f6ef9ea74ff4";
  const tenantId = "11111111-2222-3333-4444-555555556666";
  const output = formatOutput({
    format: "json",
    command: "auth status",
    data: {
      sessionId,
      account_id: accountId,
      nested: {
        "Tenant ID": tenantId,
      },
      checkoutUrl: `https://app.example.test/checkout?session_id=${sessionId}&ok=1`,
    },
  });

  assert.doesNotMatch(output, new RegExp(sessionId));
  assert.doesNotMatch(output, new RegExp(accountId));
  assert.doesNotMatch(output, new RegExp(tenantId));
  assert.match(output, /63da\.\.\.3f21/);
  assert.match(output, /5ed9\.\.\.4ff4/);
  assert.match(output, /1111\.\.\.6666/);
  assert.match(output, /session_id=63da\.\.\.3f21/);
});

test("formatOutput redacts access keys and sensitive credential fields by default", () => {
  const accessKey = "cev_live_ak_01JTESTKEYVALUE_supersecretvalue";
  const output = formatOutput({
    format: "json",
    command: "diagnostics",
    data: {
      accessKey,
      access_key: accessKey,
      nested: {
        bearer: `Authorization: Bearer ${accessKey}`,
        url: `https://api.example.test/check?access_key=${accessKey}&ok=1`,
      },
    },
  });

  assert.doesNotMatch(output, new RegExp(accessKey));
  assert.match(output, /"accessKey": "\[redacted\]"/);
  assert.match(output, /"access_key": "\[redacted\]"/);
  assert.match(output, /Authorization: Bearer \[redacted\]/);
  assert.match(output, /access_key=%5Bredacted%5D/);
});

test("formatOutput can intentionally show one-time credential secrets", () => {
  const accessKey = "cev_test_ak_01JTESTKEYVALUE_createdsecret";
  const output = formatOutput({
    format: "json",
    command: "credentials create",
    data: { access_key: accessKey },
    redactSensitiveSecrets: false,
  });

  assert.match(output, new RegExp(accessKey));
});

test("formatErrorEnvelope redacts access keys from error messages", () => {
  const accessKey = "cev_test_ak_01JTESTKEYVALUE_errorsecret";
  const envelope = formatErrorEnvelope(
    "credentials list",
    new Error(`Backend rejected access_key ${accessKey}`)
  );

  assert.doesNotMatch(JSON.stringify(envelope), new RegExp(accessKey));
  assert.match(envelope.error.message, /\[redacted\]/);
});

test("writeTextToStream waits for drain when output is piped", async () => {
  let captured = "";
  const stream = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      setImmediate(() => {
        captured += chunk.toString();
        callback();
      });
    },
  });
  const text = JSON.stringify({ data: { body: "x".repeat(100_000) } });

  await writeTextToStream(stream, text);
  await new Promise<void>((resolve) => stream.end(resolve));

  assert.equal(JSON.parse(captured).data.body.length, 100_000);
});

test("formatOutput can show sensitive identifiers when explicitly requested", () => {
  const sessionId = "63da1973-e92a-4d2e-8d01-4d8e131b3f21";
  const output = formatOutput({
    format: "json",
    command: "auth status",
    showSensitiveIds: true,
    data: {
      sessionId,
      checkoutUrl: `https://app.example.test/checkout?session_id=${sessionId}`,
    },
  });

  assert.match(output, new RegExp(sessionId));
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  formatOutput,
  formatErrorEnvelope,
  formatSuccessEnvelope,
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
    }),
    {
      ok: true,
      command: "credits",
      data: { remaining: 42 },
      warnings: ["low credits"],
      frontendUrl: "https://www.cloudeval.ai/app/subscription?tab=usage",
      filesWritten: ["credits.json"],
      traceId: "trace-1",
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

import assert from "node:assert/strict";
import test from "node:test";
import { completeCliWords } from "./completionEngine.js";

test("completes root commands", () => {
  const result = completeCliWords(["re"]);
  assert.ok(result.some((candidate) => candidate.value === "reports"));
});

test("completes command options without duplicates", () => {
  const result = completeCliWords(["update", "--"]);
  assert.ok(result.some((candidate) => candidate.value === "--check"));

  const afterCheck = completeCliWords(["update", "--check", "--"]);
  assert.ok(!afterCheck.some((candidate) => candidate.value === "--check"));
});

test("completes known value options", () => {
  const result = completeCliWords(["tui", "--mode", "a"]);
  assert.deepEqual(
    result.map((candidate) => candidate.value),
    ["ask", "agent"]
  );
});

test("completes graph diagram options for interactive commands", () => {
  const tuiResult = completeCliWords(["tui", "--graph"]);
  const chatResult = completeCliWords(["chat", "--graph"]);

  assert.ok(tuiResult.some((candidate) => candidate.value === "--graph-diagram"));
  assert.ok(chatResult.some((candidate) => candidate.value === "--graph-diagram"));
});

test("completes completion command shell values", () => {
  const result = completeCliWords(["completion", "p"]);
  assert.deepEqual(
    result.map((candidate) => candidate.value),
    ["powershell"]
  );
});

test("strips leading binary name from completion words", () => {
  const stripped = completeCliWords(["cloudeval", "projects", ""]);
  assert.ok(stripped.every((c) => !c.value.startsWith("--")));
  assert.ok(stripped.some((c) => c.value === "list"));
});

test("projects subcommand phase lists only subcommands", () => {
  const result = completeCliWords(["projects", ""]);
  assert.ok(result.every((c) => !c.value.startsWith("--")));
  assert.ok(result.some((c) => c.value === "list"));
  assert.ok(result.some((c) => c.value === "create"));
});

test("billing topups chain suggests buy before options", () => {
  const result = completeCliWords(["billing", "topups", ""]);
  assert.deepEqual(
    result.map((c) => c.value),
    ["buy"]
  );
});

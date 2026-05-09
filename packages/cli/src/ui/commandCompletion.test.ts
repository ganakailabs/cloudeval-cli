import assert from "node:assert/strict";
import test from "node:test";
import {
  completePromptInput,
  resolvePromptCommand,
  type CompletionCycleState,
} from "./commandCompletion";

const context = {
  projects: [
    { id: "project-1", name: "CLI Project" },
    { id: "project-2", name: "Playground" },
  ],
  models: [
    { label: "Auto", value: "" },
    { label: "GPT-5 Nano", value: "gpt-5-nano" },
    { label: "GPT-5 Mini", value: "gpt-5-mini" },
  ],
  modes: [
    { label: "Ask", value: "ask" },
    { label: "Agent", value: "agent" },
  ],
};

test("completePromptInput does not pick a command for lone slash", () => {
  assert.equal(completePromptInput("/", context), null);
});

test("completePromptInput cycles ambiguous slash commands", () => {
  const first = completePromptInput("/mo", context);
  assert.equal(first?.value, "/model");
  assert.deepEqual(first?.candidates, ["/model", "/models", "/mode"]);
  assert.equal(first?.ghostSuffix, "del");

  const cycleState: CompletionCycleState = {
    source: first!.source,
    index: first!.index,
  };
  const second = completePromptInput("/mo", context, cycleState);
  assert.equal(second?.value, "/models");
  const third = completePromptInput("/mo", context, {
    source: second!.source,
    index: second!.index,
  });
  assert.equal(third?.value, "/mode");
});

test("completePromptInput completes model values", () => {
  const completion = completePromptInput("/model gpt-5-m", context);

  assert.equal(completion?.value, "/model gpt-5-mini");
  assert.deepEqual(completion?.candidates, ["gpt-5-mini"]);
  assert.equal(completion?.ghostSuffix, "ini");
});

test("resolvePromptCommand keeps bare /mode as selector command", () => {
  assert.deepEqual(resolvePromptCommand("/mode", context), {
    type: "openSelector",
    selector: "mode",
  });
});

test("resolvePromptCommand supports direct model and mode selection", () => {
  assert.deepEqual(resolvePromptCommand("/model gpt-5-mini", context), {
    type: "setModel",
    model: "gpt-5-mini",
    label: "GPT-5 Mini",
  });
  assert.deepEqual(resolvePromptCommand("/mode agent", context), {
    type: "setMode",
    mode: "agent",
    label: "Agent",
  });
});

test("resolvePromptCommand supports unique project prefix", () => {
  assert.deepEqual(resolvePromptCommand("/project cli", context), {
    type: "setProject",
    project: { id: "project-1", name: "CLI Project" },
  });
});

test("resolvePromptCommand supports chat stop aliases", () => {
  assert.deepEqual(resolvePromptCommand("/stop", context), { type: "stopChat" });
  assert.deepEqual(resolvePromptCommand("/cancel", context), { type: "stopChat" });
  assert.deepEqual(resolvePromptCommand("/abort", context), { type: "stopChat" });
});

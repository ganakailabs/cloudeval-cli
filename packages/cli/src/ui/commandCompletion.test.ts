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

test("completePromptInput cycles ambiguous slash commands", () => {
  const first = completePromptInput("/mo", context);
  assert.equal(first?.value, "/model");
  assert.deepEqual(first?.candidates, ["/model", "/mode"]);

  const cycleState: CompletionCycleState = {
    source: first!.source,
    index: first!.index,
  };
  const second = completePromptInput("/mo", context, cycleState);
  assert.equal(second?.value, "/mode");
});

test("completePromptInput completes model values", () => {
  const completion = completePromptInput("/model gpt-5-m", context);

  assert.equal(completion?.value, "/model gpt-5-mini");
  assert.deepEqual(completion?.candidates, ["gpt-5-mini"]);
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

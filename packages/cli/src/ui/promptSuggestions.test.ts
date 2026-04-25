import assert from "node:assert/strict";
import test from "node:test";
import { getPromptSuggestions, getStarterPrompts } from "./promptSuggestions";

test("getPromptSuggestions shows starter prompts when chat opens without messages", () => {
  const suggestions = getPromptSuggestions({
    latestFollowUps: [],
    messages: [],
    mode: "ask",
    project: { id: "playground", name: "Playground", cloud_provider: "azure" },
  });

  assert.equal(suggestions.kind, "starter");
  assert.equal(suggestions.label, "Starters");
  assert.equal(suggestions.prompts.length, 4);
  assert.ok(suggestions.prompts.every((prompt) => prompt.trim().length > 0));
});

test("getPromptSuggestions prefers backend follow-ups over starter prompts", () => {
  const suggestions = getPromptSuggestions({
    latestFollowUps: ["Explain the cost risk", "Show impacted resources"],
    messages: [],
    mode: "agent",
    project: { id: "playground", name: "Playground", type: "template" },
  });

  assert.deepEqual(suggestions, {
    kind: "followup",
    label: "Follow-ups",
    prompts: ["Explain the cost risk", "Show impacted resources"],
  });
});

test("getPromptSuggestions hides starter prompts after the user sends a message", () => {
  const suggestions = getPromptSuggestions({
    latestFollowUps: [],
    messages: [{ role: "user" }],
    mode: "ask",
    project: { id: "playground", name: "Playground" },
  });

  assert.deepEqual(suggestions, {
    kind: "none",
    label: "Follow-ups",
    prompts: [],
  });
});

test("getStarterPrompts aligns with frontend live agent prompt style", () => {
  const prompts = getStarterPrompts({
    mode: "agent",
    project: {
      id: "live-project",
      name: "Live Project",
      type: "sync",
      cloud_provider: "azure",
    },
  });

  assert.equal(prompts.length, 4);
  assert.ok(prompts.includes("Run cost evaluation report"));
});

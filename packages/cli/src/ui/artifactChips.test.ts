import assert from "node:assert/strict";
import test from "node:test";
import { buildChatArtifactChips } from "./artifactChips.js";

test("buildChatArtifactChips promotes project, report, issue, and web artifacts", () => {
  const chips = buildChatArtifactChips({
    projectName: "Playground",
    reportsStatus: "ready",
    coverageLabel: "87% coverage",
    topActionCount: 3,
    frontendThreadUrl: "https://cloudeval.ai/app/chat?thread=abc",
  });

  assert.deepEqual(
    chips.map((chip) => [chip.label, chip.value, chip.tone]),
    [
      ["Project", "Playground", "brand"],
      ["Reports", "87% coverage", "success"],
      ["Actions", "3 next", "warning"],
      ["Web", "open thread", "normal"],
    ]
  );
});

test("buildChatArtifactChips shows missing report state without noisy empty chips", () => {
  const chips = buildChatArtifactChips({
    projectName: "Playground",
    reportsStatus: "loading",
    topActionCount: 0,
  });

  assert.deepEqual(
    chips.map((chip) => [chip.label, chip.value, chip.tone]),
    [
      ["Project", "Playground", "brand"],
      ["Reports", "loading", "normal"],
    ]
  );
});

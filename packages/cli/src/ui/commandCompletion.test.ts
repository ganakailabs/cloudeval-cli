import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSlashCommandCompletionItems,
  completePromptInput,
  resolvePromptCommand,
  slashCommandGhostSuffix,
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
  profiles: [
    { label: "Profile", value: "" },
    { label: "Architecture", value: "architecture" },
    { label: "Cost", value: "cost" },
    { label: "Triage", value: "triage" },
    { label: "Remediation", value: "remediation" },
    { label: "Visual Explainer", value: "visual-explainer" },
    { label: "Scripter", value: "scripter" },
    { label: "Change Reviewer", value: "change-reviewer" },
    { label: "Evidence Auditor", value: "evidence-auditor" },
    { label: "Security Reviewer", value: "security-reviewer" },
  ],
  threads: [
    { label: "New thread", value: "new" },
    { label: "Review network drift", value: "draft-1" },
    { label: "Cost review", value: "thread-cost" },
    { label: "Architecture triage", value: "thread-arch" },
  ],
};

test("completePromptInput does not pick a command for lone slash", () => {
  assert.equal(completePromptInput("/", context), null);
});

test("buildSlashCommandCompletionItems exposes bottom command choices for slash input", () => {
  const all = buildSlashCommandCompletionItems("/");
  assert.ok(all.length >= 8);
  assert.deepEqual(all[0], {
    name: "/thread",
    aliases: ["/threads"],
    description: "Open session/thread selector or use /thread <title-or-id>.",
  });

  const partial = buildSlashCommandCompletionItems("/mo");
  assert.deepEqual(
    partial.map((item) => item.name),
    ["/model", "/mode"]
  );
  assert.equal(slashCommandGhostSuffix("/mo", partial[0]), "del");
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

test("completePromptInput and resolvePromptCommand support agent profile selection", () => {
  const completion = completePromptInput("/profile c", context);

  assert.equal(completion?.value, "/profile cost");
  assert.deepEqual(completion?.candidates, ["cost", "change-reviewer"]);
  assert.equal(completion?.ghostSuffix, "ost");

  assert.deepEqual(resolvePromptCommand("/profile", context), {
    type: "openSelector",
    selector: "profile",
  });
  assert.deepEqual(resolvePromptCommand("/profile cost", context), {
    type: "setProfile",
    profileId: "cost",
    label: "Cost",
  });
  assert.deepEqual(resolvePromptCommand("/profile default", context), {
    type: "setProfile",
    profileId: "",
    label: "Profile",
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

test("resolvePromptCommand opens and selects local threads", () => {
  assert.deepEqual(resolvePromptCommand("/thread", context), {
    type: "openSelector",
    selector: "thread",
  });
  assert.deepEqual(resolvePromptCommand("/thread cost", context), {
    type: "setThread",
    threadId: "thread-cost",
    label: "Cost review",
  });
  assert.deepEqual(resolvePromptCommand("/thread review", context), {
    type: "setThread",
    threadId: "draft-1",
    label: "Review network drift",
  });
});

test("resolvePromptCommand supports chat stop aliases", () => {
  assert.deepEqual(resolvePromptCommand("/stop", context), { type: "stopChat" });
  assert.deepEqual(resolvePromptCommand("/cancel", context), { type: "stopChat" });
  assert.deepEqual(resolvePromptCommand("/abort", context), { type: "stopChat" });
});

test("resolvePromptCommand shows starter selections on demand", () => {
  assert.equal(completePromptInput("/sta", context)?.value, "/starter");
  assert.deepEqual(resolvePromptCommand("/starter", context), {
    type: "showStarters",
  });
});

test("resolvePromptCommand supports response copy and transcript download", () => {
  assert.equal(completePromptInput("/co", context)?.value, "/copy");
  assert.deepEqual(resolvePromptCommand("/copy", context), {
    type: "copyLatestResponse",
  });
  assert.deepEqual(resolvePromptCommand("/download", context), {
    type: "downloadTranscript",
  });
  assert.deepEqual(resolvePromptCommand("/export", context), {
    type: "downloadTranscript",
  });
});

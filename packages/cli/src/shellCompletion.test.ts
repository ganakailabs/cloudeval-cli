import assert from "node:assert/strict";
import test from "node:test";
import { buildCompletionScript, normalizeCompletionShell } from "./shellCompletion";

test("normalizeCompletionShell accepts supported shells", () => {
  assert.equal(normalizeCompletionShell("zsh"), "zsh");
  assert.equal(normalizeCompletionShell("bash"), "bash");
  assert.equal(normalizeCompletionShell("fish"), "fish");
});

test("buildCompletionScript emits command and option completions", () => {
  const zsh = buildCompletionScript("zsh", "cloudeval");
  assert.match(zsh, /#compdef cloudeval eva/);
  assert.match(zsh, /chat:Start an interactive chat session/);
  assert.match(zsh, /--model/);

  const bash = buildCompletionScript("bash", "cloudeval");
  assert.match(bash, /complete -F _cloudeval_completion cloudeval eva/);
  assert.match(
    bash,
    /tui chat ask reports projects connections billing credits open capabilities login logout auth banner completion help/
  );
  assert.match(bash, /--template-url/);
  assert.match(bash, /--print-url/);
  assert.doesNotMatch(bash, /--sample/);

  const fish = buildCompletionScript("fish", "cloudeval");
  assert.match(fish, /complete -c cloudeval/);
  assert.match(fish, /-a "reports"/);
  assert.match(fish, /--long model/);
  assert.doesNotMatch(fish, /sample/);
});

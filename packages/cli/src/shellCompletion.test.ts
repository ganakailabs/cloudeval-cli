import assert from "node:assert/strict";
import test from "node:test";
import { buildCompletionScript, normalizeCompletionShell } from "./shellCompletion";

test("normalizeCompletionShell accepts supported shells", () => {
  assert.equal(normalizeCompletionShell("zsh"), "zsh");
  assert.equal(normalizeCompletionShell("bash"), "bash");
  assert.equal(normalizeCompletionShell("fish"), "fish");
  assert.equal(normalizeCompletionShell("pwsh"), "powershell");
  assert.equal(normalizeCompletionShell("powershell"), "powershell");
});

test("buildCompletionScript emits command and option completions", () => {
  const zsh = buildCompletionScript("zsh", "cloudeval");
  assert.match(zsh, /#compdef cloudeval eva/);
  assert.match(zsh, /cloudeval __complete/);
  assert.match(zsh, /cwords=/);
  assert.match(zsh, /_describe -t cloudeval-commands/);

  const bash = buildCompletionScript("bash", "cloudeval");
  assert.match(bash, /complete -o default -F _cloudeval_completion cloudeval eva/);
  assert.match(bash, /cloudeval __complete/);

  const fish = buildCompletionScript("fish", "cloudeval");
  assert.match(fish, /function __cloudeval_complete/);
  assert.match(fish, /complete -c cloudeval -f -a "\(__cloudeval_complete\)"/);

  const powershell = buildCompletionScript("powershell", "cloudeval");
  assert.match(powershell, /Register-ArgumentCompleter/);
  assert.match(powershell, /cloudeval __complete/);
});

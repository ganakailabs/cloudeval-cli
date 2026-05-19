import assert from "node:assert/strict";
import test from "node:test";
import { shouldEnableTuiAnimations } from "./animationPolicy.js";

test("TUI animations are enabled by default for active loaders", () => {
  assert.equal(shouldEnableTuiAnimations({ env: {} }), true);
});

test("TUI animations can be explicitly enabled", () => {
  assert.equal(shouldEnableTuiAnimations({ forceAnim: true, env: {} }), true);
  assert.equal(
    shouldEnableTuiAnimations({ env: { CLOUDEVAL_ANIM: "1" } }),
    true
  );
});

test("TUI animation disable flags override explicit animation requests", () => {
  assert.equal(
    shouldEnableTuiAnimations({ forceAnim: true, disableAnim: true, env: {} }),
    false
  );
  assert.equal(
    shouldEnableTuiAnimations({
      forceAnim: true,
      env: { CLOUDEVAL_NO_ANIM: "1" },
    }),
    false
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { shouldEnableTuiAnimations } from "./animationPolicy.js";

test("TUI animations are disabled by default to avoid idle redraw flicker", () => {
  assert.equal(shouldEnableTuiAnimations({ env: {} }), false);
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

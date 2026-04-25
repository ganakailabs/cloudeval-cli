import assert from "node:assert/strict";
import test from "node:test";
import { shouldAutoScrollToBottom } from "./scrollBehavior";

test("shouldAutoScrollToBottom suppresses auto-scroll after manual reasoning toggle", () => {
  assert.equal(
    shouldAutoScrollToBottom({
      currentOffset: 90,
      previousContentHeight: 100,
      viewportHeight: 10,
      suppressNextAutoScroll: true,
    }),
    false
  );
});

test("shouldAutoScrollToBottom follows streaming when already near bottom", () => {
  assert.equal(
    shouldAutoScrollToBottom({
      currentOffset: 88,
      previousContentHeight: 100,
      viewportHeight: 10,
      suppressNextAutoScroll: false,
    }),
    true
  );
});

test("shouldAutoScrollToBottom preserves viewport when not near bottom", () => {
  assert.equal(
    shouldAutoScrollToBottom({
      currentOffset: 40,
      previousContentHeight: 100,
      viewportHeight: 10,
      suppressNextAutoScroll: false,
    }),
    false
  );
});

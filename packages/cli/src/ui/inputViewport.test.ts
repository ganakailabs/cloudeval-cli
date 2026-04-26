import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInputRows,
  getInputViewport,
  nextInputScrollOffset,
} from "./inputViewport";

test("buildInputRows preserves logical newlines instead of merging text", () => {
  assert.deepEqual(buildInputRows("alpha\nbeta gamma", 5), [
    "alpha",
    "beta ",
    "gamma",
  ]);
});

test("getInputViewport can render a scrolled multiline input window", () => {
  const value = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n");
  const bottom = getInputViewport({
    value,
    width: 20,
    minRows: 2,
    maxRows: 3,
    scrollOffset: Number.MAX_SAFE_INTEGER,
  });

  assert.equal(bottom.startRow, 5);
  assert.equal(bottom.maxScrollOffset, 5);
  assert.deepEqual(bottom.visibleRows, ["line 6", "line 7", "line 8"]);

  const nextOffset = nextInputScrollOffset({
    currentOffset: bottom.startRow,
    delta: -2,
    maxScrollOffset: bottom.maxScrollOffset,
  });
  const scrolled = getInputViewport({
    value,
    width: 20,
    minRows: 2,
    maxRows: 3,
    scrollOffset: nextOffset,
  });

  assert.equal(nextOffset, 3);
  assert.deepEqual(scrolled.visibleRows, ["line 4", "line 5", "line 6"]);
});

test("getInputViewport defaults to a taller multiline input window", () => {
  const value = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
  const viewport = getInputViewport({
    value,
    width: 20,
    scrollOffset: Number.MAX_SAFE_INTEGER,
  });

  assert.equal(viewport.visibleRowCount, 8);
  assert.equal(viewport.maxScrollOffset, 4);
  assert.deepEqual(viewport.visibleRows, [
    "line 5",
    "line 6",
    "line 7",
    "line 8",
    "line 9",
    "line 10",
    "line 11",
    "line 12",
  ]);
});

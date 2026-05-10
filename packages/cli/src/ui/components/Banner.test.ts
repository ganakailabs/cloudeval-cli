import assert from "node:assert/strict";
import test from "node:test";
import "../../runtime/prepareInk";
import { bannerSegmentColor, splitBannerLineSegments } from "./Banner.js";

test("splitBannerLineSegments separates fill and outline glyphs for color rendering", () => {
  assert.deepEqual(splitBannerLineSegments("██╔═  ╚█"), [
    { text: "██", tone: "fill" },
    { text: "╔═", tone: "outline" },
    { text: "  ", tone: "space" },
    { text: "╚", tone: "outline" },
    { text: "█", tone: "fill" },
  ]);
});

test("bannerSegmentColor applies a warm row gradient to banner glyphs", () => {
  const previousNoColor = process.env.NO_COLOR;
  const previousTerm = process.env.TERM;
  delete process.env.NO_COLOR;
  process.env.TERM = "xterm-256color";
  try {
    assert.equal(bannerSegmentColor("fill", 0, 6), "#ffd60a");
    assert.equal(bannerSegmentColor("fill", 3, 6), "#f59e0b");
    assert.equal(bannerSegmentColor("fill", 5, 6), "#b45309");
    assert.equal(bannerSegmentColor("outline", 5, 6), "#7c2d12");
    assert.equal(bannerSegmentColor("space", 2, 6), undefined);
  } finally {
    if (previousNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = previousNoColor;
    }
    if (previousTerm === undefined) {
      delete process.env.TERM;
    } else {
      process.env.TERM = previousTerm;
    }
  }
});

test("bannerSegmentColor disables gradient colors when terminal color is disabled", () => {
  const previousNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    assert.equal(bannerSegmentColor("fill", 0, 6), undefined);
    assert.equal(bannerSegmentColor("outline", 0, 6), undefined);
  } finally {
    if (previousNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = previousNoColor;
    }
  }
});

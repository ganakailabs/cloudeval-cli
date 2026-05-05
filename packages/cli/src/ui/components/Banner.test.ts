import assert from "node:assert/strict";
import test from "node:test";
import "../../runtime/prepareInk";
import { splitBannerLineSegments } from "./Banner.js";

test("splitBannerLineSegments separates fill and outline glyphs for color rendering", () => {
  assert.deepEqual(splitBannerLineSegments("██╔═  ╚█"), [
    { text: "██", tone: "fill" },
    { text: "╔═", tone: "outline" },
    { text: "  ", tone: "space" },
    { text: "╚", tone: "outline" },
    { text: "█", tone: "fill" },
  ]);
});

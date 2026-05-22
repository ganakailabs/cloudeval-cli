import assert from "node:assert/strict";
import test from "node:test";
import "../../runtime/prepareInk";
import {
  getLoaderStepMarker,
  getSpinnerFrames,
  SPINNER_FRAME_INTERVAL_MS,
} from "./Spinner.js";

test("getSpinnerFrames uses one shared loader vocabulary", () => {
  assert.deepEqual(getSpinnerFrames("dots"), getSpinnerFrames("line"));
  assert.deepEqual(getSpinnerFrames("pulse"), getSpinnerFrames("line"));
  assert.ok(SPINNER_FRAME_INTERVAL_MS >= 300);
});

test("getLoaderStepMarker uses the same active frame as inline spinners", () => {
  assert.equal(getLoaderStepMarker("active", 1), getSpinnerFrames("line")[1]);
  assert.equal(getLoaderStepMarker("complete", 1), "✓");
  assert.equal(getLoaderStepMarker("pending", 1), "·");
});

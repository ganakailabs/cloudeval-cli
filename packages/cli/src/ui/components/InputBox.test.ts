import assert from "node:assert/strict";
import test from "node:test";
import "../../runtime/prepareInk";
import { shouldSubmitInputOnReturn } from "../inputSubmitBehavior";
import { getFollowUpRowViewport, shouldAnimateInputCursor } from "./InputBox";
import { LOADER_FRAME_INTERVAL_MS } from "./Loader";
import {
  SPINNER_FRAME_INTERVAL_MS,
  shouldAnimateSpinner,
} from "./Spinner";

test("shouldSubmitInputOnReturn lets empty Enter open focused controls", () => {
  assert.equal(shouldSubmitInputOnReturn(""), false);
  assert.equal(shouldSubmitInputOnReturn("   \n  "), false);
  assert.equal(shouldSubmitInputOnReturn("select model"), true);
  assert.equal(shouldSubmitInputOnReturn("/model"), true);
});

test("input cursor stays static by default to avoid idle TUI redraws", () => {
  assert.equal(shouldAnimateInputCursor({ disabled: false }), false);
  assert.equal(
    shouldAnimateInputCursor({ disabled: false, blinkCursor: true }),
    true
  );
  assert.equal(
    shouldAnimateInputCursor({ disabled: true, blinkCursor: true }),
    false
  );
});

test("spinner animation can be disabled and is throttled", () => {
  assert.equal(shouldAnimateSpinner(false), false);
  assert.equal(shouldAnimateSpinner(true), true);
  assert.ok(
    SPINNER_FRAME_INTERVAL_MS >= 300,
    "spinner interval should avoid high-frequency full TUI repaints"
  );
  assert.ok(
    LOADER_FRAME_INTERVAL_MS >= 300,
    "loader interval should avoid high-frequency full TUI repaints"
  );
});

test("getFollowUpRowViewport keeps prompts to one horizontal row with overflow markers", () => {
  const viewport = getFollowUpRowViewport({
    followUps: [
      "Review the cost report",
      "Generate a WAF summary",
      "Open the project dashboard",
      "Explain the failed checks",
    ],
    focusedFollowUpIndex: 3,
    terminalColumns: 54,
  });

  assert.equal(viewport.rowCount, 1);
  assert.equal(viewport.clippedStart, true);
  assert.equal(viewport.clippedEnd, false);
  assert.deepEqual(
    viewport.items.map((item) => item.index),
    [2, 3]
  );
});

test("getFollowUpRowViewport keeps full prompt labels when they fit", () => {
  const firstPrompt = "Explain this template structure carefully";
  const secondPrompt = "Summarize deployment requirements quickly";
  const viewport = getFollowUpRowViewport({
    followUps: [firstPrompt, secondPrompt],
    terminalColumns: 120,
  });

  assert.equal(viewport.clippedStart, false);
  assert.equal(viewport.clippedEnd, false);
  assert.equal(viewport.items[0]?.label, `1. ${firstPrompt}`);
  assert.equal(viewport.items[1]?.label, `2. ${secondPrompt}`);
});

import assert from "node:assert/strict";
import test from "node:test";
import { classifyNoticeTone } from "./noticeTone.js";

test("classifyNoticeTone marks downloads and copies as success", () => {
  assert.equal(
    classifyNoticeTone("Downloaded chat transcript: /tmp/transcript.md"),
    "success"
  );
  assert.equal(classifyNoticeTone("Copied latest response with numbered citations."), "success");
});

test("classifyNoticeTone marks failures as danger", () => {
  assert.equal(classifyNoticeTone("Copy failed: clipboard unavailable"), "danger");
  assert.equal(classifyNoticeTone("Failed to download chat transcript: disk full"), "danger");
});

test("classifyNoticeTone marks frontend links as info", () => {
  assert.equal(
    classifyNoticeTone("Frontend link: https://cloudeval.ai/chat/thread-1"),
    "info"
  );
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

test("CLI review fallback delegates deterministic wording to the CloudEval SignalStory rule package", () => {
  const adapter = fs.readFileSync(
    path.join(currentDir, "signalstoryReviewAdapter.ts"),
    "utf8"
  );
  const reviewCommand = fs.readFileSync(
    path.join(currentDir, "reviewCommand.ts"),
    "utf8"
  );

  assert.match(
    adapter,
    /@ganakailabs\/cloudeval-signalstory-rules\/review/
  );
  assert.doesNotMatch(adapter, /REVIEW_FALLBACK_RULE_PACK\s*=/);
  assert.doesNotMatch(reviewCommand, /CloudEval review completed with/);
});

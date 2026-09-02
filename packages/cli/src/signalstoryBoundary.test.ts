import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

test("CLI review fallback has no private package dependency", () => {
  const adapter = fs.readFileSync(
    path.join(currentDir, "signalstoryReviewAdapter.ts"),
    "utf8"
  );
  const reviewCommand = fs.readFileSync(
    path.join(currentDir, "reviewCommand.ts"),
    "utf8"
  );

  assert.doesNotMatch(adapter, /@ganakailabs\/cloudeval-signalstory-rules/);
  assert.doesNotMatch(adapter, /from "signalstory\//);
  assert.doesNotMatch(reviewCommand, /Cloudeval review completed with/);
});

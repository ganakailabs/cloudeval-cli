import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const textExtensions = new Set([
  ".cjs",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sh",
  ".ts",
  ".txt",
  ".yml",
  ".yaml",
]);
const excludedFiles = new Set([
  "pnpm-lock.yaml",
  "scripts/brand-consistency.test.mjs",
]);
const allowedTechnicalNames = [
  "CloudEval Live Sync Reader",
  "LicenseRef-CloudEval-CLI",
  "SPDXRef-Package-CloudEval-CLI",
  "X-CloudEval",
];

function trackedTextFiles() {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .filter((file) => textExtensions.has(path.extname(file)))
    .filter((file) => !excludedFiles.has(file));
}

function withoutAllowedTechnicalNames(text) {
  const normalized = text.replaceAll("\\n", " ").replaceAll("\\t", " ");
  return allowedTechnicalNames.reduce(
    (copy, technicalName) => copy.replaceAll(technicalName, ""),
    normalized
  );
}

test("visible product copy uses Cloudeval casing", () => {
  const legacyReferences = trackedTextFiles().flatMap((file) =>
    fs
      .readFileSync(path.join(root, file), "utf8")
      .split("\n")
      .map((line, index) => ({ file, line: index + 1, text: line.trim() }))
      .filter(({ text }) =>
        /\bCloudEval\b/.test(withoutAllowedTechnicalNames(text))
      )
  );

  assert.deepEqual(legacyReferences, []);
});

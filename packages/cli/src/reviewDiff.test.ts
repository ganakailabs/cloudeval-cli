import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectReviewDiff, parseReviewDiffConfig } from "./reviewDiff.js";

const git = async (cwd: string, args: string[]): Promise<string> => {
  const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const exitCode = await new Promise<number | null>((resolve) =>
    child.on("exit", resolve),
  );
  if (exitCode !== 0) {
    throw new Error(Buffer.concat(stderr).toString("utf8"));
  }
  return Buffer.concat(stdout).toString("utf8").trim();
};

test("collectReviewDiff captures committed file changes and patch snippets", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-review-diff-"));
  try {
    await git(cwd, ["init", "-b", "main"]);
    await git(cwd, ["config", "user.email", "review@example.test"]);
    await git(cwd, ["config", "user.name", "Review Test"]);
    await fs.mkdir(path.join(cwd, "infra", "nested"), { recursive: true });
    await fs.writeFile(path.join(cwd, "infra", "main.json"), "{}\n", "utf8");
    await fs.writeFile(
      path.join(cwd, "infra", "nested", "network.json"),
      '{"resources":[]}\n',
      "utf8",
    );
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "base"]);

    await fs.writeFile(
      path.join(cwd, "infra", "nested", "network.json"),
      '{"resources":[{"type":"Microsoft.Network/virtualNetworks"}]}\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(cwd, "infra", "nested", "compute.json"),
      '{"resources":[{"type":"Microsoft.Compute/virtualMachines"}]}\n',
      "utf8",
    );
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "feature"]);

    const result = await collectReviewDiff({
      cwd,
      baseRef: "HEAD~1",
      headRef: "HEAD",
      maxFiles: 50,
      maxPatchBytes: 20_000,
    });

    assert.equal(result.summary.files_changed, 2);
    assert.equal(result.summary.base_ref, "HEAD~1");
    assert.match(result.summary.base_commit_sha ?? "", /^[a-f0-9]{40}$/);
    assert.match(result.summary.head_commit_sha ?? "", /^[a-f0-9]{40}$/);
    assert.deepEqual(
      result.changedFiles.map((file) => [file.path, file.status]),
      [
        ["infra/nested/compute.json", "added"],
        ["infra/nested/network.json", "modified"],
      ],
    );
    assert.equal(result.changedFiles[0].additions, 1);
    assert.match(result.changedFiles[1].patch ?? "", /Microsoft\.Network\/virtualNetworks/);
    assert.deepEqual(result.warnings, []);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("parseReviewDiffConfig reads public ci review diff keys", () => {
  const config = parseReviewDiffConfig(`
ci:
  review:
    diff:
      enabled: true
      base_ref: release/main
      max_files: 42
      max_patch_bytes: 1234
`);

  assert.deepEqual(config, {
    enabled: true,
    baseRef: "release/main",
    maxFiles: 42,
    maxPatchBytes: 1234,
  });
});

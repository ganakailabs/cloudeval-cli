#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cliRoot = path.join(repoRoot, "packages", "cli");

const run = (args) => {
  execFileSync("pnpm", args, {
    cwd: repoRoot,
    stdio: "inherit",
  });
};

run(["license:artifacts"]);
run(["--filter", "@cloudeval/shared", "build"]);
run(["--filter", "@cloudeval/core", "build"]);
run(["--filter", "@ganakailabs/cloudeval-cli", "build"]);

for (const file of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "sbom.spdx.json"]) {
  const source = path.join(repoRoot, file);
  if (!existsSync(source)) {
    throw new Error(`Missing required npm package artifact: ${file}`);
  }
  copyFileSync(source, path.join(cliRoot, file));
}

console.log("ok - prepared CloudEval CLI npm package artifacts");

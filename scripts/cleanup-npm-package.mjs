#!/usr/bin/env node
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(__dirname, "..", "packages", "cli");

for (const file of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "sbom.spdx.json"]) {
  rmSync(path.join(cliRoot, file), { force: true });
}

console.log("ok - cleaned temporary CloudEval CLI npm package artifacts");

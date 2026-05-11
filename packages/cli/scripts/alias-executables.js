import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const binDir = path.resolve(scriptDir, "..", "dist", "bin");

if (!fs.existsSync(binDir)) {
  process.exit(0);
}

const entries = fs.readdirSync(binDir);
const aliases = ["eva", "cloud"];

for (const entry of entries) {
  if (!entry.startsWith("cloudeval")) continue;
  const src = path.join(binDir, entry);
  for (const alias of aliases) {
    const dest = path.join(binDir, entry.replace(/^cloudeval/, alias));
    if (src === dest) continue;
    fs.copyFileSync(src, dest);
  }
}

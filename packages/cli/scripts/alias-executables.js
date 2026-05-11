import fs from "node:fs";
import path from "node:path";

const binDir = path.resolve("dist", "bin");

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

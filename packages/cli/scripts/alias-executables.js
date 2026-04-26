import fs from "node:fs";
import path from "node:path";

const binDir = path.resolve("dist", "bin");

if (!fs.existsSync(binDir)) {
  process.exit(0);
}

const entries = fs.readdirSync(binDir);

for (const entry of entries) {
  if (!entry.startsWith("cloudeval")) continue;
  const src = path.join(binDir, entry);
  const dest = path.join(binDir, entry.replace(/^cloudeval/, "eva"));
  if (src === dest) continue;
  fs.copyFileSync(src, dest);
}

import fs from "node:fs";
import path from "node:path";

const findRepoRoot = (start) => {
  let dir = start;
  while (dir && dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return start;
};

const root = findRepoRoot(process.cwd());
const candidates = [
  path.join(root, "node_modules", "yoga-wasm-web", "dist", "yoga.wasm"),
  path.join(root, "node_modules", ".pnpm"),
];

const direct = candidates[0];
if (fs.existsSync(direct)) {
  console.log(direct);
  process.exit(0);
}

const pnpmRoot = candidates[1];
if (fs.existsSync(pnpmRoot)) {
  const entries = fs.readdirSync(pnpmRoot);
  for (const entry of entries) {
    if (!entry.startsWith("yoga-wasm-web@")) continue;
    const candidate = path.join(
      pnpmRoot,
      entry,
      "node_modules",
      "yoga-wasm-web",
      "dist",
      "yoga.wasm"
    );
    if (fs.existsSync(candidate)) {
      console.log(candidate);
      process.exit(0);
    }
  }
}

console.error("yoga.wasm not found");
process.exit(1);

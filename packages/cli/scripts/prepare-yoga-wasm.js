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
const pnpmRoot = path.join(root, "node_modules", ".pnpm");
const direct = path.join(root, "node_modules", "yoga-wasm-web", "dist", "yoga.wasm");

let source = null;
if (fs.existsSync(direct)) {
  source = direct;
} else if (fs.existsSync(pnpmRoot)) {
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
      source = candidate;
      break;
    }
  }
}

if (!source) {
  console.error("yoga.wasm not found");
  process.exit(1);
}

const dest = path.join(process.cwd(), "yoga.wasm");
fs.copyFileSync(source, dest);
console.log(dest);

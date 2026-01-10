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

const findDistDir = () => {
  const direct = path.join(root, "node_modules", "yoga-wasm-web", "dist");
  if (fs.existsSync(direct)) return direct;
  if (!fs.existsSync(pnpmRoot)) return null;
  const entries = fs.readdirSync(pnpmRoot);
  for (const entry of entries) {
    if (!entry.startsWith("yoga-wasm-web@")) continue;
    const candidate = path.join(
      pnpmRoot,
      entry,
      "node_modules",
      "yoga-wasm-web",
      "dist"
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};

const distDir = findDistDir();
if (!distDir) {
  console.error("yoga-wasm-web dist not found");
  process.exit(1);
}

const jsFiles = fs
  .readdirSync(distDir)
  .filter((name) => name.endsWith(".js"));

let patched = 0;
for (const file of jsFiles) {
  const filePath = path.join(distDir, file);
  let content = fs.readFileSync(filePath, "utf8");
  if (!content.includes("yoga.wasm")) {
    continue;
  }

  // Remove any previously injected prelude to avoid duplicate declarations.
  content = content.replace(
    /import path from"node:path";import\{pathToFileURL as __cloudevalPathToFileURL\}from"node:url";const __cloudevalWasmPath=[^;]+;const __cloudevalWasmUrl=__cloudevalPathToFileURL\(__cloudevalWasmPath\);/g,
    ""
  );

  const prelude =
    'import path from"node:path";import{pathToFileURL as __cloudevalPathToFileURL}from"node:url";' +
    'const __cloudevalWasmPath=process.env.CLOUDEVAL_YOGA_WASM??path.join(path.dirname(process.execPath),"yoga.wasm");' +
    'const __cloudevalWasmUrl=__cloudevalPathToFileURL(__cloudevalWasmPath);';
  content = prelude + content;
  content = content.replace(
    /new URL\("\.\/yoga\.wasm",import\.meta\.url\)/g,
    "__cloudevalWasmUrl"
  );
  content = content.replace(
    /_\(import\.meta\.url\)\.resolve\("\.\/yoga\.wasm"\)/g,
    "__cloudevalWasmPath"
  );
  content = content.replace(
    /await E\(__cloudevalWasmPath\)/g,
    "await E(__cloudevalWasmPath)"
  );
  content = content.replace(
    /await E\(_\(import\.meta\.url\)\.resolve\("\.\/yoga\.wasm"\)\)/g,
    "await E(__cloudevalWasmPath)"
  );
  content = content.replace(/r="yoga\.wasm"/g, "r=__cloudevalWasmPath");

  fs.writeFileSync(filePath, content, "utf8");
  patched += 1;
}

if (patched === 0) {
  console.error("No yoga-wasm-web files patched");
  process.exit(1);
}

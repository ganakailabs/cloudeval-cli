import { defineConfig } from "tsup";

// Special config for creating executables with pkg
// pkg works better with CJS, so we'll create a CJS bundle
export default defineConfig({
  entry: ["src/cli.tsx"],
  format: ["cjs"], // Use CJS for pkg compatibility
  dts: false, // No types needed for executable
  splitting: false,
  sourcemap: false,
  clean: false, // Don't clean, we want both builds
  target: "node18", // pkg supports node18
  outDir: "dist",
  outExtension() {
    return {
      js: `.executable.js`, // Different name to avoid conflicts
    };
  },
  tsconfig: "./tsconfig.json",
  // Try to bundle everything for executable
  // Note: ink and yoga-wasm-web use top-level await, so they must be external
  noExternal: [
    "@cloudeval/core",
    "@cloudeval/shared",
    "commander",
  ],
  external: [
    "ink",
    "ink-big-text",
    "ink-scroll-view",
    "ink-text-input",
    "ink-spinner",
    "react",
    "react-devtools-core",
    "yoga-wasm-web",
    "yoga-wasm",
  ],
  esbuildOptions(options) {
    options.jsx = "automatic";
    options.bundle = true;
    options.platform = "node";
  },
});





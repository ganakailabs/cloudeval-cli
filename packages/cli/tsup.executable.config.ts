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
  noExternal: [
    "@cloudeval/core",
    "@cloudeval/shared",
    "commander",
    "ink",
    "ink-big-text",
    "ink-scroll-view",
    "ink-text-input",
    "react",
  ],
  external: [],
  esbuildOptions(options) {
    options.jsx = "automatic";
    options.bundle = true;
    options.platform = "node";
  },
});





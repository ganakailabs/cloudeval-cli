import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.tsx"],
  outExtension() {
    return {
      js: `.js`,
    };
  },
  format: ["esm"],
  dts: {
    resolve: true,
  },
  splitting: false,
  sourcemap: false, // Disable sourcemaps for smaller bundle
  clean: true,
  target: "node20",
  tsconfig: "./tsconfig.json",
  // Bundle only our workspace packages; keep ink plugins external to avoid TLA/interop issues
  noExternal: ["@cloudeval/core", "@cloudeval/shared"],
  external: [
    "ink",
    "react",
    "commander",
    "ink-big-text",
    "ink-scroll-view",
    "ink-text-input",
    "ink-spinner",
  ],
  esbuildOptions(options) {
    options.jsx = "automatic";
    options.bundle = true;
    options.minify = false; // Set to true for production minification
  },
});

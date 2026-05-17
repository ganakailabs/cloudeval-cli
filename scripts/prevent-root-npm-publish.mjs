#!/usr/bin/env node

console.error(`CloudEval CLI is published from packages/cli, not the monorepo root.

Run:
  cd packages/cli
  npm publish --access public --provenance

For a final check before publishing:
  cd packages/cli
  npm publish --dry-run --access public

Stop if the tarball name is cloudeval-cli-monorepo or the file list includes local smoke artifacts.
`);

process.exitCode = 1;

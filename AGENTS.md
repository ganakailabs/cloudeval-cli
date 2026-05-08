# Agent Guidance

- Never inspect or quote `.cloudeval-downloads/`, `~/.config/cloudeval`,
  `.env*`, secrets, session databases, or smoke artifacts unless the user
  explicitly asks for that exact local data.
- Never paste full tokens, account IDs, session IDs, tenant IDs, customer
  emails, project report JSON, or billing ledger data. Use redacted summaries
  for security reviews and operational debugging by default.
- Keep public docs in sync with CLI changes. When changing command names,
  options, output shape, install/update behavior, MCP tools, MCP setup, smoke
  tests, or any other user-facing behavior, update the relevant docs in the
  same change (`README.md`, `docs/index.html`, `docs/release-smoke-tests.md`,
  and command examples as applicable).
- Prefer documenting both human-facing text behavior and machine-readable
  formats when a command supports `--format`.
- Before finishing public CLI changes, run the targeted tests for the changed
  surface and at least a help/status smoke for any newly documented command.

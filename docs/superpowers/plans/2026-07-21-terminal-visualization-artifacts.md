# Terminal Visualization Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Cloudeval negotiate presentation capabilities, generate one canonical chart or diagram artifact, render it in the existing web chat, and render deterministic Unicode visualizations in the CLI without persisting terminal escape sequences.

**Architecture:** The client sends an additive `presentation` capability object with its normal chat request. The backend resolves those capabilities against `X-Client-Type`, generates compact semantic chart intent, compiles charts with `flint-chart@0.3.0`, persists canonical Markdown, and optionally emits a versioned `visualization` SSE artifact. The frontend renders `flint` artifacts through existing Chart.js/ECharts components; the CLI validates the same artifact schema and converts charts or Mermaid source into width-aware Unicode with table, edge-list, and source fallbacks.

**Tech Stack:** Python 3.12, FastAPI/Pydantic, Node.js 20, `flint-chart@0.3.0`, TypeScript, React/Next.js, Chart.js, ECharts, Ink, `asciichart`, Jest, Node test runner, Pytest, pnpm workspaces, semantic-release.

---

## Repository roots and guardrails

- CLI worktree: `/Users/prateek/.config/superpowers/worktrees/cloudeval-cli/terminal-visualization-artifacts`
- Backend worktree: `/Users/prateek/.config/superpowers/worktrees/cloudeval-backend/terminal-visualization-artifacts`
- Frontend worktree: `/Users/prateek/.config/superpowers/worktrees/cloudeval-frontend/terminal-visualization-artifacts`
- Keep the schema identifier exactly `cloudeval.visualization/v1` in all three repositories.
- Treat request capabilities and artifact fields as untrusted input. Bound array sizes, string sizes, row counts, and Mermaid source before rendering.
- Keep Markdown fences as the persisted replay contract. Structured SSE artifacts are additive live-delivery hints and must de-duplicate by artifact `id`.
- Never store ANSI control sequences in messages, histories, or backend data.
- Keep the legacy web `chart` fence path working during rollout.
- Do not manually bump the CLI version; semantic-release owns the package version.

## Task 1: Freeze the cross-repository contract with failing tests

**Files:**

- Create: `/Users/prateek/.config/superpowers/worktrees/cloudeval-cli/terminal-visualization-artifacts/packages/shared/src/visualizationArtifacts.test.ts`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-cli/terminal-visualization-artifacts/packages/shared/package.json`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-cli/terminal-visualization-artifacts/packages/core/src/streamClient.test.ts`
- Create: `/Users/prateek/.config/superpowers/worktrees/cloudeval-cli/terminal-visualization-artifacts/packages/core/src/reducer.test.ts`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-frontend/terminal-visualization-artifacts/lib/langgraph/client.test.ts`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-backend/terminal-visualization-artifacts/tests/test_chat_request_validation.py`
- Create: `/Users/prateek/.config/superpowers/worktrees/cloudeval-backend/terminal-visualization-artifacts/agent/tests/test_visualization_artifacts.py`

- [ ] Add the same valid fixture to each test suite:

```json
{
  "schema": "cloudeval.visualization/v1",
  "id": "monthly-cost-by-service",
  "kind": "chart",
  "format": "flint",
  "title": "Monthly cost by service",
  "renderer": "chartjs",
  "data": {
    "values": [
      { "service": "Compute", "cost": 120 },
      { "service": "Storage", "cost": 40 }
    ]
  },
  "spec": {
    "type": "bar",
    "x": { "field": "service", "type": "nominal" },
    "y": { "field": "cost", "type": "quantitative" }
  },
  "config": {},
  "fallback": {
    "type": "table",
    "columns": ["service", "cost"],
    "rows": [["Compute", 120], ["Storage", 40]]
  }
}
```

- [ ] Test request negotiation fields: `profile`, `artifact_schema`, `accepts`, and `fallbacks`.
- [ ] Test rejection of an unknown schema, overlong lists, invalid artifact IDs, too many rows, unsafe control characters, and malformed renderer configs.
- [ ] Test parsing of complete `flint`, `chart`, and `mermaid` fences, and test that an incomplete streaming fence is ignored until closed.
- [ ] Test artifact de-duplication by `id` and a deterministic legacy Chart.js-to-v1 wrapper.
- [ ] Run each new test and confirm it fails for the missing contract:

```bash
pnpm --filter @cloudeval/shared test -- visualizationArtifacts
npx jest lib/langgraph/client.test.ts --runInBand
PYTHONPATH=. /Users/prateek/workspace/repo/cloudeval-backend/.venv/bin/python -m pytest tests/test_chat_request_validation.py agent/tests/test_visualization_artifacts.py -q
```

Expected: assertions fail because capability payloads, artifact parsing, and validation do not exist yet.

## Task 2: Implement the shared CLI artifact contract and capability payload

**Files:**

- Create: `/Users/prateek/.config/superpowers/worktrees/cloudeval-cli/terminal-visualization-artifacts/packages/shared/src/visualizationArtifacts.ts`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-cli/terminal-visualization-artifacts/packages/shared/package.json`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-cli/terminal-visualization-artifacts/packages/shared/src/index.ts`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-cli/terminal-visualization-artifacts/packages/shared/src/types.ts`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-cli/terminal-visualization-artifacts/packages/core/src/streamClient.ts`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-cli/terminal-visualization-artifacts/packages/core/src/reducer.ts`
- Modify tests beside each changed module.

- [ ] Define strict shared types for `PresentationCapabilities`, chart and Mermaid artifacts, table/edge-list fallbacks, and the `visualization` stream chunk.
- [ ] Implement a no-dependency runtime validator that returns a typed result or a bounded diagnostic; never pass arbitrary config into a renderer.
- [ ] Implement `extractVisualizationArtifactsFromMarkdown()` for complete fenced blocks. Normalize legacy `chart` and raw `mermaid` blocks to the v1 envelope.
- [ ] Add the shared test file to an explicit `tsx --test` package script, matching the repository's current explicit-test convention.
- [ ] Extend `ChatMessage` with `visualizations` and extend the reducer to attach and de-duplicate structured artifact events without adding terminal formatting to content.
- [ ] Make `StreamClient` send terminal capabilities by default:

```ts
presentation: {
  profile: "terminal",
  artifact_schema: "cloudeval.visualization/v1",
  accepts: ["flint-v1", "mermaid-v11"],
  fallbacks: ["unicode", "table", "edge-list", "source", "plain-markdown"],
}
```

- [ ] Normalize `visualization` SSE events and preserve all existing event handling.
- [ ] Read the CLI version at request time from one shared runtime helper populated by the executable; remove stale hard-coded client-version values from the affected chat path.
- [ ] Run focused tests until green:

```bash
pnpm --filter @cloudeval/shared test
pnpm --filter @cloudeval/core exec tsx --test src/streamClient.test.ts src/reducer.test.ts
```

- [ ] Commit the contract independently:

```bash
git add packages/shared packages/core
git commit -m "feat: negotiate terminal visualization artifacts"
```

## Task 3: Add CLI chart and Mermaid renderers test-first

**Files:**

- Create: `/Users/prateek/.config/superpowers/worktrees/cloudeval-cli/terminal-visualization-artifacts/packages/cli/src/ui/terminalVisualizations.ts`
- Create: `/Users/prateek/.config/superpowers/worktrees/cloudeval-cli/terminal-visualization-artifacts/packages/cli/src/ui/terminalVisualizations.test.ts`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-cli/terminal-visualization-artifacts/packages/cli/package.json`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-cli/terminal-visualization-artifacts/packages/cli/src/ui/components/Transcript.tsx`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-cli/terminal-visualization-artifacts/packages/cli/src/ui/components/Transcript.test.ts`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-cli/terminal-visualization-artifacts/packages/cli/src/ui/sessionThreads.ts`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-cli/terminal-visualization-artifacts/packages/cli/src/ui/sessionThreads.test.ts`

- [ ] Write renderer tests first for widths 32, 80, and 120 columns and for `NO_COLOR` behavior.
- [ ] Cover line/area/stepped charts, vertical or horizontal bars, proportional pie-like summaries, scatter grids, heatmap matrices, and unsupported-chart table fallback.
- [ ] Cover Mermaid `flowchart`/`graph` edges, labeled edges, aliases, subgraph-safe degradation, malformed source, and unsupported diagram source fallback.
- [ ] Assert every rendered line is width-bounded and free of `\u001b`, OSC, and other disallowed control sequences.
- [ ] Implement deterministic sampling and label truncation. Use `asciichart` for quantitative trends and Unicode block characters for other supported forms.
- [ ] Teach `Transcript` to recognize `flint`, `chart`, and `mermaid` blocks and render them through the visualization component instead of syntax highlighting.
- [ ] On restored sessions, derive artifacts from persisted Markdown so replay matches the live surface even when structured events were not saved.
- [ ] Add the renderer test file to the CLI package's explicit test list.
- [ ] Run focused tests until green:

```bash
pnpm --filter @cloudeval/cli exec tsx --test src/ui/terminalVisualizations.test.ts src/ui/components/Transcript.test.ts src/ui/sessionThreads.test.ts
```

- [ ] Commit the terminal renderer:

```bash
git add packages/cli
git commit -m "feat: render charts and diagrams in the terminal"
```

## Task 4: Add frontend compatibility before backend emission

**Files:**

- Create: `/Users/prateek/.config/superpowers/worktrees/cloudeval-frontend/terminal-visualization-artifacts/lib/chat/visualization-artifacts.ts`
- Create: `/Users/prateek/.config/superpowers/worktrees/cloudeval-frontend/terminal-visualization-artifacts/lib/chat/visualization-artifacts.test.ts`
- Create: `/Users/prateek/.config/superpowers/worktrees/cloudeval-frontend/terminal-visualization-artifacts/components/common/flint-chart-component.tsx`
- Create: `/Users/prateek/.config/superpowers/worktrees/cloudeval-frontend/terminal-visualization-artifacts/components/common/flint-chart-component.test.tsx`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-frontend/terminal-visualization-artifacts/components/common/markdown.tsx`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-frontend/terminal-visualization-artifacts/lib/langgraph/client.ts`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-frontend/terminal-visualization-artifacts/lib/langgraph/event-processor.ts`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-frontend/terminal-visualization-artifacts/components/chat/d.ts`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-frontend/terminal-visualization-artifacts/components/chat/chat-panel.tsx`
- Modify the associated Jest suites.

- [ ] Implement the same bounded v1 validator used by the CLI fixture and deterministic wrappers for legacy `chart` and Mermaid fences.
- [ ] Render validated `renderer: "chartjs"` configs through the existing `ChartComponent`; dynamically load ECharts only for `renderer: "echarts"`.
- [ ] Render table or plain-Markdown fallback when the artifact is invalid or the renderer fails. Do not execute callbacks or arbitrary JavaScript embedded in configuration.
- [ ] Add `flint` handling to the existing Markdown fence renderer while keeping `chart` and `mermaid` behavior unchanged.
- [ ] Add web capabilities to the request body and a real build/package version to `X-Client-Version`:

```ts
presentation: {
  profile: "web",
  artifact_schema: "cloudeval.visualization/v1",
  accepts: ["flint-v1", "mermaid-v11", "chartjs-v4", "echarts-v5"],
  fallbacks: ["table", "plain-markdown"],
}
```

- [ ] Process additive `visualization` events and de-duplicate them by `id`; continue rendering persisted Markdown as the replay source.
- [ ] Run focused tests and a production build:

```bash
npx jest lib/chat/visualization-artifacts.test.ts components/common/flint-chart-component.test.tsx lib/langgraph/client.test.ts lib/langgraph/event-processor.test.ts --runInBand
npm run build
```

- [ ] Commit frontend compatibility:

```bash
git add components lib
git commit -m "feat: render versioned chat visualization artifacts"
```

## Task 5: Implement backend capability resolution and Flint compilation

**Files:**

- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-backend/terminal-visualization-artifacts/models/visualization.py`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-backend/terminal-visualization-artifacts/models/chat.py`
- Create: `/Users/prateek/.config/superpowers/worktrees/cloudeval-backend/terminal-visualization-artifacts/agent/visualization_context.py`
- Create: `/Users/prateek/.config/superpowers/worktrees/cloudeval-backend/terminal-visualization-artifacts/agent/tests/test_visualization_context.py`
- Create: `/Users/prateek/.config/superpowers/worktrees/cloudeval-backend/terminal-visualization-artifacts/agent/tools/flint_chart.py`
- Create: `/Users/prateek/.config/superpowers/worktrees/cloudeval-backend/terminal-visualization-artifacts/agent/tests/test_flint_chart.py`
- Create: `/Users/prateek/.config/superpowers/worktrees/cloudeval-backend/terminal-visualization-artifacts/scripts/flint-compile.mjs`
- Create: `/Users/prateek/.config/superpowers/worktrees/cloudeval-backend/terminal-visualization-artifacts/scripts/flint-compile.test.mjs`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-backend/terminal-visualization-artifacts/package.json`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-backend/terminal-visualization-artifacts/package-lock.json`

- [ ] Add Pydantic capability models with strict enum values and bounded lists. Preserve requests that omit `presentation`.
- [ ] Resolve explicit capabilities first and use `X-Client-Type` only for compatible defaults. Unknown capabilities must not enable a renderer.
- [ ] Store the resolved presentation in a request-scoped `ContextVar`, reset it in `finally`, and test concurrent isolation.
- [ ] Write Node tests that fail before installing Flint, then add exactly `flint-chart@0.3.0`.
- [ ] Compile only a constrained semantic input. The Python model must validate referenced fields, at most 20 fields, at most 200 rows, supported aggregations, and supported chart families before calling Node.
- [ ] Run the Node compiler with JSON over stdin, no shell interpolation, a five-second timeout, bounded stdout/stderr, and a clean error type.
- [ ] Prefer Chart.js when the Flint template supports it; use ECharts for capabilities/templates that require it. Persist the semantic `spec`, data rows, output config, fallback table, and warnings in the envelope.
- [ ] Run focused tests:

```bash
node --test scripts/flint-compile.test.mjs
PYTHONPATH=. /Users/prateek/workspace/repo/cloudeval-backend/.venv/bin/python -m pytest tests/test_chat_request_validation.py agent/tests/test_visualization_context.py agent/tests/test_flint_chart.py -q
```

- [ ] Commit backend contract and compiler:

```bash
git add models agent/visualization_context.py agent/tools/flint_chart.py agent/tests scripts package.json package-lock.json
git commit -m "feat: compile semantic chart intents with Flint"
```

## Task 6: Emit canonical Markdown and additive visualization events

**Files:**

- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-backend/terminal-visualization-artifacts/agent/prompts/chart_generator.py`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-backend/terminal-visualization-artifacts/agent/tools/visualization_tool.py`
- Create: `/Users/prateek/.config/superpowers/worktrees/cloudeval-backend/terminal-visualization-artifacts/src/services/chat/visualization_artifacts.py`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-backend/terminal-visualization-artifacts/models/stream_events.py`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-backend/terminal-visualization-artifacts/src/services/chat/stream_serializer.py`
- Modify: `/Users/prateek/.config/superpowers/worktrees/cloudeval-backend/terminal-visualization-artifacts/src/services/chat/stream_runner.py`
- Modify related tests in `agent/tests/` and `tests/`.

- [ ] Change the chart prompt to request compact semantic intent, not renderer-specific code. Keep deterministic context rows as the only chart data input.
- [ ] Compile that intent through Flint. For `flint-v1` clients, return a complete `flint` fence. For legacy web clients, return the existing `chart` fence when Chart.js is available. Otherwise return the deterministic table fallback.
- [ ] On compiler errors, validation errors, timeout, or unsupported templates, keep the response useful with the fallback; do not fail the chat stream.
- [ ] Implement extraction after the final response is complete. Validate `flint` fences, wrap legacy `chart` fences, and wrap Mermaid source with an edge-list/source fallback.
- [ ] Add `VisualizationChunk` to the stream model and serializer. Emit at most one event per unique artifact only when the resolved client accepts `cloudeval.visualization/v1`.
- [ ] Include `flint` in visualization detection and fence handling without altering ordinary token ordering, final-response persistence, or finish events.
- [ ] Test a complete stream sequence: responding Markdown containing a closed `flint` fence, one additive visualization event, then finish. Also test legacy/no-capability, incomplete fence, duplicate ID, and compiler failure.
- [ ] Run targeted backend suites:

```bash
PYTHONPATH=. /Users/prateek/workspace/repo/cloudeval-backend/.venv/bin/python -m pytest \
  tests/test_chat_request_validation.py \
  tests/test_chat_stream_chunking.py \
  agent/tests/test_visualization_artifacts.py \
  agent/tests/test_visualization_arg_normalization.py \
  agent/tests/test_visualization_fencing.py \
  agent/tests/test_stream_event_models.py \
  agent/tests/test_stream_serializer.py \
  agent/tests/test_stream_sequence_contract.py \
  agent/tests/test_stream_runner_final_response_persistence.py -q
```

- [ ] Commit backend emission:

```bash
git add agent models src tests
git commit -m "feat: stream canonical visualization artifacts"
```

## Task 7: Synchronize public documentation and release smoke contracts

**Files:**

- Modify CLI: `README.md`, `packages/cli/README.md`, `docs/release-smoke-tests.md`
- Modify backend: `docs/guides/chat-streaming.md`, `docs/guides/visualization-generation.md`, `docs/guides/testing-and-release-quality.md`
- Modify frontend: `docs/guides/streaming-and-thinking-events.md`, `public/llms.txt`, `public/llms-full.txt`

- [ ] Document human terminal behavior and machine-readable SSE/artifact shapes separately.
- [ ] Document capability defaults, v1 schema stability, renderer/fallback matrix, limits, replay semantics, and the fact that native Warp SVG integration remains deferred.
- [ ] Add exact manual smoke cases: line, bar, pie-like summary, scatter, heatmap, Mermaid flowchart, unsupported diagram, narrow terminal, `NO_COLOR`, session replay, legacy web request, and compiler failure.
- [ ] Regenerate the frontend public search index if the repository script requires it:

```bash
npm run build:search-index
```

- [ ] Scan documentation for stale claims and placeholders:

```bash
rg -n "TODO|TBD|PLACEHOLDER|mermaid-to-svg|flint-chart|cloudeval\.visualization/v1" README.md packages/cli/README.md docs
```

- [ ] Commit docs in each repository with a non-release-triggering `docs:` commit.

## Task 8: Prove the contract across all three surfaces

- [ ] Create one bounded fixture response containing prose, a `flint` chart, a Mermaid flowchart, and an additive v1 SSE event. Feed the exact fixture through backend extraction, frontend event processing/Markdown rendering, CLI stream normalization, CLI transcript rendering, and restored-session parsing.
- [ ] Assert the frontend and CLI show each artifact once, even though both Markdown and structured events are present.
- [ ] Assert the backend persists only canonical Markdown and never terminal-formatted text.
- [ ] Run repository verification:

```bash
# Backend
node --test scripts/flint-compile.test.mjs
PYTHONPATH=. /Users/prateek/workspace/repo/cloudeval-backend/.venv/bin/python -m pytest tests/test_chat_request_validation.py tests/test_chat_stream_chunking.py agent/tests/test_flint_chart.py agent/tests/test_visualization_artifacts.py agent/tests/test_stream_serializer.py -q

# Frontend
npx jest lib/chat/visualization-artifacts.test.ts components/common/flint-chart-component.test.tsx lib/langgraph/client.test.ts lib/langgraph/event-processor.test.ts --runInBand
npm run lint
npm run build

# CLI
pnpm test
pnpm lint
pnpm build
node packages/cli/dist/cli.js --help
node packages/cli/dist/cli.js status --help
```

- [ ] Run an interactive terminal fixture at 32 and 120 columns and capture text output; verify no overflow and readable fallbacks.
- [ ] If an authenticated live environment is available without reading protected local data, run one real chat request from web and CLI. Otherwise record that fixture-backed transport/rendering is proven separately from authenticated deployed runtime behavior.
- [ ] Inspect `git diff --check` and `git status --short` in all three worktrees. No generated secrets, session data, downloads, `.env` files, or unrelated edits may be present.

## Task 9: Release in compatibility-safe order

- [ ] Use `superpowers:verification-before-completion` and `superpowers:finishing-a-development-branch` before publishing anything.
- [ ] Push and open the frontend PR first. Wait for required CI, merge, and verify the deployed web chat still renders legacy `chart`/Mermaid responses before enabling backend artifacts.
- [ ] Push and open the backend PR second. Wait for required CI, merge, verify its deployed revision, and smoke both a legacy request and a capability-aware fixture/request.
- [ ] Push and open the CLI PR last. Wait for required CI, merge to the semantic-release branch, and monitor the release workflow to completion.
- [ ] Verify the newly published CLI version from the registry and install it into a temporary prefix without changing the user’s global installation.
- [ ] Run installed-package `--version`, `--help`, `status --help`, and a fixture-backed visualization smoke.
- [ ] Report release proof by layer: commits/PRs, CI, deployed frontend revision, deployed backend revision, registry version/tarball, installed CLI smoke, and any live authenticated surface that remains unproved.

## Completion criteria

- [ ] Old frontend + new backend remains readable through legacy/fallback Markdown.
- [ ] New frontend + old backend still renders legacy `chart` and Mermaid fences.
- [ ] New CLI + old backend derives renderable artifacts from legacy Markdown when possible.
- [ ] New CLI + new backend renders versioned charts and supported Mermaid flowcharts as Unicode with safe fallbacks.
- [ ] No renderer error can fail the chat response.
- [ ] No terminal escape sequences or client-specific rendering are persisted by the backend.
- [ ] Tests, builds, docs, help/status smoke, CI, deployment, and package publication are each evidenced separately.

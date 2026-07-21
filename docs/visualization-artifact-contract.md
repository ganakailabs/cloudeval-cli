# Chat Visualization Artifact Contract

CloudEval chat uses one semantic visualization contract across the web app and
CLI. The backend chooses what to emit from explicit client capabilities; each
client chooses how to render it.

## Request negotiation

Every current CLI chat request includes:

```json
{
  "presentation": {
    "profile": "terminal",
    "artifact_schema": "cloudeval.visualization/v1",
    "accepts": ["flint-v1", "mermaid-v11"],
    "fallbacks": [
      "unicode",
      "table",
      "edge-list",
      "source",
      "plain-markdown"
    ]
  }
}
```

`X-Client-Type: cloudeval-cli` and `X-Client-Version` identify the caller and
build. They do not opt an older client into formats it did not advertise. The
explicit `presentation` object is authoritative.

## Response transport

The assistant answer remains canonical Markdown for persistence, replay, and
older clients. A streaming response may additionally include:

```json
{
  "type": "visualization",
  "artifact": {
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
    "spec": { "type": "bar", "x": "service", "y": "cost" },
    "config": {},
    "fallback": {
      "type": "table",
      "columns": ["service", "cost"],
      "rows": [["Compute", 120], ["Storage", 40]]
    }
  }
}
```

Chart artifacts use `kind: "chart"`, `format: "flint"` or legacy
`"chartjs"`, and a required table fallback. Diagram artifacts use
`kind: "diagram"`, `format: "mermaid"`, Mermaid source, and an edge-list
fallback. Optional `description`, `warnings`, and `evidence_refs` preserve
context without changing rendering semantics.

## Terminal rendering

The TUI selects a terminal renderer from the semantic chart type:

| Artifact family | Terminal output |
| --- | --- |
| line, area, stepped, spline | Unicode line plot |
| bar, column, histogram | Unicode bars |
| pie, doughnut, rose, radar, polar | proportional Unicode bars |
| scatter, bubble | compact point grid |
| heatmap | shaded cell grid |
| unsupported or insufficient data | bounded table |
| Mermaid with extracted edges | `from ──▶ to` edge list |
| Mermaid without extracted edges | bounded source |

Output is sized to the current terminal. Labels and values are stripped of ANSI
and unsafe control sequences before rendering.

The CLI does not embed Warp's `mermaid-to-svg` helper in this version. That
project is a useful pure-Rust reference, but SVG still needs a compatible
terminal graphics protocol or a browser/image fallback and its Mermaid coverage
is not yet a stable packaged dependency. Keeping Mermaid source plus semantic
edges gives every terminal a deterministic fallback without platform-specific
native binaries.

## Machine-readable output

- `ask` and `agent --format json` include `data.visualizations` when present.
- `ask` and `agent --format ndjson` emit each validated artifact as a
  `visualization` event and include the list again in the final `result` event.
- Agent Profile, recipe, and MCP chat results include a `visualizations` field
  when the backend emitted artifacts.
- Text and Markdown retain the canonical fenced response.

These additions are optional: consumers that do not understand visualizations
can ignore them without changing existing response handling.

## Validation and compatibility

The CLI accepts only `cloudeval.visualization/v1`, safe stable ids, finite
scalar data, at most 200 rows and 20 fields, and at most 100 KB of encoded JSON.
Mermaid source is capped at 50 KB. Incomplete Markdown fences are ignored until
their closing fence arrives. Live events and Markdown fences are deduplicated by
artifact id.

Legacy `chart` and `mermaid` fences remain supported. Unsupported, malformed,
or future-schema artifacts fall back to readable Markdown instead of being
executed.

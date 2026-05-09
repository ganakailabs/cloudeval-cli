import assert from "node:assert/strict";
import test from "node:test";
import { createAskProgressWriter } from "./askProgress.js";

class MemoryStream {
  isTTY = true;
  chunks: string[] = [];

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk));
    return true;
  }
}

test("live ask progress renders a loader and reasoning progress bar", () => {
  const stream = new MemoryStream();
  const writer = createAskProgressWriter({
    mode: "stderr",
    format: "text",
    stream: stream as any,
    live: true,
  });

  writer.write({ type: "thinking", message: "Prepare response" });
  writer.write({ type: "thinking", step: "prepare_response", status: "completed", message: "Prepare response" });
  writer.write({ type: "thinking", step: "plan", status: "streaming", message: "Plan the approach" });
  writer.clear();

  const output = stream.chunks.join("");
  assert.match(output, /\r\u001B\[2K[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Reasoning \[/);
  assert.match(output, /1\/2 \| Plan the approach/);
  assert.equal(output.endsWith("\r\u001B[2K"), true);
  assert.doesNotMatch(output, /Prepare response\n\[thinking\] Plan the approach/);
});

test("live ask progress shows request loader before thinking steps arrive", () => {
  const stream = new MemoryStream();
  const writer = createAskProgressWriter({
    mode: "stderr",
    format: "text",
    stream: stream as any,
    live: true,
  });

  writer.write({ type: "request", message: "Sending chat request" });

  assert.match(stream.chunks.join(""), /\r\u001B\[2K[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Sending chat request/);
});

test("ask progress falls back to append-only lines when live output is unavailable", () => {
  const stream = new MemoryStream();
  stream.isTTY = false;
  const writer = createAskProgressWriter({
    mode: "stderr",
    format: "text",
    stream: stream as any,
    live: true,
  });

  writer.write({ type: "thinking", message: "Prepare response" });
  writer.write({ type: "thinking", message: "Plan the approach" });

  assert.equal(
    stream.chunks.join(""),
    "[thinking] Prepare response\n[thinking] Plan the approach\n"
  );
});

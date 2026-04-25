import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeTerminalInput } from "./inputSanitizer";

test("sanitizeTerminalInput removes SGR mouse escape sequences", () => {
  const raw =
    "hello\x1b[<64;46;39M\x1b[<64;46;39m\x1b[<0;12;3M world";

  assert.equal(sanitizeTerminalInput(raw), "hello world");
});

test("sanitizeTerminalInput removes bare SGR mouse sequences pasted into input", () => {
  const raw = "before[<65;32;79M[<64;32;79Mafter";

  assert.equal(sanitizeTerminalInput(raw), "beforeafter");
});

test("sanitizeTerminalInput keeps regular prompt text", () => {
  assert.equal(sanitizeTerminalInput("explain main resources"), "explain main resources");
});

test("sanitizeTerminalInput removes control characters from pasted input", () => {
  assert.equal(sanitizeTerminalInput("explain\r\nresources\u0007"), "explainresources");
});

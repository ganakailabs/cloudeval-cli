import assert from "node:assert/strict";
import test from "node:test";
import { streamChat } from "./streamClient";

const responseFromText = (body: string) =>
  new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
    },
  });

test("streamChat normalizes the API base URL", async () => {
  const originalFetch = global.fetch;
  let requestedUrl = "";
  let requestBody = "";

  global.fetch = async (input, init) => {
    requestedUrl = typeof input === "string" ? input : input.toString();
    requestBody = typeof init?.body === "string" ? init.body : "";
    return responseFromText(
      '{"type":"metadata","thread_id":"thread-1"}\n' +
        '{"type":"responding","node":"generate_response","content":"hi","status":"completed"}\n'
    );
  };

  try {
    const chunks = [];
    for await (const chunk of streamChat({
      baseUrl: "http://127.0.0.1:8787",
      authToken: "token",
      message: "hello",
      threadId: "thread-1",
      user: { id: "user-1", name: "User" },
    })) {
      chunks.push(chunk);
    }

    assert.equal(requestedUrl, "http://127.0.0.1:8787/api/v1/chat/stream");
    assert.match(requestBody, /"input":\{/);
    assert.match(requestBody, /"messages":\[\{"role":"user","content":"hello"\}\]/);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]?.type, "metadata");
    assert.equal(chunks[1]?.type, "responding");
  } finally {
    global.fetch = originalFetch;
  }
});

test("streamChat parses SSE data events", async () => {
  const originalFetch = global.fetch;

  global.fetch = async () =>
    responseFromText(
      'data: {"type":"metadata","thread_id":"thread-2"}\n\n' +
        'data: {"type":"responding","node":"generate_response","content":"hello","status":"streaming"}\n\n' +
        'data: {"type":"responding","node":"generate_response","content":" world","status":"completed"}\n\n' +
        "data: [DONE]\n\n"
    );

  try {
    const chunks = [];
    for await (const chunk of streamChat({
      baseUrl: "http://127.0.0.1:8787/api/v1",
      authToken: "token",
      message: "hello",
      threadId: "thread-2",
      user: { id: "user-1", name: "User" },
    })) {
      chunks.push(chunk);
    }

    assert.equal(chunks.length, 3);
    assert.equal(chunks[0]?.type, "metadata");
    assert.equal(chunks[1]?.type, "responding");
    assert.equal(chunks[2]?.type, "responding");
    assert.equal(chunks[1]?.content, "hello");
    assert.equal(chunks[2]?.content, " world");
  } finally {
    global.fetch = originalFetch;
  }
});

test("streamChat stops at SSE DONE even when the socket stays open", async () => {
  const originalFetch = global.fetch;

  global.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"metadata","thread_id":"thread-open"}\n\n' +
                "data: [DONE]\n\n"
            )
          );
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
        },
      }
    );

  try {
    const chunks: unknown[] = [];
    await Promise.race([
      (async () => {
        for await (const chunk of streamChat({
          baseUrl: "http://127.0.0.1:8787/api/v1",
          authToken: "token",
          message: "hello",
          threadId: "thread-open",
          user: { id: "user-1", name: "User" },
        })) {
          chunks.push(chunk);
        }
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("stream did not stop at DONE")), 500)
      ),
    ]);

    assert.equal(chunks.length, 1);
    assert.equal((chunks[0] as any)?.type, "metadata");
  } finally {
    global.fetch = originalFetch;
  }
});

test("streamChat can finish shortly after the final response chunk", async () => {
  const originalFetch = global.fetch;

  global.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"responding","node":"generate_response","content":"done","status":"completed"}\n\n'
            )
          );
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
        },
      }
    );

  try {
    const chunks: unknown[] = [];
    await Promise.race([
      (async () => {
        for await (const chunk of streamChat({
          baseUrl: "http://127.0.0.1:8787/api/v1",
          authToken: "token",
          message: "hello",
          threadId: "thread-response-complete",
          user: { id: "user-1", name: "User" },
          completeAfterResponse: true,
          responseCompletionGraceMs: 25,
        })) {
          chunks.push(chunk);
        }
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("stream did not stop after response")), 500)
      ),
    ]);

    assert.equal(chunks.length, 1);
    assert.equal((chunks[0] as any)?.type, "responding");
    assert.equal((chunks[0] as any)?.content, "done");
  } finally {
    global.fetch = originalFetch;
  }
});

test("streamChat treats response content idleness as completion", async () => {
  const originalFetch = global.fetch;

  global.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"responding","node":"generate_response","content":"partial response","status":"streaming"}\n\n'
            )
          );
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
        },
      }
    );

  try {
    const chunks: unknown[] = [];
    await Promise.race([
      (async () => {
        for await (const chunk of streamChat({
          baseUrl: "http://127.0.0.1:8787/api/v1",
          authToken: "token",
          message: "hello",
          threadId: "thread-response-idle",
          user: { id: "user-1", name: "User" },
          completeAfterResponse: true,
          responseCompletionGraceMs: 25,
        })) {
          chunks.push(chunk);
        }
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("stream did not stop after response idle")), 500)
      ),
    ]);

    assert.equal(chunks.length, 1);
    assert.equal((chunks[0] as any)?.content, "partial response");
  } finally {
    global.fetch = originalFetch;
  }
});

test("streamChat parses HITL request events", async () => {
  const originalFetch = global.fetch;

  global.fetch = async () =>
    responseFromText(
      'data: {"type":"hitl_request","questions":[{"id":"ask_mode_switch","kind":"mode_switch","text":"Switch to planner mode?","recommended_option_id":"switch_to_planner","options":[{"id":"switch_to_planner","label":"Switch to planner mode","recommended":true},{"id":"stay_in_ask","label":"Stay in Ask mode"}]}],"checkpoint_id":"ckpt-123","pending_intent_id":"ask_mode_switch"}\n\n'
    );

  try {
    const chunks = [];
    for await (const chunk of streamChat({
      baseUrl: "http://127.0.0.1:8787/api/v1",
      authToken: "token",
      message: "hello",
      threadId: "thread-hitl",
      user: { id: "user-1", name: "User" },
    })) {
      chunks.push(chunk);
    }

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.type, "hitl_request");
    assert.equal((chunks[0] as any)?.checkpoint_id, "ckpt-123");
    assert.equal((chunks[0] as any)?.questions?.[0]?.id, "ask_mode_switch");
    assert.equal((chunks[0] as any)?.questions?.[0]?.options?.[0]?.recommended, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("streamChat sends HITL resume payloads like the web client", async () => {
  const originalFetch = global.fetch;
  let requestBody = "";

  global.fetch = async (_input, init) => {
    requestBody = typeof init?.body === "string" ? init.body : "";
    return responseFromText('data: {"type":"metadata","thread_id":"thread-hitl"}\n\n');
  };

  try {
    for await (const _chunk of streamChat({
      baseUrl: "http://127.0.0.1:8787/api/v1",
      authToken: "token",
      message: "",
      threadId: "thread-hitl",
      user: { id: "user-1", name: "User" },
      hitlResume: {
        checkpointId: "ckpt-123",
        responses: [{ question_id: "ask_mode_switch", answer: "switch_to_planner" }],
      },
    } as any)) {
      // drain stream
    }

    const payload = JSON.parse(requestBody);
    assert.equal(payload.hitl_resume, true);
    assert.equal(payload.hitl_checkpoint_id, "ckpt-123");
    assert.deepEqual(payload.hitl_responses, [
      { question_id: "ask_mode_switch", answer: "switch_to_planner" },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("streamChat uses project user_id for backend payloads when caller keeps cli-user", async () => {
  const originalFetch = global.fetch;
  let requestBody = "";

  global.fetch = async (_input, init) => {
    requestBody = typeof init?.body === "string" ? init.body : "";
    return responseFromText('data: {"type":"metadata","thread_id":"thread-4"}\n\n');
  };

  try {
    for await (const _chunk of streamChat({
      baseUrl: "http://127.0.0.1:8787",
      authToken: "token",
      message: "hello",
      threadId: "thread-4",
      user: { id: "cli-user", name: "User" },
      project: {
        id: "project-1",
        name: "Project 1",
        user_id: "user-actual",
      },
    })) {
      // drain stream
    }

    assert.match(requestBody, /"user":\{"id":"user-actual","name":"User"\}/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("streamChat includes backend error details on HTTP failures", async () => {
  const originalFetch = global.fetch;

  global.fetch = async () =>
    new Response(
      JSON.stringify({
        detail: {
          code: "model_not_available",
          message: "Model gpt-5-mini is not enabled for this project",
        },
      }),
      {
        status: 403,
        statusText: "Forbidden",
        headers: { "Content-Type": "application/json" },
      }
    );

  try {
    await assert.rejects(
      async () => {
        for await (const _chunk of streamChat({
          baseUrl: "http://127.0.0.1:8787/api/v1",
          authToken: "token",
          message: "hello",
          threadId: "thread-error",
          user: { id: "user-1", name: "User" },
        })) {
          // drain stream
        }
      },
      /403 Forbidden.*model_not_available.*gpt-5-mini/s
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("reduceChunk keeps follow-up questions on the same assistant message", async () => {
  const { reduceChunk, initialChatState } = await import("./index");

  const metadataChunk = {
    type: "metadata" as const,
    thread_id: "thread-3",
    receivedAt: Date.now(),
  };
  const answerChunk = {
    type: "responding" as const,
    node: "generate_response",
    content: "Primary answer",
    status: "completed" as const,
    receivedAt: Date.now() + 1,
  };
  const followUpChunk = {
    type: "responding" as const,
    node: "generate_follow_up",
    content: "Question one?;Question two?",
    status: "completed" as const,
    receivedAt: Date.now() + 2,
  };

  const stateAfterMetadata = reduceChunk(initialChatState, metadataChunk);
  const stateAfterAnswer = reduceChunk(stateAfterMetadata, answerChunk);
  const finalState = reduceChunk(stateAfterAnswer, followUpChunk);

  assert.equal(finalState.messages.length, 1);
  assert.equal(finalState.messages[0]?.content, "Primary answer");
  assert.deepEqual(finalState.messages[0]?.followUpQuestions, [
    "Question one?",
    "Question two?",
  ]);
});

test("reduceChunk persists HITL questions and waits for user input", async () => {
  const { reduceChunk, initialChatState } = await import("./index");

  const hitlChunk = {
    type: "hitl_request" as const,
    questions: [
      {
        id: "write_confirm_0",
        text: "Should I proceed?",
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
      },
    ],
    checkpoint_id: "ckpt-123",
    pending_intent_id: "write_confirm_0",
    receivedAt: Date.now(),
  };

  const finalState = reduceChunk(initialChatState, hitlChunk as any);

  assert.equal(finalState.status, "hitl_waiting");
  assert.equal(finalState.hitl?.waiting, true);
  assert.equal(finalState.hitl?.checkpointId, "ckpt-123");
  assert.equal(finalState.hitl?.questions[0]?.id, "write_confirm_0");
  assert.equal(finalState.messages.length, 1);
  assert.equal(finalState.messages[0]?.pending, true);
  assert.equal(finalState.messages[0]?.thinkingSteps?.[0]?.node, "hitl_middleware");
  assert.equal(
    finalState.messages[0]?.thinkingSteps?.[0]?.hitlQuestions?.[0]?.text,
    "Should I proceed?"
  );
});

test("reduceChunk keeps HITL waiting when ordinary chunks arrive after approval request", async () => {
  const { reduceChunk, initialChatState } = await import("./index");

  const hitlChunk = {
    type: "hitl_request" as const,
    questions: [
      {
        id: "approval_0",
        text: "Run the report?",
        options: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ],
      },
    ],
    checkpoint_id: "ckpt-report",
    pending_intent_id: "approval_0",
    receivedAt: 1_000,
  };
  const afterHitl = reduceChunk(initialChatState, hitlChunk as any);

  const afterThinking = reduceChunk(afterHitl, {
    type: "thinking",
    node: "late_plan",
    description: "Late plan",
    status: "completed",
    receivedAt: 1_500,
  } as any);
  const afterResponse = reduceChunk(afterThinking, {
    type: "responding",
    node: "response_compose",
    content: "Waiting for approval.",
    status: "streaming",
    receivedAt: 2_000,
  } as any);

  assert.equal(afterThinking.status, "hitl_waiting");
  assert.equal(afterThinking.hitl?.waiting, true);
  assert.equal(afterThinking.hitl?.checkpointId, "ckpt-report");
  assert.equal(afterResponse.status, "hitl_waiting");
  assert.equal(afterResponse.hitl?.waiting, true);
  assert.equal(afterResponse.hitl?.questions[0]?.id, "approval_0");
});

test("reduceChunk keeps every thinking step status and duration", async () => {
  const { reduceChunk, initialChatState } = await import("./index");

  const chunks = [
    {
      type: "thinking" as const,
      node: "prepare",
      description: "Prepare response",
      status: "streaming" as const,
      receivedAt: 1_000,
    },
    {
      type: "thinking" as const,
      node: "inspect_context",
      description: "Inspect context",
      status: "streaming" as const,
      receivedAt: 1_500,
    },
    {
      type: "thinking" as const,
      node: "prepare",
      description: "Prepare response",
      status: "completed" as const,
      receivedAt: 2_250,
    },
    {
      type: "thinking" as const,
      node: "inspect_context",
      description: "Inspect context",
      status: "error" as const,
      receivedAt: 3_000,
    },
  ];

  const finalState = chunks.reduce(reduceChunk, initialChatState);
  const steps = finalState.messages[0]?.thinkingSteps ?? [];

  assert.equal(steps.length, 2);
  assert.deepEqual(
    steps.map((step) => step.node),
    ["prepare", "inspect_context"]
  );
  assert.equal(steps[0]?.status, "completed");
  assert.equal(steps[0]?.startedAt, 1_000);
  assert.equal(steps[0]?.updatedAt, 2_250);
  assert.equal(steps[0]?.durationMs, 1_250);
  assert.equal(steps[1]?.status, "error");
  assert.equal(steps[1]?.startedAt, 1_500);
  assert.equal(steps[1]?.updatedAt, 3_000);
  assert.equal(steps[1]?.durationMs, 1_500);
});

test("reduceChunk moves from connecting to thinking when thinking chunks arrive", async () => {
  const { reduceChunk, initialChatState } = await import("./index");

  const finalState = reduceChunk(
    {
      ...initialChatState,
      status: "connecting",
    },
    {
      type: "thinking",
      node: "prepare",
      description: "Prepare response",
      status: "streaming",
      receivedAt: 1_000,
    } as any
  );

  assert.equal(finalState.status, "thinking");
});

test("completeActiveAssistantMessage closes open reasoning steps after stream completion", async () => {
  const {
    reduceChunk,
    completeActiveAssistantMessage,
    initialChatState,
  } = await import("./index");

  const activeState = [
    {
      type: "thinking" as const,
      node: "response_preamble",
      description: "Prepare response",
      status: "streaming" as const,
      receivedAt: 1_000,
    },
    {
      type: "thinking" as const,
      node: "start",
      description: "Understand the goal",
      status: "streaming" as const,
      receivedAt: 2_000,
    },
    {
      type: "responding" as const,
      node: "response_compose",
      description: "Respond conversationally",
      content: "Hi there.",
      status: "streaming" as const,
      receivedAt: 5_000,
    },
    {
      type: "thinking" as const,
      node: "background_summarize_and_save",
      description: "Update memory",
      status: "completed" as const,
      receivedAt: 7_000,
    },
  ].reduce(reduceChunk, initialChatState);

  const finalState = completeActiveAssistantMessage(activeState, 8_000);
  const steps = finalState.messages[0]?.thinkingSteps ?? [];

  assert.equal(finalState.status, "complete");
  assert.equal(finalState.messages[0]?.pending, false);
  assert.deepEqual(steps.map((step) => step.status), [
    "completed",
    "completed",
    "completed",
    "completed",
  ]);
  assert.equal(steps[0]?.completedAt, 8_000);
  assert.equal(steps[1]?.completedAt, 8_000);
  assert.equal(steps[2]?.completedAt, 8_000);
});

test("reduceChunk closes open thinking steps when the response completes", async () => {
  const { reduceChunk, initialChatState } = await import("./index");

  const finalState = [
    {
      type: "thinking" as const,
      node: "plan",
      description: "Plan the response",
      status: "streaming" as const,
      receivedAt: 1_000,
    },
    {
      type: "responding" as const,
      node: "generate_response",
      content: "Answer",
      status: "streaming" as const,
      receivedAt: 1_500,
    },
    {
      type: "responding" as const,
      node: "generate_response",
      content: " complete",
      status: "completed" as const,
      receivedAt: 3_000,
    },
  ].reduce(reduceChunk, initialChatState);

  const steps = finalState.messages[0]?.thinkingSteps ?? [];

  assert.equal(finalState.status, "complete");
  assert.equal(finalState.messages[0]?.pending, false);
  assert.deepEqual(
    steps.map((step) => step.status),
    ["completed", "completed"]
  );
  assert.equal(steps[0]?.completedAt, 3_000);
  assert.equal(steps[0]?.durationMs, 2_000);
});

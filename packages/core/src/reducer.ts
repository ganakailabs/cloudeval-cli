import { randomUUID } from "node:crypto";
import {
  ChatMessage,
  ChatState,
  Chunk,
  HitlRequestChunk,
  RespondingChunk,
  ThinkingChunk,
} from "@cloudeval/shared";

const STREAMING_NODES = new Set([
  "generate_response",
  "handle_social_interaction",
  "response_compose",
]);
const FOLLOW_UP_NODE = "generate_follow_up";
const ERROR_FALLBACK_SOURCE_PREFIX = "error_fallback:";

const TERMINAL_STEP_STATUSES = new Set([
  "completed",
  "error",
  "aborted",
  "cancelled",
]);

const cloneMessage = (message: ChatMessage): ChatMessage => ({
  ...message,
  thinkingSteps: message.thinkingSteps
    ? [...message.thinkingSteps.map((s) => ({ ...s }))]
    : [],
  followUpQuestions: message.followUpQuestions
    ? [...message.followUpQuestions]
    : undefined,
});

const finalizeOpenSteps = (
  steps: ChatMessage["thinkingSteps"],
  status: "completed" | "error" | "aborted" | "cancelled",
  timestamp: number
): ChatMessage["thinkingSteps"] => {
  if (!steps) {
    return steps;
  }

  return steps.map((step) => {
    if (TERMINAL_STEP_STATUSES.has(step.status ?? "pending")) {
      return step;
    }

    const startedAt = step.startedAt ?? step.timestamp;
    return {
      ...step,
      status,
      timestamp,
      updatedAt: timestamp,
      completedAt: timestamp,
      durationMs: Math.max(0, timestamp - startedAt),
    };
  });
};

const ensureAssistantMessage = (
  state: ChatState,
  timestamp: number
): [ChatState, ChatMessage] => {
  const existing =
    (state.activeMessageId &&
      state.messages.find(
        (m) => m.id === state.activeMessageId && m.role === "assistant"
      )) ||
    state.messages.find((m) => m.pending && m.role === "assistant");

  if (existing) {
    return [{ ...state, activeMessageId: existing.id }, cloneMessage(existing)];
  }

  // close any existing pending assistant messages to avoid interleaving
  const closedMessages = state.messages.map((m) =>
    m.role === "assistant" && m.pending
      ? { ...m, pending: false, updatedAt: timestamp }
      : m
  );

  const message: ChatMessage = {
    id: randomUUID(),
    role: "assistant",
    content: "",
    pending: true,
    thinkingSteps: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  return [
    {
      ...state,
      activeMessageId: message.id,
      messages: [...closedMessages, message],
    },
    message,
  ];
};

const mergeThinkingStep = (
  steps: ChatMessage["thinkingSteps"],
  chunk: ThinkingChunk | RespondingChunk
) => {
  const node = chunk.node ?? "unknown";
  const mergedSteps = steps ? [...steps] : [];
  const chunkStatus = chunk.status ?? "streaming";
  const existingIdx = [...mergedSteps]
    .reverse()
    .findIndex(
      (s) =>
        s.node === node &&
        !TERMINAL_STEP_STATUSES.has(s.status ?? "pending")
    );
  const existingStepIdx =
    existingIdx >= 0 ? mergedSteps.length - 1 - existingIdx : -1;

  if (existingStepIdx >= 0) {
    const existing = mergedSteps[existingStepIdx];
    const startedAt = existing.startedAt ?? existing.timestamp ?? chunk.receivedAt;
    const isTerminal = TERMINAL_STEP_STATUSES.has(chunkStatus);
    mergedSteps[existingStepIdx] = {
      ...existing,
      content: (existing.content ?? "") + (chunk.content ?? ""),
      description: chunk.description ?? existing.description,
      message: chunk.message ?? existing.message,
      status: chunkStatus,
      timestamp: chunk.receivedAt,
      startedAt,
      updatedAt: chunk.receivedAt,
      completedAt: isTerminal ? chunk.receivedAt : existing.completedAt,
      durationMs: Math.max(0, chunk.receivedAt - startedAt),
    };
  } else {
    const isTerminal = TERMINAL_STEP_STATUSES.has(chunkStatus);
    mergedSteps.push({
      node,
      type: chunk.type === "responding" ? "responding" : "thinking",
      content: chunk.content,
      description: chunk.description,
      message: chunk.message,
      status: chunkStatus,
      timestamp: chunk.receivedAt,
      startedAt: chunk.receivedAt,
      updatedAt: chunk.receivedAt,
      completedAt: isTerminal ? chunk.receivedAt : undefined,
      durationMs: 0,
    });
  }

  return mergedSteps;
};

const mergeHitlStep = (
  steps: ChatMessage["thinkingSteps"],
  chunk: HitlRequestChunk
) => {
  const node = "hitl_middleware";
  const existingIdx = steps?.findIndex((s) => s.node === node) ?? -1;
  const mergedSteps = steps ? [...steps] : [];
  const firstQuestion = chunk.questions[0];

  const step = {
    node,
    type: "hitl" as const,
    description: "Waiting for your input",
    message: firstQuestion?.text,
    content: firstQuestion?.text,
    status: "pending" as const,
    timestamp: chunk.receivedAt,
    startedAt: chunk.receivedAt,
    updatedAt: chunk.receivedAt,
    durationMs: 0,
    hitlQuestions: chunk.questions,
  };

  if (existingIdx >= 0) {
    mergedSteps[existingIdx] = {
      ...mergedSteps[existingIdx],
      ...step,
    };
  } else {
    mergedSteps.push(step);
  }

  return mergedSteps;
};

const parseFollowUps = (scratch: string | undefined) =>
  (scratch ?? "")
    .split(";")
    .map((q) => q.trim())
    .filter(Boolean);

const isErrorFallbackRespondingChunk = (chunk: RespondingChunk) =>
  typeof chunk.source === "string" &&
  chunk.source.startsWith(ERROR_FALLBACK_SOURCE_PREFIX);

const getFallbackErrorMessage = (chunk: RespondingChunk) =>
  chunk.content || chunk.description || chunk.message || "Unknown error";

export const initialChatState: ChatState = {
  status: "idle",
  messages: [],
};

export const completeActiveAssistantMessage = (
  state: ChatState,
  timestamp = Date.now()
): ChatState => {
  const activeMessage =
    (state.activeMessageId &&
      state.messages.find(
        (message) =>
          message.id === state.activeMessageId && message.role === "assistant"
      )) ||
    [...state.messages].reverse().find(
      (message) => message.role === "assistant" && message.pending
    ) ||
    [...state.messages].reverse().find(
      (message) => message.role === "assistant"
    );

  if (!activeMessage) {
    return {
      ...state,
      status: state.status === "error" || state.status === "hitl_waiting"
        ? state.status
        : "complete",
    };
  }

  return {
    ...state,
    status:
      state.status === "error" || state.status === "hitl_waiting"
        ? state.status
        : "complete",
    messages: state.messages.map((message) =>
      message.id === activeMessage.id
        ? {
            ...message,
            pending: false,
            updatedAt: timestamp,
            thinkingSteps: finalizeOpenSteps(
              message.thinkingSteps,
              "completed",
              timestamp
            ),
          }
        : message
    ),
  };
};

export const reduceChunk = (state: ChatState, chunk: Chunk): ChatState => {
  const next: ChatState = {
    ...state,
    lastChunk: chunk,
  };

  if (chunk.type === "metadata") {
    return {
      ...next,
      threadId: chunk.thread_id ?? next.threadId,
      traceId: chunk.trace_id ?? next.traceId,
    };
  }

  if (chunk.type === "hitl_request") {
    const [stateWithMessage, streamingMessage] = ensureAssistantMessage(
      next,
      chunk.receivedAt
    );
    const updatedMessage = cloneMessage(streamingMessage);
    updatedMessage.pending = true;
    updatedMessage.thinkingSteps = mergeHitlStep(
      updatedMessage.thinkingSteps,
      chunk
    );
    updatedMessage.updatedAt = chunk.receivedAt;

    const messages = stateWithMessage.messages.map((m) =>
      m.id === updatedMessage.id ? updatedMessage : m
    );

    return {
      ...stateWithMessage,
      status: "hitl_waiting",
      messages,
      activeMessageId: updatedMessage.id,
      followUpScratch: undefined,
      hitl: {
        waiting: true,
        questions: chunk.questions,
        checkpointId: chunk.checkpoint_id,
        pendingIntentId: chunk.pending_intent_id,
        runId: chunk.run_id,
        langsmithTraceId: chunk.langsmith_trace_id,
        messageId: updatedMessage.id,
      },
    };
  }

  if (chunk.type === "hitl_resume") {
    return {
      ...next,
      status: "thinking",
      hitl: undefined,
      error: undefined,
    };
  }

  if (chunk.type === "error") {
    const status =
      chunk.status === "aborted" ? ("canceled" as const) : ("error" as const);
    const error =
      chunk.description || chunk.content || chunk.message || "Unknown error";
    const messages = state.messages.map((m) =>
      m.id === state.activeMessageId
        ? {
            ...m,
            pending: false,
            error,
            updatedAt: chunk.receivedAt,
            thinkingSteps: finalizeOpenSteps(
              m.thinkingSteps,
              status === "canceled" ? "aborted" : "error",
              chunk.receivedAt
            ),
          }
        : m
    );

    return {
      ...next,
      status,
      error,
      messages,
      hitl: undefined,
    };
  }

  if (chunk.type === "thinking" || chunk.type === "responding") {
    const [stateWithMessage, streamingMessage] = ensureAssistantMessage(
      next,
      chunk.receivedAt
    );

    const updatedMessage = cloneMessage(streamingMessage);
    updatedMessage.thinkingSteps = mergeThinkingStep(
      updatedMessage.thinkingSteps,
      chunk
    );
    updatedMessage.updatedAt = chunk.receivedAt;

    if (chunk.type === "responding" && isErrorFallbackRespondingChunk(chunk)) {
      const error = getFallbackErrorMessage(chunk);
      updatedMessage.content = `${updatedMessage.content ?? ""}${
        chunk.content ?? ""
      }`;
      updatedMessage.pending = false;
      updatedMessage.updatedAt = chunk.receivedAt;
      updatedMessage.thinkingSteps = finalizeOpenSteps(
        updatedMessage.thinkingSteps,
        "error",
        chunk.receivedAt
      );

      const messages = stateWithMessage.messages.map((m) =>
        m.id === updatedMessage.id ? updatedMessage : m
      );

      return {
        ...stateWithMessage,
        status: "error",
        error,
        followUpScratch: undefined,
        messages,
        activeMessageId: updatedMessage.id,
        hitl: undefined,
      };
    }

    let followUpScratch = stateWithMessage.followUpScratch;
    let status: ChatState["status"] = stateWithMessage.status;
    const keepHitlWaiting = Boolean(stateWithMessage.hitl?.waiting);

    if (
      chunk.type === "responding" &&
      STREAMING_NODES.has(chunk.node ?? "")
    ) {
      updatedMessage.content = `${updatedMessage.content ?? ""}${
        chunk.content ?? ""
      }`;
      updatedMessage.pending = chunk.status !== "completed";
      if (chunk.status === "completed") {
        updatedMessage.thinkingSteps = finalizeOpenSteps(
          updatedMessage.thinkingSteps,
          "completed",
          chunk.receivedAt
        );
      }
      status = chunk.status === "completed" ? "complete" : "streaming";
    } else if (
      chunk.type === "responding" &&
      (chunk.node ?? "") === FOLLOW_UP_NODE
    ) {
      followUpScratch = `${followUpScratch ?? ""}${chunk.content ?? ""}`;
      if (chunk.status === "completed") {
        updatedMessage.followUpQuestions = parseFollowUps(followUpScratch);
        followUpScratch = undefined;
      }
      status = "tool_running";
    } else {
      status =
        chunk.status === "completed" && chunk.node === "end"
          ? "complete"
          : stateWithMessage.status === "idle" || stateWithMessage.status === "connecting"
            ? "thinking"
            : stateWithMessage.status;
      updatedMessage.pending =
        chunk.status !== "completed" || updatedMessage.pending;
      if (chunk.status === "completed" && chunk.node === "end") {
        updatedMessage.thinkingSteps = finalizeOpenSteps(
          updatedMessage.thinkingSteps,
          "completed",
          chunk.receivedAt
        );
      }
    }

    if (keepHitlWaiting) {
      status = "hitl_waiting";
      updatedMessage.pending = true;
    }

    const messages = stateWithMessage.messages.map((m) =>
      m.id === updatedMessage.id ? updatedMessage : m
    );

    return {
      ...stateWithMessage,
      status,
      followUpScratch,
      messages,
      activeMessageId: updatedMessage.id,
      hitl: keepHitlWaiting ? stateWithMessage.hitl : undefined,
    };
  }

  return next;
};

import { randomUUID } from "node:crypto";
import {
  ChatMessage,
  ChatState,
  Chunk,
  RespondingChunk,
  ThinkingChunk,
} from "@cloudeval/shared";

const STREAMING_NODES = new Set(["generate_response", "handle_social_interaction"]);
const FOLLOW_UP_NODE = "generate_follow_up";

const cloneMessage = (message: ChatMessage): ChatMessage => ({
  ...message,
  thinkingSteps: message.thinkingSteps
    ? [...message.thinkingSteps.map((s) => ({ ...s }))]
    : [],
  followUpQuestions: message.followUpQuestions
    ? [...message.followUpQuestions]
    : undefined,
});

const ensureAssistantMessage = (
  state: ChatState,
  timestamp: number
): [ChatState, ChatMessage] => {
  const existing =
    (state.activeMessageId &&
      state.messages.find(
        (m) => m.id === state.activeMessageId && m.pending === true
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
  const existingIdx = steps?.findIndex((s) => s.node === node) ?? -1;
  const mergedSteps = steps ? [...steps] : [];

  if (existingIdx >= 0) {
    const existing = mergedSteps[existingIdx];
    mergedSteps[existingIdx] = {
      ...existing,
      content: (existing.content ?? "") + (chunk.content ?? ""),
      description: chunk.description ?? existing.description,
      message: chunk.message ?? existing.message,
      status: chunk.status ?? existing.status,
      timestamp: chunk.receivedAt,
    };
  } else {
    mergedSteps.push({
      node,
      type: chunk.type === "responding" ? "responding" : "thinking",
      content: chunk.content,
      description: chunk.description,
      message: chunk.message,
      status: chunk.status ?? "streaming",
      timestamp: chunk.receivedAt,
    });
  }

  return mergedSteps;
};

const parseFollowUps = (scratch: string | undefined) =>
  (scratch ?? "")
    .split(";")
    .map((q) => q.trim())
    .filter(Boolean);

export const initialChatState: ChatState = {
  status: "idle",
  messages: [],
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

  if (chunk.type === "error") {
    const status =
      chunk.status === "aborted" ? ("canceled" as const) : ("error" as const);
    const error =
      chunk.description || chunk.content || chunk.message || "Unknown error";
    const messages = state.messages.map((m) =>
      m.id === state.activeMessageId
        ? { ...m, pending: false, error, updatedAt: chunk.receivedAt }
        : m
    );

    return {
      ...next,
      status,
      error,
      messages,
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

    let followUpScratch = stateWithMessage.followUpScratch;
    let status: ChatState["status"] = stateWithMessage.status;

    if (
      chunk.type === "responding" &&
      STREAMING_NODES.has(chunk.node ?? "")
    ) {
      updatedMessage.content = `${updatedMessage.content ?? ""}${
        chunk.content ?? ""
      }`;
      updatedMessage.pending = chunk.status !== "completed";
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
          : stateWithMessage.status === "idle"
            ? "thinking"
            : stateWithMessage.status;
      updatedMessage.pending =
        chunk.status !== "completed" || updatedMessage.pending;
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
    };
  }

  return next;
};

import type { ChatMessage } from "@cloudeval/shared";

export const hasRenderableTranscriptMessage = (message: ChatMessage): boolean => {
  const content = (message.content ?? "").trim();
  return Boolean(content || message.thinkingSteps?.length || message.error);
};

export const hasRenderableTranscriptMessages = (
  messages: ChatMessage[],
  excludeStreaming = false
): boolean =>
  messages.some((message) =>
    excludeStreaming && message.role === "assistant" && message.pending
      ? false
      : hasRenderableTranscriptMessage(message)
  );

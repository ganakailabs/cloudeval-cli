import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { ChatMessage } from "@cloudeval/shared";
import { Spinner } from "./Spinner";

export interface TranscriptProps {
  messages: ChatMessage[];
  userName?: string;
  excludeStreaming?: boolean; // If true, only render completed messages (for ScrollView)
}

const AI_NAME = "Eva"; // AI Agent name

export const Transcript: React.FC<TranscriptProps> = ({ messages, userName = "You", excludeStreaming = false }) => {
  // Following Ink best practices: 
  // - For streaming: use message.content directly (updates in place)
  // - For completed: render normally from message.content
  // - Never render each chunk as its own Text component
  
  // Separate completed messages from the streaming one
  const completedMessages = messages.filter(m => !m.pending || m.role === "user");
  const streamingMessage = excludeStreaming ? null : messages.find(m => m.role === "assistant" && m.pending);

  return (
    <Box flexDirection="column" gap={0}>
      {/* Render completed messages (history) */}
      {completedMessages.map((message) => {
        const isUser = message.role === "user";
        const content = (message.content ?? "").trim();
        
        if (!content) return null;
        
        if (isUser) {
          return (
            <Text key={message.id} wrap="wrap">
              <Text bold color="green">{userName}:</Text>
              {" "}
              {content}
            </Text>
          );
        }
        
        // Completed assistant message
        return (
          <Box key={message.id} flexDirection="column" paddingY={0}>
            <Text wrap="wrap">
              <Text bold color="cyan">{AI_NAME}:</Text>
              {" "}
              {content}
            </Text>
            {message.followUpQuestions?.length ? (
              <Box flexDirection="column" paddingLeft={2} marginTop={1}>
                <Text dimColor italic>Follow-up questions:</Text>
                {message.followUpQuestions.map((q, qIdx) => (
                  <Text key={`${message.id}-fu-${qIdx}`} dimColor wrap="wrap">
                    • {q}
                  </Text>
                ))}
              </Box>
            ) : null}
            {message.error && (
              <Box paddingLeft={2} marginTop={0}>
                <Text color="red" wrap="wrap">Error: {message.error}</Text>
              </Box>
            )}
          </Box>
        );
      })}
      
      {/* Render streaming message - CRITICAL: Single Text that updates in place */}
      {streamingMessage && (() => {
        const content = (streamingMessage.content ?? "").trim();
        const hasContent = content.length > 0;
        const showThinkingSteps = !hasContent && streamingMessage.thinkingSteps
          ? streamingMessage.thinkingSteps.filter(
              (step) =>
                step.status === "streaming" &&
                !!((step.description || step.node || "").trim())
            )
          : [];
        
        // Show thinking steps if no content yet
        if (showThinkingSteps.length > 0) {
          return (
            <Box key={streamingMessage.id} flexDirection="column" paddingY={0}>
              <Text bold color="cyan">{AI_NAME}:</Text>
              {showThinkingSteps.map((step, stepIdx) => {
                const isStreamingStep = step.status === "streaming";
                return (
                  <Box 
                    key={`${streamingMessage.id}-step-${stepIdx}`} 
                    flexDirection="row" 
                    gap={1}
                    paddingLeft={2}
                    marginTop={stepIdx > 0 ? 0 : 0}
                  >
                    {isStreamingStep && <Spinner type="dots" />}
                    <Text dimColor italic wrap="wrap">
                      {(step.description || step.node || "Thinking...").trim()}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          );
        }
        
        // Show streaming content - THIS IS THE KEY: Single Text component that updates in place
        // Ink will automatically update this same Text component as content changes
        if (hasContent) {
          return (
            <Text key={streamingMessage.id} wrap="wrap">
              <Text bold color="cyan">{AI_NAME}:</Text>
              {" "}
              {content}
              <Text color="cyan">▌</Text>
            </Text>
          );
        }
        
        return null;
      })()}
    </Box>
  );
};

import React from "react";
import { Box, Text } from "ink";
import { ChatMessage } from "@cloudeval/shared";
import SyntaxHighlight from "ink-syntax-highlight";
import { terminalTheme } from "../theme.js";
import { Spinner } from "./Spinner.js";

export interface TranscriptProps {
  messages: ChatMessage[];
  userName?: string;
  excludeStreaming?: boolean;
  expandedThinkingMessageIds?: Set<string>;
}

const AI_NAME = "Eva";

interface ParsedBlock {
  type: "text" | "code";
  content: string;
  language?: string;
}

const parseMarkdown = (text: string): ParsedBlock[] => {
  const blocks: ParsedBlock[] = [];
  const parts = text.split(/```/g);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i % 2 === 0) {
      // Even indices are text (outside code blocks)
      if (part) {
        blocks.push({ type: "text", content: part });
      }
    } else {
      // Odd indices are code
      const newlineIndex = part.indexOf("\n");
      let language = "";
      let code = part;

      if (newlineIndex !== -1) {
          language = part.substring(0, newlineIndex).trim();
          code = part.substring(newlineIndex + 1);
      }

      // If code is empty but we have a block, keep it empty
      blocks.push({ type: "code", content: code, language });
    }
  }
  return blocks;
};

const renderInlineMarkdown = (
  text: string,
  keyPrefix: string
): React.ReactNode[] => {
  const segments = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).filter(Boolean);
  return segments.map((segment, index) => {
    const key = `${keyPrefix}-${index}`;
    if (segment.startsWith("`") && segment.endsWith("`")) {
      return (
        <Text key={key} color={terminalTheme.accent}>
          {segment.slice(1, -1)}
        </Text>
      );
    }
    if (segment.startsWith("**") && segment.endsWith("**")) {
      return (
        <Text key={key} bold>
          {segment.slice(2, -2)}
        </Text>
      );
    }
    return <Text key={key}>{segment}</Text>;
  });
};

const MarkdownText: React.FC<{ content: string; dim?: boolean }> = ({
  content,
  dim = false,
}) => {
  const lines = content.replace(/\r\n/g, "\n").split("\n");

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => {
        const key = `line-${index}`;
        if (!line.trim()) {
          return <Text key={key}> </Text>;
        }

        const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
        if (heading) {
          return (
            <Text key={key} bold color={terminalTheme.brand} wrap="wrap">
              {renderInlineMarkdown(heading[1], key)}
            </Text>
          );
        }

        const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
        if (bullet) {
          return (
            <Text key={key} dimColor={dim} wrap="wrap">
              {bullet[1]}- {renderInlineMarkdown(bullet[2], key)}
            </Text>
          );
        }

        return (
          <Text key={key} dimColor={dim} wrap="wrap">
            {renderInlineMarkdown(line, key)}
          </Text>
        );
      })}
    </Box>
  );
};

const FormattedContent: React.FC<{ content: string; role: "user" | "assistant" }> = ({ content, role }) => {
  if (role === "user") {
    return <MarkdownText content={content} />;
  }

  const blocks = parseMarkdown(content);

  return (
    <Box flexDirection="column">
      {blocks.map((block, idx) => {
        if (block.type === "code") {
          return (
            <Box key={idx} flexDirection="column" marginY={1}>
              {block.language && (
                <Box paddingX={1} borderStyle="single" borderColor={terminalTheme.muted} width={block.language.length + 4}>
                  <Text bold dimColor>{block.language}</Text>
                </Box>
              )}
              <Box borderStyle="single" paddingX={1} borderColor="dim">
                <SyntaxHighlight code={block.content} language={block.language || "text"} />
              </Box>
            </Box>
          );
        }
        return <MarkdownText key={idx} content={block.content} />;
      })}
    </Box>
  );
};

const formatDuration = (durationMs: number) => {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0
    ? `${minutes}m ${remainingSeconds}s`
    : `${minutes}m`;
};

const getStepDurationMs = (
  step: NonNullable<ChatMessage["thinkingSteps"]>[number],
  now: number
) => {
  const startedAt = step.startedAt ?? step.timestamp;
  const isTerminal =
    step.status === "completed" ||
    step.status === "error" ||
    step.status === "aborted" ||
    step.status === "cancelled";
  if (isTerminal && typeof step.durationMs === "number") {
    return step.durationMs;
  }
  const endedAt = step.completedAt ?? step.updatedAt ?? (isTerminal ? step.timestamp : now);
  return Math.max(0, isTerminal ? endedAt - startedAt : now - startedAt);
};

const getStepStatusMeta = (status?: string) => {
  if (status === "completed") {
    return { marker: "✓", label: "completed", color: terminalTheme.success };
  }
  if (status === "error" || status === "aborted" || status === "cancelled") {
    return {
      marker: "✕",
      label: status === "aborted" ? "aborted" : "failed",
      color: terminalTheme.danger,
    };
  }
  if (status === "streaming") {
    return { marker: "running", label: "running", color: terminalTheme.brand };
  }
  return { marker: "•", label: status || "pending", color: terminalTheme.muted };
};

const ProgressBar: React.FC<{
  completed: number;
  total: number;
  failed: number;
  active?: boolean;
  pulseIndex?: number;
}> = ({
  completed,
  total,
  failed,
  active = false,
  pulseIndex = 0,
}) => {
  const width = 18;
  const safeTotal = Math.max(1, total);
  const filled = Math.min(width, Math.round((completed / safeTotal) * width));
  const failedWidth = failed ? Math.max(1, Math.min(width - filled, failed)) : 0;
  const open = Math.max(0, width - filled - failedWidth);
  const pulsePosition = open > 0 ? pulseIndex % open : -1;
  const openRail = Array.from({ length: open }, (_, index) =>
    active && index === pulsePosition ? "━" : "─"
  );
  return (
    <Text>
      <Text color={terminalTheme.success}>{"━".repeat(filled)}</Text>
      <Text color={terminalTheme.danger}>{"━".repeat(failedWidth)}</Text>
      {openRail.map((character, index) => (
        <Text
          key={index}
          color={active && index === pulsePosition ? terminalTheme.accent : undefined}
          dimColor={!active || index !== pulsePosition}
        >
          {character}
        </Text>
      ))}
    </Text>
  );
};

const ThinkingSteps: React.FC<{
  message: ChatMessage;
  expanded: boolean;
  forceExpanded?: boolean;
}> = ({ message, expanded, forceExpanded = false }) => {
  const steps = message.thinkingSteps ?? [];
  const [now, setNow] = React.useState(() => Date.now());
  const isExpanded = expanded || forceExpanded || Boolean(message.pending);

  React.useEffect(() => {
    if (!message.pending) {
      return;
    }
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [message.pending]);

  if (!steps.length) {
    return null;
  }

  const completedCount = steps.filter((step) => step.status === "completed").length;
  const failedCount = steps.filter(
    (step) =>
      step.status === "error" ||
      step.status === "aborted" ||
      step.status === "cancelled"
  ).length;
  const runningCount = steps.filter((step) => step.status === "streaming").length;
  const summaryParts = [
    `${completedCount}/${steps.length} completed`,
    failedCount ? `${failedCount} failed` : "",
    runningCount ? `${runningCount} running` : "",
  ].filter(Boolean);
  const runningStep = [...steps].reverse().find((step) => step.status === "streaming");

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" gap={1}>
        <Text color={message.pending ? terminalTheme.brand : terminalTheme.muted}>
          {isExpanded ? "▾" : "▸"} Reasoning
        </Text>
        {message.pending ? <Spinner type="pulse" /> : null}
        <ProgressBar
          completed={completedCount}
          failed={failedCount}
          total={steps.length}
          active={message.pending || runningCount > 0}
          pulseIndex={Math.floor(now / 1000)}
        />
        <Text dimColor>({summaryParts.join(", ")})</Text>
      </Box>
      {!isExpanded && runningStep ? (
        <Box paddingLeft={2}>
          <Text color={terminalTheme.brand} wrap="wrap">
            <Spinner type="line" /> {runningStep.description || runningStep.node || "Working"}
          </Text>
        </Box>
      ) : null}
      {isExpanded ? (
        <Box flexDirection="column" paddingLeft={2}>
          {steps.map((step, idx) => {
            const label = step.description || step.node || "Thinking";
            const detail = step.message || step.content;
            const meta = getStepStatusMeta(step.status);
            const duration = formatDuration(getStepDurationMs(step, now));
            return (
              <Box key={`${message.id}-${step.node}-${idx}`} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  {step.status === "streaming" ? (
                    <Text color={meta.color}><Spinner type="line" /></Text>
                  ) : (
                    <Text color={meta.color}>{meta.marker}</Text>
                  )}
                  <Text color={meta.color}>
                    {idx + 1}. [{meta.label}] {label} ({duration})
                  </Text>
                </Box>
                {detail ? (
                  <Box paddingLeft={3}>
                    <MarkdownText content={detail.trim()} dim />
                  </Box>
                ) : null}
              </Box>
            );
          })}
        </Box>
      ) : null}
    </Box>
  );
};

export const Transcript: React.FC<TranscriptProps> = ({
  messages,
  userName = "You",
  excludeStreaming = false,
  expandedThinkingMessageIds,
}) => {
  const completedMessages = messages.filter(m => !m.pending || m.role === "user");
  const streamingMessage = excludeStreaming ? null : messages.find(m => m.role === "assistant" && m.pending);

  return (
    <Box flexDirection="column" gap={0}>
      {completedMessages.map((message) => {
        const isUser = message.role === "user";
        const content = (message.content ?? "").trim();
        const hasThinkingSteps = Boolean(message.thinkingSteps?.length);

        if (!content && !hasThinkingSteps) return null;

        return (
          <Box key={message.id} flexDirection="column" paddingY={0} marginBottom={1}>
            <Text bold color={isUser ? terminalTheme.success : terminalTheme.brand}>
              {isUser ? userName : AI_NAME}:
              {isUser && message.queued ? " (queued)" : ""}
            </Text>
            <Box paddingLeft={0}>
               {content ? (
                 <FormattedContent content={content} role={message.role as any} />
               ) : !hasThinkingSteps && !message.error ? (
                 <Text dimColor>No final response content.</Text>
               ) : null}
            </Box>
            {!isUser ? (
              <ThinkingSteps
                message={message}
                expanded={Boolean(expandedThinkingMessageIds?.has(message.id))}
              />
            ) : null}

            {!isUser && message.followUpQuestions?.length ? (
              <Box flexDirection="column" paddingLeft={2} marginTop={1}>
                <Text dimColor italic>
                  Follow-ups are available as prompt buttons.
                </Text>
              </Box>
            ) : null}
            {!isUser && message.hitlQuestionsAnswered?.answers.length ? (
              <Box flexDirection="column" paddingLeft={2} marginTop={1}>
                <Text dimColor italic>Human input:</Text>
                {message.hitlQuestionsAnswered.answers.map((answer) => (
                  <Text key={`${message.id}-hitl-${answer.question_id}`} dimColor wrap="wrap">
                    - {answer.question_id}: {answer.answer}
                  </Text>
                ))}
              </Box>
            ) : null}
            {!isUser && message.error && (
              <Box paddingLeft={2} marginTop={0}>
                <Text color={terminalTheme.danger} wrap="wrap">Error: {message.error}</Text>
              </Box>
            )}
          </Box>
        );
      })}

      {streamingMessage && (() => {
        const content = (streamingMessage.content ?? "").trim();
        const hasContent = content.length > 0;
        const hasThinkingSteps = Boolean(streamingMessage.thinkingSteps?.length);

        if (!hasContent && hasThinkingSteps) {
          return (
            <Box key={streamingMessage.id} flexDirection="column" paddingY={0}>
              <Text bold color={terminalTheme.brand}>{AI_NAME}:</Text>
              <ThinkingSteps
                message={streamingMessage}
                expanded={true}
                forceExpanded
              />
            </Box>
          );
        }

        if (hasContent) {
            // For streaming, we might have incomplete code blocks.
            // basic parsing still works, but render might be jittery if backticks are appearing.
          return (
            <Box key={streamingMessage.id} flexDirection="column" paddingY={0}>
              <Text bold color={terminalTheme.brand}>{AI_NAME}:</Text>
              <Box paddingLeft={0}>
                  <FormattedContent content={content} role="assistant" />
                  <Text color={terminalTheme.cursor}>|</Text>
              </Box>
              <ThinkingSteps
                message={streamingMessage}
                expanded={Boolean(expandedThinkingMessageIds?.has(streamingMessage.id))}
                forceExpanded
              />
            </Box>
          );
        }

        return null;
      })()}
    </Box>
  );
};

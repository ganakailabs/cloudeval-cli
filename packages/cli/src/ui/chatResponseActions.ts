import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChatMessage } from "@cloudeval/shared";
import { toCitationExportContent } from "./citationContent.js";

type SpawnSyncLike = (
  command: string,
  args: string[],
  options: { input: string; encoding: "utf8" }
) => SpawnSyncReturns<string>;

export interface ClipboardCommand {
  command: string;
  args: string[];
}

export const getLatestAssistantMessage = (
  messages: ChatMessage[]
): ChatMessage | undefined =>
  [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.content.trim());

export const getClipboardCommand = (
  platform: NodeJS.Platform = process.platform
): ClipboardCommand => {
  if (platform === "darwin") {
    return { command: "pbcopy", args: [] };
  }
  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "clip"] };
  }
  return {
    command: "sh",
    args: [
      "-lc",
      "if command -v wl-copy >/dev/null 2>&1; then wl-copy; elif command -v xclip >/dev/null 2>&1; then xclip -selection clipboard; elif command -v xsel >/dev/null 2>&1; then xsel --clipboard --input; else exit 127; fi",
    ],
  };
};

export const copyTextToClipboard = (
  text: string,
  options: {
    platform?: NodeJS.Platform;
    spawnSyncImpl?: SpawnSyncLike;
  } = {}
): void => {
  const clipboardCommand = getClipboardCommand(options.platform);
  const result = (options.spawnSyncImpl ?? spawnSync)(
    clipboardCommand.command,
    clipboardCommand.args,
    { input: text, encoding: "utf8" }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error("No clipboard command is available for this terminal.");
  }
};

export const buildLatestAssistantResponseText = (
  messages: ChatMessage[]
): string | undefined => {
  const message = getLatestAssistantMessage(messages);
  if (!message) {
    return undefined;
  }
  return toCitationExportContent({
    content: message.content,
    toolsUsed: message.toolsUsed,
    citations: message.citations,
  }).trim();
};

const roleLabel = (message: ChatMessage, userName: string): string =>
  message.role === "user" ? userName : "Cloudeval AI";

export const buildChatTranscriptMarkdown = ({
  messages,
  userName,
  threadId,
  exportedAt = new Date(),
}: {
  messages: ChatMessage[];
  userName: string;
  threadId?: string;
  exportedAt?: Date;
}): string => {
  const renderedMessages = messages
    .filter((message) => message.content.trim())
    .map((message) => {
      const content =
        message.role === "assistant"
          ? toCitationExportContent({
              content: message.content,
              toolsUsed: message.toolsUsed,
              citations: message.citations,
            })
          : message.content;
      return `## ${roleLabel(message, userName)}\n\n${content.trim()}`;
    });

  return [
    "# CloudEval chat transcript",
    "",
    `Exported: ${exportedAt.toISOString()}`,
    threadId ? `Thread: ${threadId}` : undefined,
    "",
    ...renderedMessages,
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
};

export const writeChatTranscriptDownload = ({
  messages,
  userName,
  threadId,
  cwd = process.cwd(),
}: {
  messages: ChatMessage[];
  userName: string;
  threadId?: string;
  cwd?: string;
}): string => {
  const dir = resolve(cwd, ".cloudeval-downloads");
  mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `chat-transcript-${timestamp}.md`);
  writeFileSync(
    file,
    buildChatTranscriptMarkdown({ messages, userName, threadId }),
    "utf8"
  );
  return file;
};

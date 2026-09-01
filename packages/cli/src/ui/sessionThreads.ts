import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatState } from "@cloudeval/shared";
import type { LocalSession } from "../sessionsStore.js";
import type { SelectPanelItem } from "./components/SelectPanel.js";
import { truncateForTerminal } from "./layout.js";

export type ThreadSelectValue =
  | { kind: "new" }
  | { kind: "draft"; draft: DraftThreadSummary }
  | { kind: "remote"; thread: RemoteThreadSummary }
  | { kind: "session"; session: LocalSession };

export interface DraftThreadSummary {
  key: string;
  title: string;
  threadId?: string;
  updatedAt?: number;
  projectName?: string;
  messageCount: number;
  status?: ChatState["status"];
}

export interface RemoteThreadSummary {
  thread_id: string;
  title?: string;
  updated_at?: string;
  created_at?: string;
  last_message_preview?: string;
  message_count?: number;
  project_id?: string;
  project_name?: string;
  model?: string;
  pinned?: boolean;
  is_archived?: boolean;
  status?: string;
}

export interface RemoteThreadHistory extends RemoteThreadSummary {
  thread_head?: RemoteThreadSummary;
  messages?: unknown[];
  messages_page?: unknown[];
  thread_messages?: unknown[];
}

interface BuildThreadSelectItemsOptions {
  now?: number;
  drafts?: DraftThreadSummary[];
}

const timestampFromIso = (value: string, fallbackOffset: number): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now() + fallbackOffset;
};

const relativeThreadAge = (value?: string, now = Date.now()): string | undefined => {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const diffMs = Math.max(0, now - parsed);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d`;
  }
  const weeks = Math.floor(days / 7);
  if (weeks < 5) {
    return `${weeks}w`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months}mo`;
  }
  return `${Math.floor(days / 365)}y`;
};

const titleWithAge = (title: string, age?: string): string => {
  if (!age) {
    return truncateForTerminal(title, 72);
  }
  const suffix = ` · ${age}`;
  return `${truncateForTerminal(title, Math.max(12, 72 - suffix.length))}${suffix}`;
};

const createdAgeDescription = (age?: string): string | undefined =>
  age ? (age === "now" ? "created now" : `created ${age} ago`) : undefined;

const sessionDescription = (session: LocalSession, age?: string): string => {
  const project = session.projectName || session.projectId;
  const messages = `${session.messageCount} message${session.messageCount === 1 ? "" : "s"}`;
  return [createdAgeDescription(age), project, messages].filter(Boolean).join(" · ");
};

const draftDescription = (draft: DraftThreadSummary, age?: string): string => {
  const messages = `${draft.messageCount} message${draft.messageCount === 1 ? "" : "s"}`;
  const status =
    draft.status && draft.status !== "idle" && draft.status !== "complete"
      ? draft.status.replace(/_/g, " ")
      : "active locally";
  return ["Open session", status, createdAgeDescription(age), draft.projectName, messages]
    .filter(Boolean)
    .join(" · ");
};

const remoteTitle = (thread: RemoteThreadSummary): string => {
  const title = String(thread.title || "").trim();
  const preview = String(thread.last_message_preview || "").trim();
  return title || preview || thread.thread_id;
};

const remoteDescription = (thread: RemoteThreadSummary, age?: string): string => {
  const project = thread.project_name || thread.project_id;
  const count = Number(thread.message_count ?? 0);
  const messages = `${count} message${count === 1 ? "" : "s"}`;
  const source = thread.is_archived ? "Cloud thread · archived" : "Cloud thread";
  return [source, createdAgeDescription(age), project, messages].filter(Boolean).join(" · ");
};

const extractMessageText = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object") {
          const record = part as Record<string, unknown>;
          if (typeof record.text === "string") {
            return record.text;
          }
          if (typeof record.content === "string") {
            return record.content;
          }
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
  }
  return "";
};

const timestampFromValue = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
};

export const remoteThreadMessagesToChatMessages = (
  history: RemoteThreadHistory
): ChatMessage[] => {
  const rawMessages =
    history.messages_page ?? history.thread_messages ?? history.messages ?? [];
  return rawMessages
    .map((raw, index): ChatMessage | null => {
      if (!raw || typeof raw !== "object") {
        return null;
      }
      const message = raw as Record<string, unknown>;
      const role = String(message.role || "").toLowerCase();
      if (role !== "user" && role !== "assistant") {
        return null;
      }
      const timestamp = timestampFromValue(
        message.timestamp ?? message.created_at ?? message.createdAt,
        Date.now() + index
      );
      const followUps = message.followUpQuestions ?? message.follow_up_questions;
      return {
        id: String(
          message.id ??
            message.message_id ??
            message.assistant_message_id ??
            `${history.thread_id}-${index}-${randomUUID()}`
        ),
        role,
        content: extractMessageText(message.content),
        thinkingSteps: Array.isArray(message.thinkingSteps)
          ? (message.thinkingSteps as ChatMessage["thinkingSteps"])
          : Array.isArray(message.thinking_steps)
            ? (message.thinking_steps as ChatMessage["thinkingSteps"])
            : undefined,
        followUpQuestions: Array.isArray(followUps)
          ? followUps.map((item) => String(item)).filter(Boolean)
          : undefined,
        createdAt: timestamp,
        updatedAt: timestampFromValue(message.updated_at ?? message.updatedAt, timestamp),
      };
    })
    .filter((message): message is ChatMessage => Boolean(message));
};

export const localSessionMessagesToChatMessages = (
  session: LocalSession
): ChatMessage[] =>
  session.messages.map((message, index) => ({
    id: `${session.threadId}-${index}-${randomUUID()}`,
    role: message.role,
    content: message.content,
    createdAt: timestampFromIso(message.createdAt, index),
  }));

export const buildDraftThreadSummary = ({
  key,
  state,
  projectName,
  updatedAt,
}: {
  key: string;
  state: ChatState;
  projectName?: string;
  updatedAt?: number;
}): DraftThreadSummary | null => {
  const messages = state.messages.filter((message) => message.content.trim());
  if (!messages.length && !state.threadId) {
    return null;
  }
  const firstUserMessage = messages.find((message) => message.role === "user");
  const fallbackTitle = state.threadId ?? "New local session";
  const title = truncateForTerminal(
    firstUserMessage?.content.trim() || messages[0]?.content.trim() || fallbackTitle,
    72
  );
  const messageTimestamps = messages
    .map((message) => message.updatedAt ?? message.createdAt)
    .filter((value) => Number.isFinite(value));
  const lastUpdated =
    updatedAt ?? (messageTimestamps.length ? Math.max(...messageTimestamps) : Date.now());
  return {
    key,
    title,
    threadId: state.threadId,
    updatedAt: lastUpdated,
    projectName,
    messageCount: messages.length,
    status: state.status,
  };
};

export const buildThreadSelectItems = (
  sessions: LocalSession[],
  activeThreadId?: string,
  remoteThreads: RemoteThreadSummary[] = [],
  options: BuildThreadSelectItemsOptions = {}
): Array<SelectPanelItem<ThreadSelectValue>> => [
  {
    label: "New thread",
    value: { kind: "new" },
    description: activeThreadId ? "Start a fresh Cloudeval chat thread." : "Current selection.",
  },
  ...(options.drafts ?? []).map((draft) => {
    const age = draft.updatedAt ? relativeThreadAge(new Date(draft.updatedAt).toISOString(), options.now) : undefined;
    return {
      label: titleWithAge(draft.title, age),
      value: { kind: "draft" as const, draft },
      description: draftDescription(draft, age),
    };
  }),
  ...remoteThreads.map((thread) => {
    const age = relativeThreadAge(thread.created_at ?? thread.updated_at, options.now);
    return {
      label: titleWithAge(remoteTitle(thread), age),
      value: { kind: "remote" as const, thread },
      description: remoteDescription(thread, age),
    };
  }),
  ...sessions
    .filter(
      (session) =>
        !remoteThreads.some((thread) => thread.thread_id === session.threadId)
    )
    .map((session) => {
      const age = relativeThreadAge(session.createdAt ?? session.updatedAt, options.now);
      return {
        label: titleWithAge(session.title, age),
        value: { kind: "session" as const, session },
        description: `Local session · ${sessionDescription(session, age)}`,
      };
    }),
];

export const threadPanelTitle = ({
  session,
  remoteThread,
  threadId,
  hasMessages,
}: {
  session?: LocalSession;
  remoteThread?: RemoteThreadSummary;
  threadId?: string;
  hasMessages: boolean;
}): string => {
  if (session?.title) {
    return truncateForTerminal(session.title, 70);
  }
  if (remoteThread) {
    return truncateForTerminal(remoteTitle(remoteThread), 70);
  }
  if (threadId) {
    return truncateForTerminal(threadId, 70);
  }
  return hasMessages ? "Current chat" : "New thread";
};

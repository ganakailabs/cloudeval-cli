import fs from "node:fs/promises";
import path from "node:path";
import { getCloudevalConfigDir, normalizeConfigProfile } from "./cliConfig.js";

export interface LocalSessionMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface LocalSession {
  threadId: string;
  title: string;
  projectId?: string;
  projectName?: string;
  model?: string;
  profile?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  messages: LocalSessionMessage[];
}

export interface SessionSearchOptions {
  profile?: string;
  limit?: number;
}

export interface SessionSearchResult {
  threadId: string;
  title: string;
  projectId?: string;
  projectName?: string;
  model?: string;
  profile?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  score: number;
  preview: string;
}

export interface RecordSessionTurnOptions {
  threadId: string;
  question: string;
  response: string;
  project?: {
    id?: string;
    name?: string;
  };
  model?: string;
  profile?: string;
}

const sessionsDir = (profile?: string): string => {
  const normalized = normalizeConfigProfile(profile);
  if (normalized === "default") {
    return path.join(getCloudevalConfigDir(), "sessions");
  }
  return path.join(getCloudevalConfigDir(), "profiles", normalized, "sessions");
};

const sessionPath = (threadId: string, profile?: string): string =>
  path.join(sessionsDir(profile), `${sanitizeThreadId(threadId)}.json`);

const sanitizeThreadId = (threadId: string): string =>
  threadId.replace(/[^a-zA-Z0-9_.-]/g, "_");

const nowIso = (): string => new Date().toISOString();

const titleFromQuestion = (question: string): string => {
  const singleLine = question
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(can you|could you|please|help me|show me|tell me|what is|what are|how do i)\s+/i, "")
    .replace(/^(review|investigate|triage|summarize|explain|analyze)\s+the\s+/i, "$1 ");
  if (!singleLine) {
    return "Untitled CloudEval session";
  }
  const words = singleLine.split(/\s+/).slice(0, 7);
  const joined = words.join(" ");
  const title = joined.charAt(0).toUpperCase() + joined.slice(1);
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
};

const sanitizeTitle = (title: string): string => {
  const cleaned = title
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    throw new Error("Session title cannot be empty.");
  }
  return cleaned.length > 100 ? cleaned.slice(0, 100) : cleaned;
};

const readSessionFile = async (filePath: string): Promise<LocalSession | null> => {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const writeSessionFile = async (session: LocalSession, profile?: string): Promise<void> => {
  const dir = sessionsDir(profile);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = sessionPath(session.threadId, profile);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(session, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tempPath, filePath);
};

export const recordSessionTurn = async ({
  threadId,
  question,
  response,
  project,
  model,
  profile,
}: RecordSessionTurnOptions): Promise<void> => {
  if (!threadId || (!question.trim() && !response.trim())) {
    return;
  }
  const normalizedProfile = normalizeConfigProfile(profile);
  const filePath = sessionPath(threadId, normalizedProfile);
  const existing = await readSessionFile(filePath);
  const timestamp = nowIso();
  const messages: LocalSessionMessage[] = [
    ...(existing?.messages ?? []),
    ...(question.trim()
      ? [{ role: "user" as const, content: question.trim(), createdAt: timestamp }]
      : []),
    ...(response.trim()
      ? [{ role: "assistant" as const, content: response.trim(), createdAt: timestamp }]
      : []),
  ];
  await writeSessionFile({
    threadId,
    title: existing?.title ?? titleFromQuestion(question),
    projectId: project?.id ?? existing?.projectId,
    projectName: project?.name ?? existing?.projectName,
    model: model ?? existing?.model,
    profile: normalizedProfile,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    messageCount: messages.length,
    messages,
  }, normalizedProfile);
};

export const listSessions = async (limit = 20, profile?: string): Promise<LocalSession[]> => {
  try {
    const dir = sessionsDir(profile);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => readSessionFile(path.join(dir, entry.name)))
    );
    return sessions
      .filter((session): session is LocalSession => Boolean(session))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(1, limit));
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
};

export const getSession = async (threadId: string, profile?: string): Promise<LocalSession | null> =>
  readSessionFile(sessionPath(threadId, profile));

export const renameSession = async (
  threadId: string,
  title: string,
  profile?: string
): Promise<LocalSession | null> => {
  const session = await getSession(threadId, profile);
  if (!session) {
    return null;
  }
  const updated = {
    ...session,
    title: sanitizeTitle(title),
    updatedAt: nowIso(),
  };
  await writeSessionFile(updated, profile);
  return updated;
};

const searchTerms = (query: string): string[] =>
  query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);

const countTerm = (text: string, term: string): number => {
  if (!text || !term) return 0;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.match(new RegExp(escaped, "gi"))?.length ?? 0;
};

const previewFor = (session: LocalSession, terms: string[]): string => {
  const matched = session.messages
    .map((message) => ({
      message,
      score: terms.reduce((total, term) => total + countTerm(message.content, term), 0),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.message;
  const value = matched?.content ?? session.messages.at(-1)?.content ?? session.title;
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > 180 ? `${singleLine.slice(0, 177)}...` : singleLine;
};

const scoreSession = (session: LocalSession, terms: string[]): number => {
  const title = session.title.toLowerCase();
  const project = `${session.projectId ?? ""} ${session.projectName ?? ""}`.toLowerCase();
  const messages = session.messages.map((message) => message.content).join("\n").toLowerCase();
  return terms.reduce(
    (score, term) =>
      score +
      countTerm(title, term) * 8 +
      countTerm(project, term) * 4 +
      countTerm(messages, term),
    0
  );
};

const toSearchResult = (
  session: LocalSession,
  score: number,
  terms: string[]
): SessionSearchResult => ({
  threadId: session.threadId,
  title: session.title,
  projectId: session.projectId,
  projectName: session.projectName,
  model: session.model,
  profile: session.profile,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  messageCount: session.messageCount,
  score,
  preview: previewFor(session, terms),
});

export const searchSessions = async (
  query: string,
  options: SessionSearchOptions = {}
): Promise<SessionSearchResult[]> => {
  const terms = searchTerms(query);
  const sessions = await exportSessions(options.profile);
  if (!terms.length) {
    return sessions
      .slice(0, Math.max(1, options.limit ?? 20))
      .map((session) => toSearchResult(session, 0, []));
  }
  return sessions
    .map((session) => ({
      session,
      score: scoreSession(session, terms),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.session.updatedAt.localeCompare(a.session.updatedAt))
    .slice(0, Math.max(1, options.limit ?? 20))
    .map((entry) => toSearchResult(entry.session, entry.score, terms));
};

export const resolveSessionReference = async (
  reference: string,
  profile?: string
): Promise<LocalSession | null> => {
  const trimmed = reference.trim();
  if (!trimmed) {
    return null;
  }
  const exact = await getSession(trimmed, profile);
  if (exact) {
    return exact;
  }
  const sessions = await exportSessions(profile);
  const lower = trimmed.toLowerCase();
  return (
    sessions.find((session) => session.title.toLowerCase() === lower) ??
    sessions.find((session) => session.threadId.startsWith(trimmed)) ??
    sessions.find((session) => session.title.toLowerCase().includes(lower)) ??
    null
  );
};

export const deleteSession = async (threadId: string, profile?: string): Promise<boolean> => {
  try {
    await fs.unlink(sessionPath(threadId, profile));
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

export const exportSessions = async (profile?: string): Promise<LocalSession[]> =>
  listSessions(Number.MAX_SAFE_INTEGER, profile);

export const pruneSessions = async (olderThanDays: number, profile?: string): Promise<number> => {
  const cutoff = Date.now() - Math.max(1, olderThanDays) * 24 * 60 * 60 * 1000;
  const sessions = await exportSessions(profile);
  let deleted = 0;
  for (const session of sessions) {
    const updatedAt = Date.parse(session.updatedAt);
    if (Number.isFinite(updatedAt) && updatedAt < cutoff) {
      if (await deleteSession(session.threadId, profile)) {
        deleted++;
      }
    }
  }
  return deleted;
};

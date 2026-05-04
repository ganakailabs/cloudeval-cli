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
  const singleLine = question.replace(/\s+/g, " ").trim();
  if (!singleLine) {
    return "Untitled CloudEval session";
  }
  return singleLine.length > 80 ? `${singleLine.slice(0, 77)}...` : singleLine;
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

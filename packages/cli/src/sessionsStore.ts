import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

type SqlRow = Record<string, unknown>;

interface SessionDatabase {
  rows(sql: string, params?: unknown[]): SqlRow[];
  run(sql: string, params?: unknown[]): void;
  persist(): Promise<void>;
  close(): void;
}

const SQLJS_WASM_ENV_VAR = "CLOUDEVAL_SQLJS_WASM";

const legacySessionsDir = (profile?: string): string => {
  const normalized = normalizeConfigProfile(profile);
  if (normalized === "default") {
    return path.join(getCloudevalConfigDir(), "sessions");
  }
  return path.join(getCloudevalConfigDir(), "profiles", normalized, "sessions");
};

const sessionsDatabasePath = (profile?: string): string => {
  const normalized = normalizeConfigProfile(profile);
  if (normalized === "default") {
    return path.join(getCloudevalConfigDir(), "sessions.sqlite");
  }
  return path.join(getCloudevalConfigDir(), "profiles", normalized, "sessions.sqlite");
};

const legacySessionPath = (threadId: string, profile?: string): string =>
  path.join(legacySessionsDir(profile), `${sanitizeThreadId(threadId)}.json`);

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
    return "Untitled Cloudeval session";
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

const hasFile = (candidate: string): boolean => {
  try {
    return fsSync.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

const findSqlJsWasmInNodeModules = (dir: string): string | undefined => {
  const nodeModulesDir = path.join(dir, "node_modules");
  const direct = path.join(nodeModulesDir, "sql.js", "dist", "sql-wasm.wasm");
  if (hasFile(direct)) {
    return direct;
  }

  const pnpmRoot = path.join(nodeModulesDir, ".pnpm");
  if (!fsSync.existsSync(pnpmRoot)) {
    return undefined;
  }

  for (const entry of fsSync.readdirSync(pnpmRoot)) {
    if (!entry.startsWith("sql.js@")) {
      continue;
    }

    const candidate = path.join(
      pnpmRoot,
      entry,
      "node_modules",
      "sql.js",
      "dist",
      "sql-wasm.wasm"
    );
    if (hasFile(candidate)) {
      return candidate;
    }
  }

  return undefined;
};

const searchSqlJsWasmFrom = (start: string): string | undefined => {
  let current = path.resolve(start);
  while (true) {
    const localCandidates = [
      path.join(current, "sql-wasm.wasm"),
      path.join(current, "dist", "sql-wasm.wasm"),
    ];

    for (const candidate of localCandidates) {
      if (hasFile(candidate)) {
        return candidate;
      }
    }

    const nodeModulesMatch = findSqlJsWasmInNodeModules(current);
    if (nodeModulesMatch) {
      return nodeModulesMatch;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
};

const resolveSqlJsWasmPath = (): string | undefined => {
  if (process.env[SQLJS_WASM_ENV_VAR]) {
    return process.env[SQLJS_WASM_ENV_VAR];
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const seen = new Set<string>();
  const roots = [process.cwd(), moduleDir, path.dirname(process.execPath)];

  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    if (seen.has(resolvedRoot)) {
      continue;
    }
    seen.add(resolvedRoot);

    const match = searchSqlJsWasmFrom(resolvedRoot);
    if (match) {
      return match;
    }
  }

  return undefined;
};

const isBunRuntime = (): boolean =>
  typeof (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun === "string";

const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<any>;

const openBunDatabase = async (dbPath: string): Promise<SessionDatabase | null> => {
  if (!isBunRuntime()) {
    return null;
  }

  try {
    const { Database } = await dynamicImport("bun:sqlite");
    await fs.mkdir(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    const db = new Database(dbPath, { create: true });
    db.exec("PRAGMA foreign_keys = ON");
    return {
      rows(sql, params = []) {
        const statement = db.query(sql);
        return statement.all(...params) as SqlRow[];
      },
      run(sql, params = []) {
        const statement = db.query(sql);
        statement.run(...params);
      },
      async persist() {
        // bun:sqlite writes directly to the database file.
      },
      close() {
        db.close();
      },
    };
  } catch {
    return null;
  }
};

let sqlJsFactoryPromise: Promise<any> | null = null;

const loadSqlJsFactory = async (): Promise<any> => {
  if (!sqlJsFactoryPromise) {
    sqlJsFactoryPromise = (async () => {
      const initSqlJs = (await import("sql.js")).default;
      const wasmPath = resolveSqlJsWasmPath();
      return initSqlJs({
        locateFile: (file: string) => {
          if (file === "sql-wasm.wasm" && wasmPath) {
            return wasmPath;
          }
          return file;
        },
      });
    })();
  }
  return sqlJsFactoryPromise;
};

const openSqlJsDatabase = async (dbPath: string): Promise<SessionDatabase> => {
  await fs.mkdir(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const SQL = await loadSqlJsFactory();
  let bytes: Buffer | undefined;
  try {
    bytes = await fs.readFile(dbPath);
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const db = bytes ? new SQL.Database(bytes) : new SQL.Database();
  db.run("PRAGMA foreign_keys = ON");
  let dirty = false;

  return {
    rows(sql, params = []) {
      const statement = db.prepare(sql, params);
      const rows: SqlRow[] = [];
      try {
        while (statement.step()) {
          rows.push(statement.getAsObject() as SqlRow);
        }
      } finally {
        statement.free();
      }
      return rows;
    },
    run(sql, params = []) {
      db.run(sql, params);
      dirty = true;
    },
    async persist() {
      if (!dirty) {
        return;
      }
      const tempPath = `${dbPath}.${process.pid}.tmp`;
      await fs.writeFile(tempPath, Buffer.from(db.export()), { mode: 0o600 });
      await fs.rename(tempPath, dbPath);
      dirty = false;
    },
    close() {
      db.close();
    },
  };
};

const openSessionDatabase = async (profile?: string): Promise<SessionDatabase> => {
  const dbPath = sessionsDatabasePath(profile);
  return (await openBunDatabase(dbPath)) ?? openSqlJsDatabase(dbPath);
};

const ensureSchema = (db: SessionDatabase): void => {
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      thread_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      project_id TEXT,
      project_name TEXT,
      model TEXT,
      profile TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS session_messages (
      session_thread_id TEXT NOT NULL,
      message_index INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_thread_id, message_index),
      FOREIGN KEY (session_thread_id) REFERENCES sessions(thread_id) ON DELETE CASCADE
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC)");
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_session_messages_thread ON session_messages(session_thread_id, message_index)"
  );
  ensureFtsSchema(db);
};

const ensureFtsSchema = (db: SessionDatabase): boolean => {
  try {
    db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
        thread_id UNINDEXED,
        title,
        project,
        content
      )
    `);
    return true;
  } catch {
    return false;
  }
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const messageFromRow = (row: SqlRow): LocalSessionMessage | null => {
  const role = row.role;
  const content = row.content;
  const createdAt = row.created_at;
  if ((role !== "user" && role !== "assistant") || typeof content !== "string") {
    return null;
  }
  return {
    role,
    content,
    createdAt: typeof createdAt === "string" ? createdAt : nowIso(),
  };
};

const sessionFromRow = (db: SessionDatabase, row: SqlRow): LocalSession | null => {
  const threadId = row.thread_id;
  const title = row.title;
  const createdAt = row.created_at;
  const updatedAt = row.updated_at;
  if (
    typeof threadId !== "string" ||
    typeof title !== "string" ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    return null;
  }

  const messages = db
    .rows(
      `SELECT role, content, created_at
       FROM session_messages
       WHERE session_thread_id = ?
       ORDER BY message_index ASC`,
      [threadId]
    )
    .map(messageFromRow)
    .filter((message): message is LocalSessionMessage => Boolean(message));

  return {
    threadId,
    title,
    projectId: optionalString(row.project_id),
    projectName: optionalString(row.project_name),
    model: optionalString(row.model),
    profile: optionalString(row.profile),
    createdAt,
    updatedAt,
    messageCount: Number(row.message_count) || messages.length,
    messages,
  };
};

const getSessionFromDb = (db: SessionDatabase, threadId: string): LocalSession | null => {
  const row = db.rows("SELECT * FROM sessions WHERE thread_id = ?", [threadId])[0];
  return row ? sessionFromRow(db, row) : null;
};

const runTransaction = <T>(db: SessionDatabase, fn: () => T): T => {
  db.run("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.run("COMMIT");
    return result;
  } catch (error) {
    try {
      db.run("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
};

const upsertSession = (db: SessionDatabase, session: LocalSession): void => {
  runTransaction(db, () => {
    db.run(
      `INSERT INTO sessions (
        thread_id,
        title,
        project_id,
        project_name,
        model,
        profile,
        created_at,
        updated_at,
        message_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        title = excluded.title,
        project_id = excluded.project_id,
        project_name = excluded.project_name,
        model = excluded.model,
        profile = excluded.profile,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        message_count = excluded.message_count`,
      [
        session.threadId,
        session.title,
        session.projectId ?? null,
        session.projectName ?? null,
        session.model ?? null,
        session.profile ?? "default",
        session.createdAt,
        session.updatedAt,
        session.messages.length,
      ]
    );
    db.run("DELETE FROM session_messages WHERE session_thread_id = ?", [session.threadId]);
    session.messages.forEach((message, index) => {
      db.run(
        `INSERT INTO session_messages (
          session_thread_id,
          message_index,
          role,
          content,
          created_at
        ) VALUES (?, ?, ?, ?, ?)`,
        [session.threadId, index, message.role, message.content, message.createdAt]
      );
    });
    upsertSessionFts(db, session);
  });
};

const upsertSessionFts = (db: SessionDatabase, session: LocalSession): void => {
  if (!ensureFtsSchema(db)) {
    return;
  }
  try {
    db.run("DELETE FROM session_messages_fts WHERE thread_id = ?", [session.threadId]);
    db.run(
      `INSERT INTO session_messages_fts (thread_id, title, project, content)
       VALUES (?, ?, ?, ?)`,
      [
        session.threadId,
        session.title,
        [session.projectId, session.projectName].filter(Boolean).join(" "),
        session.messages.map((message) => message.content).join("\n"),
      ],
    );
  } catch {
    // FTS is an acceleration path only; regular session storage remains authoritative.
  }
};

const deleteSessionFts = (db: SessionDatabase, threadId: string): void => {
  if (!ensureFtsSchema(db)) {
    return;
  }
  try {
    db.run("DELETE FROM session_messages_fts WHERE thread_id = ?", [threadId]);
  } catch {
    // Ignore FTS cleanup failures; the sessions table is authoritative.
  }
};

const readLegacySessionFile = async (filePath: string): Promise<LocalSession | null> => {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? normalizeLegacySession(parsed) : null;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const normalizeLegacySession = (value: any): LocalSession | null => {
  if (!value || typeof value !== "object" || typeof value.threadId !== "string") {
    return null;
  }
  const timestamp = nowIso();
  const messages: LocalSessionMessage[] = Array.isArray(value.messages)
    ? value.messages
        .map((message: any): LocalSessionMessage | null => {
          if (
            !message ||
            (message.role !== "user" && message.role !== "assistant") ||
            typeof message.content !== "string"
          ) {
            return null;
          }
          return {
            role: message.role,
            content: message.content,
            createdAt: typeof message.createdAt === "string" ? message.createdAt : timestamp,
          };
        })
        .filter((message: LocalSessionMessage | null): message is LocalSessionMessage =>
          Boolean(message)
        )
    : [];

  return {
    threadId: value.threadId,
    title: typeof value.title === "string" && value.title.trim()
      ? sanitizeTitle(value.title)
      : "Untitled Cloudeval session",
    projectId: optionalString(value.projectId),
    projectName: optionalString(value.projectName),
    model: optionalString(value.model),
    profile: optionalString(value.profile),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : timestamp,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : timestamp,
    messageCount: messages.length,
    messages,
  };
};

const readLegacySessions = async (profile?: string): Promise<LocalSession[]> => {
  try {
    const dir = legacySessionsDir(profile);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => readLegacySessionFile(path.join(dir, entry.name)))
    );
    return sessions.filter((session): session is LocalSession => Boolean(session));
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
};

const migrateLegacyJsonSessions = async (
  db: SessionDatabase,
  profile?: string
): Promise<void> => {
  const normalizedProfile = normalizeConfigProfile(profile);
  const legacySessions = await readLegacySessions(normalizedProfile);
  for (const session of legacySessions) {
    if (getSessionFromDb(db, session.threadId)) {
      continue;
    }
    upsertSession(db, {
      ...session,
      profile: session.profile ?? normalizedProfile,
      messageCount: session.messages.length,
    });
  }
};

const sessionDatabaseQueues = new Map<string, Promise<void>>();

const withSessionDatabase = async <T>(
  profile: string | undefined,
  fn: (db: SessionDatabase, normalizedProfile: string) => T | Promise<T>
): Promise<T> => {
  const normalizedProfile = normalizeConfigProfile(profile);
  // sql.js rewrites the database file. Serialize the entire read/modify/write
  // cycle so concurrent TUI loads and saves cannot collide or lose updates.
  const queueKey = sessionsDatabasePath(normalizedProfile);
  const previous = sessionDatabaseQueues.get(queueKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  sessionDatabaseQueues.set(queueKey, current);
  await previous;
  try {
    const db = await openSessionDatabase(normalizedProfile);
    try {
      ensureSchema(db);
      await migrateLegacyJsonSessions(db, normalizedProfile);
      const result = await fn(db, normalizedProfile);
      await db.persist();
      return result;
    } finally {
      db.close();
    }
  } finally {
    release();
    if (sessionDatabaseQueues.get(queueKey) === current) {
      sessionDatabaseQueues.delete(queueKey);
    }
  }
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
  await withSessionDatabase(profile, (db, normalizedProfile) => {
    const existing = getSessionFromDb(db, threadId);
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
    upsertSession(db, {
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
    });
  });
};

export const listSessions = async (limit = 20, profile?: string): Promise<LocalSession[]> =>
  withSessionDatabase(profile, (db) => {
    const rows = db.rows(
      `SELECT *
       FROM sessions
       ORDER BY updated_at DESC
       LIMIT ?`,
      [Math.max(1, limit)]
    );
    return rows
      .map((row) => sessionFromRow(db, row))
      .filter((session): session is LocalSession => Boolean(session));
  });

const listAllSessionsFromDb = (db: SessionDatabase): LocalSession[] => {
  const rows = db.rows(
    `SELECT *
     FROM sessions
     ORDER BY updated_at DESC`
  );
  return rows
    .map((row) => sessionFromRow(db, row))
    .filter((session): session is LocalSession => Boolean(session));
};

export const getSession = async (threadId: string, profile?: string): Promise<LocalSession | null> =>
  withSessionDatabase(profile, (db) => getSessionFromDb(db, threadId));

export const renameSession = async (
  threadId: string,
  title: string,
  profile?: string
): Promise<LocalSession | null> => {
  return withSessionDatabase(profile, (db) => {
    const session = getSessionFromDb(db, threadId);
    if (!session) {
      return null;
    }
    const updated = {
      ...session,
      title: sanitizeTitle(title),
      updatedAt: nowIso(),
    };
    upsertSession(db, updated);
    return updated;
  });
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
  const limit = Math.max(1, options.limit ?? 20);
  return withSessionDatabase(options.profile, (db) => {
    const sessions = listAllSessionsFromDb(db);
    if (!terms.length) {
      return sessions
        .slice(0, limit)
        .map((session) => toSearchResult(session, 0, []));
    }

    const ftsMatches = searchSessionsWithFts(db, terms, limit * 4);
    const candidates = ftsMatches?.length ? ftsMatches : sessions;
    return candidates
      .map((session) => ({
        session,
        score: scoreSession(session, terms),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.session.updatedAt.localeCompare(a.session.updatedAt))
      .slice(0, limit)
      .map((entry) => toSearchResult(entry.session, entry.score, terms));
  });
};

const ftsQueryForTerms = (terms: string[]): string =>
  terms
    .map((term) => term.replace(/"/g, ""))
    .filter(Boolean)
    .map((term) => `${term}*`)
    .join(" OR ");

const rebuildFtsIndex = (db: SessionDatabase): void => {
  if (!ensureFtsSchema(db)) {
    return;
  }
  try {
    const sessionCount = Number(db.rows("SELECT COUNT(*) AS count FROM sessions")[0]?.count ?? 0);
    const ftsCount = Number(db.rows("SELECT COUNT(*) AS count FROM session_messages_fts")[0]?.count ?? 0);
    if (ftsCount >= sessionCount) {
      return;
    }
    db.run("DELETE FROM session_messages_fts");
    for (const session of listAllSessionsFromDb(db)) {
      upsertSessionFts(db, session);
    }
  } catch {
    // Fall back to in-memory scoring if FTS maintenance is unavailable.
  }
};

const searchSessionsWithFts = (
  db: SessionDatabase,
  terms: string[],
  limit: number,
): LocalSession[] | null => {
  if (!ensureFtsSchema(db)) {
    return null;
  }
  const query = ftsQueryForTerms(terms);
  if (!query) {
    return null;
  }
  try {
    rebuildFtsIndex(db);
    const rows = db.rows(
      `SELECT sessions.*
       FROM session_messages_fts
       JOIN sessions ON sessions.thread_id = session_messages_fts.thread_id
       WHERE session_messages_fts MATCH ?
       ORDER BY bm25(session_messages_fts) ASC, sessions.updated_at DESC
       LIMIT ?`,
      [query, limit],
    );
    return rows
      .map((row) => sessionFromRow(db, row))
      .filter((session): session is LocalSession => Boolean(session));
  } catch {
    return null;
  }
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
  const deleted = await withSessionDatabase(profile, (db) => {
    const existing = getSessionFromDb(db, threadId);
    if (!existing) {
      return false;
    }
    deleteSessionFts(db, threadId);
    db.run("DELETE FROM sessions WHERE thread_id = ?", [threadId]);
    return true;
  });

  try {
    await fs.unlink(legacySessionPath(threadId, profile));
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  return deleted;
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

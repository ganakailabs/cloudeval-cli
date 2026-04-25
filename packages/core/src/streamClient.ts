import {
  Chunk,
  ChunkStatus,
  ErrorChunk,
  HitlOption,
  HitlQuestion,
  HitlRequestChunk,
  HitlResponse,
  HitlResumeChunk,
  MetadataChunk,
  RespondingChunk,
  StreamRequestPayload,
  StreamSettings,
  ThinkingChunk,
} from "@cloudeval/shared";
import { normalizeApiBase } from "./auth";

export interface StreamChatOptions {
  baseUrl: string;
  authToken?: string;
  message: string;
  threadId: string;
  user: { id: string; name: string };
  project?: {
    id: string;
    name: string;
    user_id?: string;
    cloud_provider?: string;
    type?: string;
    connection_ids?: string[];
  };
  settings?: StreamSettings;
  context?: Array<Record<string, unknown>>;
  streamingMode?: "USER" | "DEBUG";
  signal?: AbortSignal;
  debug?: boolean;
  completeAfterResponse?: boolean;
  responseCompletionGraceMs?: number;
  hitlResume?: {
    checkpointId: string;
    responses: HitlResponse[];
    runId?: string;
    langsmithTraceId?: string;
  };
}

const DEFAULT_PROJECT_TYPE = "sync";
const RESPONSE_OUTPUT_NODES = new Set([
  "generate_response",
  "handle_social_interaction",
  "response_compose",
]);

const isLocalHostname = (hostname: string): boolean => {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower === "127.0.0.1" ||
    lower === "::1" ||
    lower === "[::1]"
  );
};

const assertSecureBaseUrl = (rawBaseUrl: string): void => {
  const parsed = new URL(rawBaseUrl);
  if (parsed.protocol === "https:") {
    return;
  }
  if (parsed.protocol === "http:" && isLocalHostname(parsed.hostname)) {
    return;
  }
  throw new Error(
    `Refusing insecure base URL (${rawBaseUrl}). Use HTTPS for non-localhost endpoints.`
  );
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isValidChunkStatus = (value: unknown): value is ChunkStatus => {
  return (
    typeof value === "string" &&
    (value === "streaming" ||
      value === "completed" ||
      value === "aborted" ||
      value === "error" ||
      value === "pending")
  );
};

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const numberOrUndefined = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const booleanOrUndefined = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const isResponseOutputChunk = (chunk: Chunk): chunk is RespondingChunk =>
  chunk.type === "responding" &&
  (!chunk.node || RESPONSE_OUTPUT_NODES.has(chunk.node));

const isResponseCompletionChunk = (chunk: Chunk): boolean =>
  isResponseOutputChunk(chunk) && chunk.status === "completed";

const normalizeHitlOption = (raw: unknown, index: number): HitlOption => {
  if (!isObject(raw)) {
    const label = String(raw ?? `Option ${index + 1}`);
    return { id: label, label };
  }

  const id =
    stringOrUndefined(raw.id) ??
    stringOrUndefined(raw.value) ??
    stringOrUndefined(raw.label) ??
    `option_${index}`;
  return {
    id,
    label: stringOrUndefined(raw.label) ?? id,
    description: stringOrUndefined(raw.description),
    recommended: booleanOrUndefined(raw.recommended),
  };
};

const normalizeHitlQuestion = (raw: unknown, index: number): HitlQuestion => {
  if (!isObject(raw)) {
    return {
      id: `question_${index}`,
      text: String(raw ?? "Action required"),
    };
  }

  const id =
    stringOrUndefined(raw.id) ??
    stringOrUndefined(raw.question_id) ??
    `question_${index}`;
  const text =
    stringOrUndefined(raw.text) ??
    stringOrUndefined(raw.label) ??
    stringOrUndefined(raw.message) ??
    "Action required";
  const options = Array.isArray(raw.options)
    ? raw.options.map((option, optionIndex) =>
        normalizeHitlOption(option, optionIndex)
      )
    : undefined;

  return {
    id,
    text,
    label: stringOrUndefined(raw.label),
    kind: stringOrUndefined(raw.kind),
    intent: stringOrUndefined(raw.intent),
    tool_label: stringOrUndefined(raw.tool_label),
    action: stringOrUndefined(raw.action),
    options,
    recommended_option_id: stringOrUndefined(raw.recommended_option_id),
    mode_switch_source: stringOrUndefined(raw.mode_switch_source),
    mode_switch_target: stringOrUndefined(raw.mode_switch_target),
    resume_behavior: stringOrUndefined(raw.resume_behavior),
    selectionMode: stringOrUndefined(raw.selectionMode),
    minSelections: numberOrUndefined(raw.minSelections),
    maxSelections: numberOrUndefined(raw.maxSelections),
  };
};

const normalizeChunk = (raw: unknown, receivedAt: number): Chunk | null => {
  if (!isObject(raw) || typeof raw.type !== "string") {
    return null;
  }

  const base = { receivedAt };
  const data = isObject(raw.data) ? raw.data : undefined;

  switch (raw.type) {
    case "metadata": {
      const chunk: MetadataChunk = {
        type: "metadata",
        trace_id: typeof raw.trace_id === "string" ? raw.trace_id : undefined,
        thread_id: typeof raw.thread_id === "string" ? raw.thread_id : undefined,
        ...base,
      };
      return chunk;
    }
    case "thinking": {
      const chunk: ThinkingChunk = {
        type: "thinking",
        node: typeof raw.node === "string" ? raw.node : undefined,
        status: isValidChunkStatus(raw.status) ? raw.status : undefined,
        description:
          typeof raw.description === "string" ? raw.description : undefined,
        message: typeof raw.message === "string" ? raw.message : undefined,
        content: typeof raw.content === "string" ? raw.content : undefined,
        ...base,
      };
      return chunk;
    }
    case "responding": {
      const chunk: RespondingChunk = {
        type: "responding",
        node: typeof raw.node === "string" ? raw.node : undefined,
        status: isValidChunkStatus(raw.status) ? raw.status : undefined,
        description:
          typeof raw.description === "string" ? raw.description : undefined,
        message: typeof raw.message === "string" ? raw.message : undefined,
        content: typeof raw.content === "string" ? raw.content : undefined,
        ...base,
      };
      return chunk;
    }
    case "error": {
      const chunk: ErrorChunk = {
        type: "error",
        node: typeof raw.node === "string" ? raw.node : undefined,
        status: isValidChunkStatus(raw.status) ? raw.status : undefined,
        description:
          typeof raw.description === "string" ? raw.description : undefined,
        message: typeof raw.message === "string" ? raw.message : undefined,
        content: typeof raw.content === "string" ? raw.content : undefined,
        stacktrace:
          typeof raw.stacktrace === "string" ? raw.stacktrace : undefined,
        ...base,
      };
      return chunk;
    }
    case "hitl":
    case "hitl_request": {
      const rawQuestions = Array.isArray(raw.questions)
        ? raw.questions
        : Array.isArray(data?.questions)
          ? data.questions
          : [];
      const chunk: HitlRequestChunk = {
        type: "hitl_request",
        questions: rawQuestions.map((question, index) =>
          normalizeHitlQuestion(question, index)
        ),
        checkpoint_id:
          stringOrUndefined(raw.checkpoint_id) ??
          stringOrUndefined(data?.checkpoint_id),
        pending_intent_id:
          stringOrUndefined(raw.pending_intent_id) ??
          stringOrUndefined(data?.pending_intent_id),
        run_id: stringOrUndefined(raw.run_id) ?? stringOrUndefined(data?.run_id),
        langsmith_trace_id:
          stringOrUndefined(raw.langsmith_trace_id) ??
          stringOrUndefined(data?.langsmith_trace_id),
        ...base,
      };
      return chunk;
    }
    case "hitl_resume": {
      const chunk: HitlResumeChunk = {
        type: "hitl_resume",
        status: isValidChunkStatus(raw.status) ? raw.status : undefined,
        message: typeof raw.message === "string" ? raw.message : undefined,
        pending_intent_id:
          stringOrUndefined(raw.pending_intent_id) ??
          stringOrUndefined(data?.pending_intent_id),
        ...base,
      };
      return chunk;
    }
    default:
      return null;
  }
};

const buildPayload = (options: StreamChatOptions): StreamRequestPayload => {
  const user =
    options.project?.user_id && (!options.user.id || options.user.id === "cli-user")
      ? { ...options.user, id: options.project.user_id }
      : options.user;
  const project: StreamRequestPayload["project"] = options.project ?? {
    id: "cli-project",
    name: "CLI Session",
    user_id: user.id,
    cloud_provider: "azure",
    type: DEFAULT_PROJECT_TYPE,
  };
  const context = options.context ?? [];
  const settings = options.settings;
  const message = options.message;

  const payload: StreamRequestPayload = {
    thread_id: options.threadId,
    input: {
      messages: [{ role: "user", content: message }],
      user,
      project,
      settings,
      context,
    },
    user,
    message,
    project,
    settings,
    context,
    group_size: 1,
    streaming_mode: options.streamingMode ?? "USER",
  };

  if (
    options.hitlResume?.checkpointId &&
    options.hitlResume.responses.length > 0
  ) {
    payload.hitl_resume = true;
    payload.hitl_checkpoint_id = options.hitlResume.checkpointId;
    payload.hitl_responses = options.hitlResume.responses;
    if (options.hitlResume.runId) {
      payload.run_id = options.hitlResume.runId;
    }
    if (options.hitlResume.langsmithTraceId) {
      payload.langsmith_trace_id = options.hitlResume.langsmithTraceId;
    }
  }

  return payload;
};

const compactErrorBody = (body: string): string | undefined => {
  const trimmed = body.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return JSON.stringify(parsed);
  } catch {
    return trimmed.length > 1000 ? `${trimmed.slice(0, 1000)}...` : trimmed;
  }
};

export async function* streamChat(
  options: StreamChatOptions
): AsyncGenerator<Chunk> {
  assertSecureBaseUrl(options.baseUrl);
  const payload = buildPayload(options);
  const apiBase = normalizeApiBase(options.baseUrl);
  const url = `${apiBase}/chat/stream`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "X-Client-Type": "cloudeval-cli",
    "X-Client-Version": "0.1.0",
  };

  if (options.authToken) {
    headers.Authorization = `Bearer ${options.authToken}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: options.signal,
  });

  if (!response.ok) {
    const body = compactErrorBody(await response.text().catch(() => ""));
    throw new Error(
      `Stream request failed with status ${response.status} ${response.statusText}${
        body ? `: ${body}` : ""
      }`
    );
  }

  if (!response.body) {
    throw new Error("Streaming response body missing");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let sseDataLines: string[] = [];
  let doneSeen = false;
  let responseCompleteDeadline: number | undefined;
  const responseCompletionGraceMs = options.responseCompletionGraceMs ?? 5000;

  const parsePayload = (rawPayload: string) => {
    const trimmed = rawPayload.trim();
    if (!trimmed) {
      return;
    }
    if (trimmed === "[DONE]") {
      doneSeen = true;
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      const chunk = normalizeChunk(parsed, Date.now());
      if (chunk && options.debug) {
        console.error("[stream][chunk]", chunk);
      }
      if (chunk) {
        return chunk;
      }
    } catch (error) {
      if (options.debug) {
        console.error("[stream][parse-error]", error, rawPayload);
      }
    }
  };

  const flushSseEvent = () => {
    if (sseDataLines.length === 0) {
      return;
    }
    const payload = sseDataLines.join("\n");
    sseDataLines = [];
    return parsePayload(payload);
  };

  const parseLine = (line: string) => {
    const normalizedLine = line.replace(/\r$/, "");
    if (!normalizedLine) {
      return flushSseEvent();
    }

    if (normalizedLine.startsWith(":")) {
      return;
    }

    if (normalizedLine.startsWith("data:")) {
      sseDataLines.push(normalizedLine.slice(5).trimStart());
      return;
    }

    if (
      normalizedLine.startsWith("event:") ||
      normalizedLine.startsWith("id:") ||
      normalizedLine.startsWith("retry:")
    ) {
      return;
    }

    if (sseDataLines.length > 0) {
      sseDataLines.push(normalizedLine);
      return;
    }

    return parsePayload(normalizedLine);
  };

  const readWithOptionalDeadline = async () => {
    if (!responseCompleteDeadline) {
      return { type: "read" as const, result: await reader.read() };
    }

    const remainingMs = responseCompleteDeadline - Date.now();
    if (remainingMs <= 0) {
      return { type: "deadline" as const };
    }

    return Promise.race([
      reader.read().then((result) => ({ type: "read" as const, result })),
      new Promise<{ type: "deadline" }>((resolve) =>
        setTimeout(() => resolve({ type: "deadline" }), remainingMs)
      ),
    ]);
  };

  const markResponseComplete = (chunk: Chunk) => {
    if (!options.completeAfterResponse || !isResponseOutputChunk(chunk)) {
      return;
    }

    if (isResponseCompletionChunk(chunk)) {
      responseCompleteDeadline ??= Date.now() + responseCompletionGraceMs;
      return;
    }

    // Some backend fallback/error paths stream the response content but do not
    // emit the final response-completed event. Treat response-content idleness
    // as completion so packaged CLI clients do not hang on background work.
    if (chunk.content) {
      responseCompleteDeadline = Date.now() + responseCompletionGraceMs;
    }
  };

  try {
    while (true) {
      const read = await readWithOptionalDeadline();
      if (read.type === "deadline") {
        return;
      }

      const { value, done } = read.result;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const chunk = parseLine(line);
        if (chunk) {
          yield chunk;
          markResponseComplete(chunk);
        }
        if (doneSeen) {
          return;
        }
      }
    }

    if (buffer.trim()) {
      const chunk = parseLine(buffer);
      if (chunk) {
        yield chunk;
        markResponseComplete(chunk);
      }
      if (doneSeen) {
        return;
      }
    }

    const finalChunk = flushSseEvent();
    if (finalChunk) {
      yield finalChunk;
      markResponseComplete(finalChunk);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released by the runtime after a completed stream.
    }
  }
}

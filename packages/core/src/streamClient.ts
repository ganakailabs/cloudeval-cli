import {
  ChatCitationEntry,
  ChatCitationMarker,
  ChatToolSourceEntry,
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
  redactSensitiveText,
} from "@cloudeval/shared";
import { normalizeApiBase } from "./auth";
import { withIdempotencyHeader } from "./idempotency";

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
  agentProfileId?: string;
  streamingMode?: "USER" | "DEBUG";
  signal?: AbortSignal;
  debug?: boolean;
  completeAfterResponse?: boolean;
  responseCompletionGraceMs?: number;
  streamIdleTimeoutMs?: number;
  hitlResume?: {
    checkpointId: string;
    responses: HitlResponse[];
    runId?: string;
    langsmithTraceId?: string;
  };
}

export class StreamRequestError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body: string;

  constructor(input: { status: number; statusText: string; body: string }) {
    super(
      `Stream request failed with status ${input.status} ${input.statusText}${
        input.body ? `: ${input.body}` : ""
      }`
    );
    this.name = "StreamRequestError";
    this.status = input.status;
    this.statusText = input.statusText;
    this.body = input.body;
  }
}

export const isExpiredDeviceTokenStreamError = (error: unknown): boolean => {
  if (!(error instanceof StreamRequestError) || error.status !== 401) {
    return false;
  }
  const text = `${error.body}\n${error.message}`;
  return /device token has expired|invalid token[^a-z0-9]+.*expired|token[^a-z0-9]+.*expired/i.test(
    text
  );
};

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

const objectArrayOrUndefined = <T extends Record<string, unknown>>(
  value: unknown
): T[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const records = value.filter(isObject) as T[];
  return records.length ? records : undefined;
};

const isResponseOutputChunk = (chunk: Chunk): chunk is RespondingChunk =>
  chunk.type === "responding" &&
  (!chunk.node || RESPONSE_OUTPUT_NODES.has(chunk.node));

const isResponseCompletionChunk = (chunk: Chunk): boolean =>
  isResponseOutputChunk(chunk) && chunk.status === "completed";

const isTerminalEndChunk = (chunk: Chunk): boolean =>
  (chunk.type === "thinking" || chunk.type === "responding") &&
  chunk.status === "completed" &&
  chunk.node === "end";

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
        source: stringOrUndefined(raw.source),
        tools_used:
          objectArrayOrUndefined<ChatToolSourceEntry>(raw.tools_used) ??
          objectArrayOrUndefined<ChatToolSourceEntry>(data?.tools_used),
        citation_markers:
          objectArrayOrUndefined<ChatCitationMarker>(raw.citation_markers) ??
          objectArrayOrUndefined<ChatCitationMarker>(data?.citation_markers),
        citations:
          objectArrayOrUndefined<ChatCitationEntry>(raw.citations) ??
          objectArrayOrUndefined<ChatCitationEntry>(data?.citations),
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
  const agentProfileId = options.agentProfileId?.trim();

  const payload: StreamRequestPayload = {
    thread_id: options.threadId,
    input: {
      messages: [{ role: "user", content: message }],
      user,
      project,
      settings,
      ...(agentProfileId ? { agent_profile_id: agentProfileId } : {}),
      context,
    },
    user,
    message,
    project,
    settings,
    ...(agentProfileId ? { agent_profile_id: agentProfileId } : {}),
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
    return redactSensitiveText(JSON.stringify(parsed));
  } catch {
    const redacted = redactSensitiveText(trimmed);
    return redacted.length > 1000 ? `${redacted.slice(0, 1000)}...` : redacted;
  }
};

export async function* streamChat(
  options: StreamChatOptions
): AsyncGenerator<Chunk> {
  assertSecureBaseUrl(options.baseUrl);
  const payload = buildPayload(options);
  const apiBase = normalizeApiBase(options.baseUrl);
  const streamUrl = new URL(`${apiBase}/chat/stream`);
  if (options.project?.id) {
    streamUrl.searchParams.set("project_id", options.project.id);
  }
  const url = streamUrl.toString();
  const streamIdleTimeoutMs =
    typeof options.streamIdleTimeoutMs === "number" &&
    Number.isFinite(options.streamIdleTimeoutMs) &&
    options.streamIdleTimeoutMs > 0
      ? options.streamIdleTimeoutMs
      : undefined;

  const headers: Record<string, string> = withIdempotencyHeader({
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "X-Client-Type": "cloudeval-cli",
    "X-Client-Version": "0.1.0",
  });

  if (options.authToken) {
    headers.Authorization = `Bearer ${options.authToken}`;
  }

  let connectTimedOut = false;
  let connectTimeout: ReturnType<typeof setTimeout> | undefined;
  let removeExternalAbort: (() => void) | undefined;
  let requestSignal = options.signal;
  const connectController = streamIdleTimeoutMs ? new AbortController() : undefined;
  if (connectController) {
    requestSignal = connectController.signal;
    if (options.signal) {
      const abortFromExternal = () => connectController.abort(options.signal?.reason);
      if (options.signal.aborted) {
        abortFromExternal();
      } else {
        options.signal.addEventListener("abort", abortFromExternal, { once: true });
        removeExternalAbort = () =>
          options.signal?.removeEventListener("abort", abortFromExternal);
      }
    }
    connectTimeout = setTimeout(() => {
      connectTimedOut = true;
      connectController.abort();
    }, streamIdleTimeoutMs);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: requestSignal,
    });
  } catch (error) {
    if (connectTimedOut && streamIdleTimeoutMs) {
      throw new Error(
        `No chat stream response received within ${streamIdleTimeoutMs}ms. Please retry or check backend availability.`
      );
    }
    throw error;
  } finally {
    if (connectTimeout) {
      clearTimeout(connectTimeout);
    }
    removeExternalAbort?.();
  }

  if (!response.ok) {
    const body = compactErrorBody(await response.text().catch(() => ""));
    throw new StreamRequestError({
      status: response.status,
      statusText: response.statusText,
      body: body ?? "",
    });
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
  let streamActivityAt = Date.now();
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
    if (!responseCompleteDeadline && !streamIdleTimeoutMs) {
      return { type: "read" as const, result: await reader.read() };
    }

    const deadline = responseCompleteDeadline ?? streamActivityAt + streamIdleTimeoutMs!;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return responseCompleteDeadline
        ? { type: "deadline" as const }
        : { type: "idle-timeout" as const };
    }

    return Promise.race([
      reader.read().then((result) => ({ type: "read" as const, result })),
      new Promise<{ type: "deadline" } | { type: "idle-timeout" }>((resolve) =>
        setTimeout(
          () =>
            resolve(
              responseCompleteDeadline
                ? { type: "deadline" }
                : { type: "idle-timeout" }
            ),
          remainingMs
        )
      ),
    ]);
  };

  const markResponseComplete = (chunk: Chunk) => {
    if (!options.completeAfterResponse) {
      return;
    }

    if (isTerminalEndChunk(chunk)) {
      responseCompleteDeadline ??= Date.now() + responseCompletionGraceMs;
      return;
    }

    if (!isResponseOutputChunk(chunk)) {
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
      if (read.type === "idle-timeout") {
        throw new Error(
          `No chat stream data received within ${streamIdleTimeoutMs}ms. Please retry or check backend availability.`
        );
      }

      const { value, done } = read.result;
      if (done) break;
      if (value?.length) {
        streamActivityAt = Date.now();
      }

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

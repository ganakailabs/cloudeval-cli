import {
  Chunk,
  ChunkStatus,
  ErrorChunk,
  MetadataChunk,
  RespondingChunk,
  StreamRequestPayload,
  StreamSettings,
  ThinkingChunk,
} from "@cloudeval/shared";

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
}

const DEFAULT_PROJECT_TYPE = "sync";

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

const normalizeChunk = (raw: unknown, receivedAt: number): Chunk | null => {
  if (!isObject(raw) || typeof raw.type !== "string") {
    return null;
  }

  const base = { receivedAt };

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
    default:
      return null;
  }
};

const buildPayload = (options: StreamChatOptions): StreamRequestPayload => {
  const project: StreamRequestPayload["project"] = options.project ?? {
    id: "cli-project",
    name: "CLI Session",
    user_id: options.user.id,
    cloud_provider: "azure",
    type: DEFAULT_PROJECT_TYPE,
  };

  return {
    thread_id: options.threadId,
    user: options.user,
    message: options.message,
    project,
    settings: options.settings,
    context: options.context ?? [],
    group_size: 1,
    streaming_mode: options.streamingMode ?? "USER",
  };
};

export async function* streamChat(
  options: StreamChatOptions
): AsyncGenerator<Chunk> {
  const payload = buildPayload(options);
  // Preserve any API prefix in baseUrl; avoid double slashes.
  const base = options.baseUrl.endsWith("/")
    ? options.baseUrl.slice(0, -1)
    : options.baseUrl;
  const url = `${base}/chat/stream`;

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
    throw new Error(`Stream request failed with status ${response.status}`);
  }

  if (!response.body) {
    throw new Error("Streaming response body missing");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const parseLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
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
        console.error("[stream][parse-error]", error, line);
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const chunk = parseLine(line);
      if (chunk) {
        yield chunk;
      }
    }
  }

  if (buffer.trim()) {
    const chunk = parseLine(buffer);
    if (chunk) {
      yield chunk;
    }
  }
}

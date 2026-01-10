export type ChunkType = "metadata" | "thinking" | "responding" | "error";

export type ChunkStatus = "streaming" | "completed" | "aborted" | "error" | "pending";

export interface BaseChunk {
  type: ChunkType;
  receivedAt: number;
}

export interface MetadataChunk extends BaseChunk {
  type: "metadata";
  trace_id?: string;
  thread_id?: string;
}

export interface ThinkingChunk extends BaseChunk {
  type: "thinking";
  node?: string;
  status?: ChunkStatus;
  description?: string;
  message?: string;
  content?: string;
}

export interface RespondingChunk extends BaseChunk {
  type: "responding";
  node?: string;
  status?: ChunkStatus;
  description?: string;
  message?: string;
  content?: string;
}

export interface ErrorChunk extends BaseChunk {
  type: "error";
  node?: string;
  status?: ChunkStatus;
  description?: string;
  message?: string;
  content?: string;
  stacktrace?: string;
}

export type Chunk = MetadataChunk | ThinkingChunk | RespondingChunk | ErrorChunk;

export interface ThinkingStep {
  node: string;
  type: "thinking" | "responding";
  description?: string;
  message?: string;
  content?: string;
  status?: ChunkStatus | "cancelled";
  timestamp: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  pending?: boolean;
  thinkingSteps?: ThinkingStep[];
  error?: string;
  followUpQuestions?: string[];
  createdAt: number;
  updatedAt?: number;
}

export type ChatStatus =
  | "idle"
  | "booting"
  | "connecting"
  | "thinking"
  | "streaming"
  | "tool_running"
  | "complete"
  | "error"
  | "canceled";

export interface ChatState {
  status: ChatStatus;
  threadId?: string;
  model?: string;
  traceId?: string;
  messages: ChatMessage[];
  activeMessageId?: string;
  followUpScratch?: string;
  error?: string;
  lastChunk?: Chunk;
  debug?: boolean;
  connectedAt?: number;
}

export interface StreamSettings {
  max_tokens?: number;
  temperature?: number;
  model?: string;
  response_length?: string;
  technicality?: string;
}

export interface StreamRequestPayload {
  thread_id: string;
  user: { id: string; name: string };
  message: string;
  project: {
    id: string;
    name: string;
    user_id?: string;
    cloud_provider?: string;
    type?: string;
    connection_ids?: string[];
  };
  settings?: StreamSettings;
  context?: Array<Record<string, unknown>>;
  group_size?: number;
  streaming_mode?: "USER" | "DEBUG";
}

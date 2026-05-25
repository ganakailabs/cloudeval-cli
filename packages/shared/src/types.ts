export type ChunkType =
  | "metadata"
  | "thinking"
  | "responding"
  | "error"
  | "hitl_request"
  | "hitl_resume";

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
  source?: string;
  tools_used?: ChatToolSourceEntry[];
  citation_markers?: ChatCitationMarker[];
  citations?: ChatCitationEntry[];
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

export interface HitlOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface HitlQuestion {
  id: string;
  text: string;
  label?: string;
  kind?: string;
  intent?: string;
  tool_label?: string;
  action?: string;
  options?: HitlOption[];
  recommended_option_id?: string;
  mode_switch_source?: string;
  mode_switch_target?: string;
  resume_behavior?: string;
  selectionMode?: string;
  minSelections?: number;
  maxSelections?: number;
}

export interface HitlResponse {
  question_id: string;
  answer: string;
}

export interface HitlRequestChunk extends BaseChunk {
  type: "hitl_request";
  questions: HitlQuestion[];
  checkpoint_id?: string;
  pending_intent_id?: string;
  run_id?: string;
  langsmith_trace_id?: string;
}

export interface HitlResumeChunk extends BaseChunk {
  type: "hitl_resume";
  status?: ChunkStatus;
  message?: string;
  pending_intent_id?: string;
}

export type Chunk =
  | MetadataChunk
  | ThinkingChunk
  | RespondingChunk
  | ErrorChunk
  | HitlRequestChunk
  | HitlResumeChunk;

export interface ThinkingStep {
  node: string;
  type: "thinking" | "responding" | "hitl";
  description?: string;
  message?: string;
  content?: string;
  status?: ChunkStatus | "cancelled";
  timestamp: number;
  startedAt?: number;
  updatedAt?: number;
  completedAt?: number;
  durationMs?: number;
  hitlQuestions?: HitlQuestion[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  pending?: boolean;
  queued?: boolean;
  thinkingSteps?: ThinkingStep[];
  toolsUsed?: ChatToolSourceEntry[];
  citationMarkers?: ChatCitationMarker[];
  citations?: ChatCitationEntry[];
  error?: string;
  followUpQuestions?: string[];
  hitlQuestionsAnswered?: {
    questions: HitlQuestion[];
    answers: HitlResponse[];
  };
  createdAt: number;
  updatedAt?: number;
}

export interface ChatToolSourceEntry {
  source_id?: string;
  title?: string;
  tool_friendly_name?: string;
  tool_name?: string;
  source_url?: string;
  quote?: string;
  loc?: string;
  [key: string]: unknown;
}

export interface ChatCitationMarker {
  start?: number;
  end?: number;
  source_index?: number;
  source_id?: string;
  tag_start?: number;
  tag_end?: number;
  origin?: "model" | "repaired" | "fallback";
  [key: string]: unknown;
}

export interface ChatCitationEntry {
  source_id?: string;
  title?: string;
  url?: string;
  quote?: string;
  loc?: string;
  alignment_score?: number;
  origin?: "model" | "repaired" | "fallback";
  [key: string]: unknown;
}

export interface ChatCitationAlignmentStats {
  checked?: number;
  reassigned?: number;
  dropped?: number;
  low_confidence?: number;
  min_alignment_score?: number;
  [key: string]: unknown;
}

export type ChatStatus =
  | "idle"
  | "booting"
  | "connecting"
  | "thinking"
  | "streaming"
  | "tool_running"
  | "hitl_waiting"
  | "complete"
  | "error"
  | "canceled";

export interface HitlState {
  waiting: boolean;
  questions: HitlQuestion[];
  checkpointId?: string;
  pendingIntentId?: string;
  runId?: string;
  langsmithTraceId?: string;
  messageId?: string;
}

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
  hitl?: HitlState;
  debug?: boolean;
  connectedAt?: number;
}

export interface StreamSettings {
  max_tokens?: number;
  temperature?: number;
  model?: string;
  mode?: "ask" | "agent";
  response_length?: string;
  technicality?: string;
}

export interface AgentProfileDefaultSettings {
  mode: "ask" | "agent";
  response_length: string;
  technicality: string;
  reasoning_effort: string;
  max_tools?: number | null;
  max_tools_per_type?: number | null;
  enable_judge?: boolean | null;
  enable_hitl?: boolean | null;
}

export interface AgentProfileStarterPromptVariant {
  id: string;
  project_source: "template" | "sync";
  mode: "ask" | "agent";
  text: string;
  weight?: number | null;
}

export interface AgentProfile {
  id: string;
  display_name: string;
  description: string;
  personality: string;
  accent_key: string;
  icon_key: string;
  default_mode: "ask" | "agent";
  starter_prompt: string;
  starter_prompts?: Partial<Record<"template" | "sync", string>>;
  starter_prompt_variants?: AgentProfileStarterPromptVariant[];
  system_instructions: string;
  default_settings: AgentProfileDefaultSettings;
  required_capabilities: string[];
  allowed_toolsets: string[];
  output_contract?: Record<string, unknown>;
}

export interface AgentProfilesListResponse {
  profiles: AgentProfile[];
}

export interface AgentProfileResponse {
  profile: AgentProfile;
}

export interface StreamInputPayload {
  messages: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  user?: { id: string; name: string };
  project?: {
    id: string;
    name: string;
    user_id?: string;
    cloud_provider?: string;
    type?: string;
    connection_ids?: string[];
  };
  settings?: StreamSettings;
  agent_profile_id?: string;
  context?: Array<Record<string, unknown>>;
}

export interface StreamRequestPayload {
  thread_id: string;
  input: StreamInputPayload;
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
  agent_profile_id?: string;
  context?: Array<Record<string, unknown>>;
  group_size?: number;
  streaming_mode?: "USER" | "DEBUG";
  hitl_resume?: boolean;
  hitl_checkpoint_id?: string;
  hitl_responses?: HitlResponse[];
  run_id?: string;
  langsmith_trace_id?: string;
}

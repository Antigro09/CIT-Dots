import type { Workspace } from "../server/workspaces";

export type { Workspace } from "../server/workspaces";

/** JSON records used by the broker, GUI, and durable tools. Times are ISO-8601 UTC. */
export interface BaseRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  version?: number;
}

export type ModelProvider = "ollama" | "lmstudio";
export interface ModelProfile extends BaseRecord {
  name: string;
  provider: ModelProvider;
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  capabilities?: { streaming: boolean; tools: boolean };
  lastCheckedAt?: string;
  status?: "unknown" | "ready" | "error";
  error?: string;
}

export interface Project extends BaseRecord {
  name: string;
  path: string;
  isGit: boolean;
}

export interface Session extends BaseRecord {
  title: string;
  projectId: string | null;
  modelProfileId: string | null;
}

export type MessageRole = "user" | "assistant" | "system" | "tool";
export type MessageKind = "chat" | "progress" | "result" | "question" | "error";
export interface Attachment {
  name: string;
  content: string;
}
export interface Message extends BaseRecord {
  sessionId: string;
  role: MessageRole;
  content: string;
  taskId?: string | null;
  kind?: MessageKind;
  attachments?: Attachment[];
}

export type TaskRole = "coordinator" | "coder" | "investigator" | "reviewer";
export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_child"
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted";
export interface Task extends BaseRecord {
  sessionId: string;
  parentId: string | null;
  rootId: string;
  role: TaskRole;
  title: string;
  prompt: string;
  projectId: string | null;
  modelProfileId: string;
  profileSnapshot: ModelProfile;
  status: TaskStatus;
  depth: number;
  eveSessionId?: string;
  /** A crash while sending is uncertain; recovery must never blindly resend the prompt. */
  promptDispatch?: "sending" | "sent";
  assistantMessageId?: string;
  reconnectAttempts?: number;
  reconnectAfterAt?: string;
  workspace?: Workspace;
  result?: string;
  error?: string;
  tokenUsage?: number;
  toolCount?: number;
  steps?: number;
  goalId?: string | null;
  occurrence?: string | null;
  cursor?: number;
  deadlineAt?: string;
}

export type ScheduleType = "once" | "interval" | "cron";
export interface Goal extends BaseRecord {
  title: string;
  objective: string;
  sessionId: string;
  projectId: string | null;
  modelProfileId: string;
  scheduleType: ScheduleType;
  intervalMinutes?: number;
  cron?: string;
  timezone: string;
  nextRunAt: string;
  enabled: boolean;
  overlap: "skip" | "queue";
  lastRunAt?: string;
  lastTaskId?: string;
}

export interface Memory extends BaseRecord {
  title: string;
  content: string;
  source?: string;
}
export type MemoryRecord = Memory;

export interface Approval extends BaseRecord {
  taskId: string;
  toolName: string;
  input: Record<string, unknown>;
  description: string;
  status: "pending" | "approved" | "denied";
  operationId: string;
  decisionAt?: string;
}

export interface InboxItem extends BaseRecord {
  sessionId: string;
  taskId?: string;
  messageId?: string;
  title: string;
  body: string;
  kind: "progress" | "result" | "question" | "error";
  read: boolean;
  delivered: boolean;
}

/** Numeric ids are monotonic database cursors, suitable for SSE Last-Event-ID. */
export interface Event {
  id: number;
  type: string;
  data: unknown;
  createdAt: string;
  taskId?: string | null;
}

export interface Settings {
  paused: boolean;
  defaultModelProfileId: string | null;
  roleModelProfileIds?: Partial<Record<TaskRole, string | null>>;
  maxActiveTasks: number;
  maxConcurrentInference: number;
  maxDepth: number;
  maxSteps: number;
  maxToolCalls: number;
  maxRunMinutes: number;
  maxTokensPerGoal: number;
  sandboxImage: string;
  theme: "dark" | "light" | "system";
}

export type ToolOperationStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "unknown";
export interface ToolOperation extends BaseRecord {
  taskId: string;
  toolName: string;
  input: Record<string, unknown>;
  status: ToolOperationStatus;
  result?: unknown;
  error?: string;
  approvalId?: string;
}

export interface Health {
  broker: boolean;
  eve: boolean;
  docker: boolean;
}

export interface Snapshot {
  sessions: Session[];
  models: ModelProfile[];
  projects: Project[];
  tasks: Task[];
  goals: Goal[];
  memories: Memory[];
  approvals: Approval[];
  inbox: InboxItem[];
  settings: Settings;
  health: Health;
  eventsCursor: number;
}

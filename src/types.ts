export type TaskStatus =
  | 'received'
  | 'waiting_approval'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type UserRole = 'member' | 'group_admin' | 'system_admin';

export type TaskOrigin = 'interactive' | 'automation' | 'reflection';

export type HermesRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stopping';

export type ArtifactKind = 'file' | 'image' | 'audio' | 'video';

export type ResultKind = 'text' | 'image' | 'file';

export type AttachmentKind = 'file' | 'image' | 'video';

export type MemoryScope = 'user' | 'room';

export type MemoryProposalScope = 'user' | 'room' | 'agent';

export type MemoryProposalStatus = 'pending' | 'approved' | 'rejected' | 'auto_approved';

export type ToolRiskLevel = 'low' | 'medium' | 'high' | 'blocked';

export type ToolCallStatus = 'created' | 'running' | 'completed' | 'failed' | 'cancelled';

export type ToolResultKind = 'text' | 'image' | 'file';

export type AutomationKind = 'reminder' | 'scheduled_prompt';

export type AutomationScheduleType = 'once' | 'daily' | 'weekly' | 'interval';

export type AutomationStatus = 'active' | 'paused' | 'completed' | 'failed';

export interface RoomConfig {
  stableId?: string;
  id?: string;
  runtimeIds?: string[];
  topic?: string;
  enabled: boolean;
  admins: string[];
}

export interface AppConfig {
  bot: {
    name: string;
    mentionAliases: string[];
  };
  wechat: {
    puppet: string;
    puppetOptions: Record<string, unknown>;
  };
  storage: {
    sqlitePath: string;
    uploadsDir: string;
    outputsDir: string;
  };
  logging: {
    level: string;
    file: string;
  };
  agent: {
    hermes: {
      baseURL: string;
      apiKey: string;
      sessionSecret: string;
      model: string;
      requestTimeoutMs: number;
      pollIntervalMs: number;
      maxConcurrentRuns: number;
    };
    mcp: {
      enabled: boolean;
      host: string;
      port: number;
      apiKey: string;
      contextTtlMs: number;
    };
    memoryBridge: {
      baseURL: string;
      apiKey: string;
    };
    sandbox: {
      enabled: boolean;
      maxExecutionMs: number;
      memoryLimitBytes: number;
      maxOutputChars: number;
    };
  };
  media: {
    baseURL: string;
    nativeBaseURL: string;
    apiKey: string;
    multimodalModel: string;
    imageModel: string;
    videoModels: {
      textToVideo: string;
      imageToVideo: string;
      referenceToVideo: string;
      videoEdit: string;
    };
    tts: {
      enabled: boolean;
      apiKey: string;
      model: string;
      voice: string;
    };
  };
  limits: {
    userRequestsPerMinute: number;
    roomRequestsPerMinute: number;
    imageTasksPerMinute: number;
    imageGenerationTasksPerMinute: number;
    voiceTasksPerMinute: number;
    videoTasksPerMinute: number;
    agentTaskTimeoutMs: number;
    maxConcurrentTasks: number;
    maxConcurrentLongTasks: number;
    taskTimeoutMs: number;
    videoGenerationTimeoutMs: number;
    videoGenerationPollIntervalMs: number;
    maxFileBytes: number;
    maxImageBytes: number;
    maxVideoBytes: number;
    maxReplyTextChars: number;
    publicContextMessagesPerRoom: number;
    memoryEntriesPerUser: number;
    globalMemoryEntries: number;
    attachmentTtlHours: number;
    maxMcpOutputChars: number;
  };
  reflection: {
    enabled: boolean;
    candidateThreshold: number;
    idleMs: number;
    minSessionIntervalMs: number;
    maxTasksPerBatch: number;
    autoWriteConfidence: number;
  };
  automations: {
    enabled: boolean;
    tickMs: number;
    timezone: string;
    maxConsecutiveFailures: number;
    retryCount: number;
    retryDelayMs: number;
  };
  auth: {
    systemAdmins: string[];
    allowTopicRoomBinding: boolean;
    rooms: RoomConfig[];
  };
}

export interface IncomingAttachment {
  id?: string;
  name: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  kind: AttachmentKind;
  messageId?: string;
}

export interface IncomingMessage {
  id: string;
  roomId: string;
  roomTopic: string;
  senderId: string;
  senderName: string;
  text: string;
  mentioned: boolean;
  mentionText: string;
  attachments: IncomingAttachment[];
  loadAttachments?: () => Promise<IncomingAttachment[]>;
  timestamp: Date;
}

export interface BotResponder {
  replyText(text: string): Promise<void>;
  replyFile(filePath: string, displayName?: string): Promise<void>;
  replyImage(filePath: string, displayName?: string): Promise<void>;
}

export interface ParsedCommand {
  type:
    | 'enable_room'
    | 'disable_room'
    | 'status'
    | 'health'
    | 'clear_user_context'
    | 'clear_room_context'
    | 'cancel_task'
    | 'approve_task'
    | 'reject_task'
    | 'approve_memory_proposal'
    | 'reject_memory_proposal'
    | 'remember_user'
    | 'remember_global'
    | 'show_user_memory'
    | 'show_global_memory'
    | 'list_memory_proposals'
    | 'delete_user_memory'
    | 'clear_user_memory'
    | 'clear_global_memory'
    | 'create_automation'
    | 'list_automations'
    | 'pause_automation'
    | 'resume_automation'
    | 'delete_automation'
    | 'normal_request';
  rawText: string;
  taskId?: string;
  automationId?: string;
  automationIndex?: number;
  proposalId?: string;
  memoryId?: string;
  prompt?: string;
  memoryText?: string;
  automationText?: string;
}

export interface TaskRecord {
  id: string;
  roomId: string;
  userId: string;
  origin: TaskOrigin;
  status: TaskStatus;
  prompt: string;
  resultKind?: ResultKind;
  resultText?: string;
  resultPath?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentRecord {
  id: string;
  roomId: string;
  userId: string;
  messageId?: string;
  fileName: string;
  filePath: string;
  mimeType: string;
  sizeBytes: number;
  hash: string;
  kind: AttachmentKind;
  createdAt: string;
  expiresAt: string;
}

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  roomId: string;
  userId?: string;
  source: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface ToolCallRecord {
  id: string;
  taskId: string;
  roomId: string;
  userId: string;
  toolName: string;
  status: ToolCallStatus;
  riskLevel: ToolRiskLevel;
  inputJson: string;
  resultKind?: ToolResultKind;
  resultPreview?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRecord {
  id: string;
  roomId: string;
  creatorId: string;
  name: string;
  kind: AutomationKind;
  scheduleType: AutomationScheduleType;
  scheduleSpecJson: string;
  timezone: string;
  prompt: string;
  status: AutomationStatus;
  consecutiveFailures: number;
  lastRunAt?: string;
  nextRunAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoomState {
  id: string;
  topic?: string;
  enabled: boolean;
  admins: string[];
  authorized: boolean;
}

export interface HermesRunRecord {
  taskId: string;
  runId: string;
  sessionId: string;
  sessionKeyHash: string;
  contextIdHash: string;
  status: HermesRunStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface McpContextRecord {
  tokenHash: string;
  taskId: string;
  roomId: string;
  userId: string;
  role: UserRole;
  purpose: TaskOrigin;
  attachmentIds: string[];
  expiresAt: string;
  revokedAt?: string;
  createdAt: string;
}

export interface HermesSessionRecord {
  sessionKeyHash: string;
  roomId: string;
  userId: string;
  epoch: number;
  purpose: TaskOrigin;
  hermesSessionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryProposalRecord {
  id: string;
  scope: MemoryProposalScope;
  roomId: string;
  userId?: string;
  content: string;
  evidence: string;
  confidence: number;
  status: MemoryProposalStatus;
  proposerTaskId?: string;
  decidedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentLessonRecord {
  id: string;
  content: string;
  evidence: string;
  confidence: number;
  approvedBy: string;
  revokedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReflectionBatchRecord {
  id: string;
  roomId: string;
  userId: string;
  trigger: 'threshold' | 'idle' | 'manual';
  taskIds: string[];
  evidence: Array<{ taskId: string; signal: string; evidence: string }>;
  hermesRunId?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactRecord {
  id: string;
  taskId: string;
  runId?: string;
  kind: ArtifactKind;
  filePath: string;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
  deliveredAt?: string;
}

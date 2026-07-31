export type TaskStatus =
  | 'received'
  | 'waiting_approval'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type UserRole = 'member' | 'group_admin' | 'system_admin';

export type ResultKind = 'text' | 'image' | 'file';

export type AttachmentKind = 'file' | 'image' | 'video';

export type MemoryScope = 'user' | 'global';

export type ToolRiskLevel = 'low' | 'medium' | 'high' | 'blocked';

export type ToolCallStatus = 'created' | 'running' | 'completed' | 'failed' | 'cancelled';

export type ToolResultKind = 'text' | 'image' | 'file';

export type AutomationKind = 'reminder' | 'scheduled_prompt' | 'scheduled_tool';

export type AutomationScheduleType = 'once' | 'daily' | 'weekly' | 'interval';

export type AutomationStatus = 'active' | 'paused' | 'completed' | 'failed';

export type RequestKind =
  | 'qa'
  | 'summary'
  | 'rewrite'
  | 'translate'
  | 'web_search'
  | 'file_analysis'
  | 'image_analysis'
  | 'video_analysis'
  | 'image_generation'
  | 'voice_generation'
  | 'video_generation'
  | 'document_generation'
  | 'report'
  | 'room_minutes'
  | 'data整理'
  | 'admin';

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
  llm: {
    baseURL: string;
    apiKey: string;
    textModel: string;
    visionModel: string;
    imageModel?: string;
    videoModel?: string;
    tts: {
      enabled: boolean;
      baseURL: string;
      apiKey: string;
      resourceId: string;
      voice: string;
      speechRate: number;
    };
  };
  search: {
    enabled: boolean;
    provider: 'openrouter' | 'brave';
    braveApiKey: string;
    engine?: 'auto' | 'native' | 'exa' | 'firecrawl' | 'parallel';
    searchContextSize: 'low' | 'medium' | 'high';
    count: number;
    country?: string;
    searchLang?: string;
    uiLang?: string;
    safeSearch: 'off' | 'moderate' | 'strict';
    extraSnippets: boolean;
  };
  tools: {
    policy: {
      defaultHighRiskRequiresApproval: boolean;
      allowNetworkTools: boolean;
      allowFileWriteTools: boolean;
      maxToolOutputChars: number;
      denyTools: string[];
      roomToolOverrides: Array<{
        roomId: string;
        denyTools: string[];
        allowTools: string[];
      }>;
    };
  };
  limits: {
    userRequestsPerMinute: number;
    roomRequestsPerMinute: number;
    fileTasksPerMinute: number;
    imageTasksPerMinute: number;
    voiceTasksPerMinute: number;
    videoTasksPerMinute: number;
    searchTasksPerMinute: number;
    maxAgentSteps: number;
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
    contextMessagesPerUser: number;
    publicContextMessagesPerRoom: number;
    memoryEntriesPerUser: number;
    globalMemoryEntries: number;
    userMemoryIdleMs: number;
    memoryConsolidationKeepContextMessages: number;
    attachmentTtlHours: number;
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
    | 'remember_user'
    | 'remember_global'
    | 'show_user_memory'
    | 'show_global_memory'
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
  prompt?: string;
  memoryText?: string;
  automationText?: string;
}

export interface TaskRecord {
  id: string;
  roomId: string;
  userId: string;
  requestType: RequestKind;
  status: TaskStatus;
  prompt: string;
  resultKind?: ResultKind;
  resultText?: string;
  resultPath?: string;
  error?: string;
  toolName?: string;
  toolInputJson?: string;
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
  requestType: RequestKind;
  scheduleType: AutomationScheduleType;
  scheduleSpecJson: string;
  timezone: string;
  prompt: string;
  toolName?: string;
  toolInputJson?: string;
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

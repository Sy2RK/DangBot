import type { z } from 'zod';
import type { Logger } from 'pino';
import type {
  AppConfig,
  AttachmentRecord,
  TaskRecord,
  ToolResultKind,
  ToolRiskLevel,
  UserRole
} from '../types.js';
import type { AppDatabase } from '../storage/database.js';
import type { FileService } from '../services/files/fileService.js';
import type { ChatTurn, OpenAICompatibleClient } from '../services/llm/openaiCompatibleClient.js';
import type { WebSearchClient } from '../services/search/braveSearchClient.js';

export interface ToolResult {
  kind: ToolResultKind;
  text?: string;
  filePath?: string;
  imagePath?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolExecutionContext {
  config: AppConfig;
  db: AppDatabase;
  llm: OpenAICompatibleClient;
  fileService: FileService;
  webSearch?: WebSearchClient;
  logger: Logger;
  task: TaskRecord;
  role: UserRole;
  attachments: AttachmentRecord[];
  system: ChatTurn;
  roomContext?: ChatTurn;
  signal: AbortSignal;
  stage(message: string): Promise<void>;
  pickAttachment(kind: AttachmentRecord['kind']): AttachmentRecord | undefined;
}

export interface ToolDefinition<Input = unknown> {
  name: string;
  description: string;
  inputDescription: string;
  inputSchema: z.ZodType<Input>;
  riskLevel: ToolRiskLevel;
  allowedRoles: UserRole[];
  canRunAsSupport?: boolean;
  terminalResult?: boolean;
  timeoutMs?: number;
  capabilities?: {
    network?: boolean;
    fileWrite?: boolean;
  };
  execute(ctx: ToolExecutionContext, input: Input): Promise<ToolResult>;
}

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();

  register(definition: ToolDefinition): void {
    if (this.definitions.has(definition.name)) {
      throw new Error(`工具重复注册：${definition.name}`);
    }
    this.definitions.set(definition.name, definition);
  }

  get(name: string): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.definitions.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  parseInput(definition: ToolDefinition, input: unknown): unknown {
    return definition.inputSchema.parse(input);
  }
}

export function stringifyToolInput(input: unknown): string {
  return JSON.stringify(input ?? {});
}

export function parseToolInput(inputJson?: string): unknown {
  if (!inputJson) return {};
  try {
    return JSON.parse(inputJson) as unknown;
  } catch {
    return {};
  }
}

export function previewToolResult(result: ToolResult, maxChars: number): string {
  const preview =
    result.summary ??
    result.text ??
    result.filePath ??
    result.imagePath ??
    JSON.stringify(result.metadata ?? {});
  return preview.length > maxChars ? `${preview.slice(0, maxChars)}...` : preview;
}

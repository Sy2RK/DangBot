import type { Logger } from 'pino';
import type { AppConfig, MemoryRecord } from '../types.js';
import type { OpenAICompatibleClient } from '../services/llm/openaiCompatibleClient.js';
import type { AppDatabase } from '../storage/database.js';

const autoUserMemorySource = 'auto_user_summary';
const autoGlobalMemorySource = 'auto_global_summary';
const idleSweepIntervalMs = 5 * 60 * 1000;

export class MemoryConsolidationService {
  private readonly runningUserJobs = new Set<string>();
  private globalJobRunning = false;
  private idleSweepTimer?: NodeJS.Timeout;
  private globalTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly llm: OpenAICompatibleClient,
    private readonly logger: Logger
  ) {}

  start(): void {
    this.idleSweepTimer = setInterval(() => {
      void this.consolidateIdleUserMemories().catch((error) => {
        this.logger.error({ error }, 'idle user memory consolidation failed');
      });
    }, idleSweepIntervalMs);

    this.scheduleNextGlobalRun();
  }

  stop(): void {
    if (this.idleSweepTimer) clearInterval(this.idleSweepTimer);
    if (this.globalTimer) clearTimeout(this.globalTimer);
  }

  triggerUserLimitCheck(roomId: string, userId: string): void {
    const count = this.db.getContextCount({ scope: 'user', roomId, userId });
    if (count < this.config.limits.contextMessagesPerUser) return;
    void this.consolidateUserMemory(roomId, userId, 'context_limit').catch((error) => {
      this.logger.error({ error, roomId, userId }, 'user memory limit consolidation failed');
    });
  }

  async consolidateIdleUserMemories(now = new Date()): Promise<void> {
    const threshold = now.getTime() - this.config.limits.userMemoryIdleMs;
    for (const stats of this.db.listUserContextStats()) {
      if (new Date(stats.lastCreatedAt).getTime() > threshold) continue;
      if (!this.hasUnconsolidatedContext(stats.roomId, stats.userId, stats.lastCreatedAt)) continue;
      await this.consolidateUserMemory(stats.roomId, stats.userId, 'idle_timeout');
    }
  }

  async consolidateGlobalMemory(reason = 'daily_midnight_beijing'): Promise<void> {
    if (this.globalJobRunning || !this.llm.configured()) return;
    this.globalJobRunning = true;

    try {
      const roomSections = this.db
        .listAuthorizedRooms()
        .filter((room) => room.enabled)
        .map((room) => {
          const context = this.db.getContext({
            scope: 'room',
            roomId: room.id,
            limit: this.config.limits.publicContextMessagesPerRoom
          });
          if (context.length === 0) return '';
          return [`# ${room.topic ?? room.id}`, ...context.map((turn) => turn.content)].join('\n');
        })
        .filter(Boolean);

      if (roomSections.length === 0) return;

      const existing = this.db.listMemories({
        scope: 'global',
        roomId: '*',
        limit: this.config.limits.globalMemoryEntries
      });

      const content = await this.llm.chat([
        {
          role: 'system',
          content:
            '你是长期记忆整理器。请把微信群公共上下文沉淀成全局持久记忆，只保留对所有用户长期有用的事实、偏好、群规则和稳定背景。不要记录敏感隐私、一次性闲聊、短期任务细节或未经确认的信息。输出中文，最多 10 条 bullet；没有可更新内容时输出“无需更新”。'
        },
        {
          role: 'user',
          content: [
            `触发原因：${reason}`,
            `现有全局记忆：\n${formatExistingMemories(existing)}`,
            `群聊上下文：\n${roomSections.join('\n\n')}`
          ].join('\n\n')
        }
      ]);

      const normalized = normalizeGeneratedMemory(content);
      if (!normalized) return;

      const memory = this.db.upsertMemory({
        scope: 'global',
        roomId: '*',
        source: autoGlobalMemorySource,
        content: normalized
      });
      this.db.addAudit({ action: 'global_memory_auto_consolidated', details: { memoryId: memory.id, reason } });
    } finally {
      this.globalJobRunning = false;
    }
  }

  private async consolidateUserMemory(roomId: string, userId: string, reason: string): Promise<void> {
    const key = `${roomId}:${userId}`;
    if (this.runningUserJobs.has(key) || !this.llm.configured()) return;
    this.runningUserJobs.add(key);

    try {
      const context = this.db.getContext({
        scope: 'user',
        roomId,
        userId,
        limit: this.config.limits.contextMessagesPerUser
      });
      if (context.length === 0) return;

      const existing = this.db.listMemories({
        scope: 'user',
        roomId,
        userId,
        limit: this.config.limits.memoryEntriesPerUser
      });
      const content = await this.llm.chat([
        {
          role: 'system',
          content:
            '你是长期记忆整理器。请把这段用户和助手的短期对话沉淀为该用户的个人持久记忆，只保留长期有用的稳定偏好、事实、称呼习惯、项目背景和明确要求。不要保存敏感隐私、密码密钥、一次性任务细节或不确定推测。输出中文，最多 8 条 bullet；没有可更新内容时输出“无需更新”。'
        },
        {
          role: 'user',
          content: [
            `触发原因：${reason}`,
            `现有个人记忆：\n${formatExistingMemories(existing)}`,
            `短期对话：\n${context.map((turn) => `${turn.role}: ${turn.content}`).join('\n')}`
          ].join('\n\n')
        }
      ]);

      const normalized = normalizeGeneratedMemory(content);
      if (normalized) {
        const memory = this.db.upsertMemory({
          scope: 'user',
          roomId,
          userId,
          source: autoUserMemorySource,
          content: normalized
        });
        this.db.addAudit({
          roomId,
          userId,
          action: 'user_memory_auto_consolidated',
          details: { memoryId: memory.id, reason }
        });
      }

      const removed = this.db.trimContext({
        scope: 'user',
        roomId,
        userId,
        keep: this.config.limits.memoryConsolidationKeepContextMessages
      });
      if (removed > 0) {
        this.db.addAudit({ roomId, userId, action: 'user_context_auto_trimmed', details: { removed, reason } });
      }
    } finally {
      this.runningUserJobs.delete(key);
    }
  }

  private hasUnconsolidatedContext(roomId: string, userId: string, lastCreatedAt: string): boolean {
    const autoMemory = this.db.getMemoryBySource({
      scope: 'user',
      roomId,
      userId,
      source: autoUserMemorySource
    });
    return !autoMemory || new Date(autoMemory.updatedAt).getTime() < new Date(lastCreatedAt).getTime();
  }

  private scheduleNextGlobalRun(): void {
    const delay = nextBeijingMidnightDelayMs();
    this.globalTimer = setTimeout(() => {
      void this.consolidateGlobalMemory().catch((error) => {
        this.logger.error({ error }, 'global memory consolidation failed');
      });
      this.scheduleNextGlobalRun();
    }, delay);
  }
}

function formatExistingMemories(memories: MemoryRecord[]): string {
  if (memories.length === 0) return '无';
  return memories.map((memory) => `- ${memory.content}`).join('\n');
}

function normalizeGeneratedMemory(content: string): string {
  const normalized = content.trim();
  if (!normalized || /^(无需更新|无|none|n\/a)$/i.test(normalized)) return '';
  return normalized.length > 3000 ? `${normalized.slice(0, 3000)}...` : normalized;
}

export function nextBeijingMidnightDelayMs(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);
  const nextMidnightUtcMs = Date.UTC(year, month - 1, day + 1, -8, 0, 0);
  return Math.max(1_000, nextMidnightUtcMs - now.getTime());
}

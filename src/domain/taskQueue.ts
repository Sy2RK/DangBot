import type { Logger } from 'pino';
import type { AppDatabase } from '../storage/database.js';
import type { TaskRecord } from '../types.js';
import { safeErrorSummary } from '../utils/redaction.js';

interface QueueItem {
  task: TaskRecord;
  longRunning: boolean;
  timeoutMs?: number;
  handler: (signal: AbortSignal) => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class TaskQueue {
  private readonly queue: QueueItem[] = [];
  private readonly runningTasks = new Map<string, AbortController>();
  private running = 0;
  private longRunning = 0;

  constructor(
    private readonly db: AppDatabase,
    private readonly logger: Logger,
    private readonly options: {
      maxConcurrentTasks: number;
      maxConcurrentLongTasks: number;
      taskTimeoutMs: number;
    }
  ) {}

  enqueue(
    task: TaskRecord,
    handler: (signal: AbortSignal) => Promise<void>,
    longRunning = false,
    timeoutMs?: number
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ task, handler, longRunning, timeoutMs, resolve, reject });
      this.drain();
    });
  }

  cancel(taskId: string): boolean {
    const queuedIndex = this.queue.findIndex((item) => item.task.id === taskId);
    if (queuedIndex >= 0) {
      const [item] = this.queue.splice(queuedIndex, 1);
      item?.reject(new Error('任务已取消。'));
      return true;
    }

    const running = this.runningTasks.get(taskId);
    if (!running) return false;
    running.abort();
    return true;
  }

  pendingCount(): number {
    return this.queue.length;
  }

  runningCount(): number {
    return this.running;
  }

  private drain(): void {
    while (this.canStartNext()) {
      const index = this.queue.findIndex((item) => !item.longRunning || this.longRunning < this.options.maxConcurrentLongTasks);
      if (index < 0) return;
      const [item] = this.queue.splice(index, 1);
      if (!item) return;
      void this.runItem(item);
    }
  }

  private canStartNext(): boolean {
    return this.running < this.options.maxConcurrentTasks && this.queue.length > 0;
  }

  private async runItem(item: QueueItem): Promise<void> {
    this.running += 1;
    if (item.longRunning) this.longRunning += 1;

    const abort = new AbortController();
    this.runningTasks.set(item.task.id, abort);
    const timeout = setTimeout(() => abort.abort(), item.timeoutMs ?? this.options.taskTimeoutMs);

    try {
      const current = this.db.getTask(item.task.id);
      if (!current || current.status === 'cancelled') {
        item.resolve();
        return;
      }

      this.db.updateTask(item.task.id, { status: 'processing' });
      await item.handler(abort.signal);

      const after = this.db.getTask(item.task.id);
      if (after?.status === 'processing') {
        this.db.updateTask(item.task.id, { status: 'completed' });
      }
      item.resolve();
    } catch (error) {
      const message = safeErrorSummary(error, 1_000);
      const current = this.db.getTask(item.task.id);
      if (current?.status === 'cancelled') {
        item.resolve();
        return;
      }
      this.logger.error({ error: message, taskId: item.task.id }, 'task failed');
      this.db.updateTask(item.task.id, { status: 'failed', error: message });
      item.reject(error);
    } finally {
      clearTimeout(timeout);
      this.runningTasks.delete(item.task.id);
      this.running -= 1;
      if (item.longRunning) this.longRunning -= 1;
      this.drain();
    }
  }
}

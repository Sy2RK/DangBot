import type { Logger } from 'pino';
import type { AppDatabase } from '../storage/database.js';
import type { TaskRecord } from '../types.js';

interface QueueItem {
  task: TaskRecord;
  longRunning: boolean;
  handler: (signal: AbortSignal) => Promise<void>;
}

export class TaskQueue {
  private readonly queue: QueueItem[] = [];
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

  enqueue(task: TaskRecord, handler: (signal: AbortSignal) => Promise<void>, longRunning = false): void {
    this.queue.push({ task, handler, longRunning });
    this.drain();
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
    const timeout = setTimeout(() => abort.abort(), this.options.taskTimeoutMs);

    try {
      const current = this.db.getTask(item.task.id);
      if (!current || current.status === 'cancelled') return;

      this.db.updateTask(item.task.id, { status: 'processing' });
      await item.handler(abort.signal);

      const after = this.db.getTask(item.task.id);
      if (after?.status === 'processing') {
        this.db.updateTask(item.task.id, { status: 'completed' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ error, taskId: item.task.id }, 'task failed');
      this.db.updateTask(item.task.id, { status: 'failed', error: message });
    } finally {
      clearTimeout(timeout);
      this.running -= 1;
      if (item.longRunning) this.longRunning -= 1;
      this.drain();
    }
  }
}

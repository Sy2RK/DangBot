import type { Logger } from 'pino';
import type { AppConfig, TaskRecord } from '../types.js';
import type { AppDatabase } from '../storage/database.js';
import type { TaskQueue } from './taskQueue.js';
import type { HermesTaskExecutor } from '../services/hermes/hermesTaskExecutor.js';
import { safeErrorSummary } from '../utils/redaction.js';

export class ReflectionScheduler {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly queue: TaskQueue,
    private readonly hermes: HermesTaskExecutor,
    private readonly logger: Logger
  ) {}

  start(): void {
    if (!this.config.reflection.enabled || this.timer) return;
    this.timer = setInterval(() => void this.runDueOnce(), 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runDueOnce(now = new Date()): Promise<void> {
    if (!this.config.reflection.enabled || this.running) return;
    this.running = true;
    try {
      for (const group of this.db.listReflectionCandidateGroups()) {
        const latest = this.db.latestReflectionAt(group.roomId, group.userId);
        if (latest && now.getTime() - new Date(latest).getTime() < this.config.reflection.minSessionIntervalMs) continue;
        const idle = now.getTime() - new Date(group.oldestAt).getTime() >= this.config.reflection.idleMs;
        const threshold = group.count >= this.config.reflection.candidateThreshold;
        if (!idle && !threshold) continue;
        const batch = this.db.createReflectionBatch({
          roomId: group.roomId,
          userId: group.userId,
          trigger: threshold ? 'threshold' : 'idle',
          maxTasks: this.config.reflection.maxTasksPerBatch
        });
        if (!batch) continue;
        const sourceTasks = batch.taskIds
          .map((id) => this.db.getTask(id))
          .filter((task): task is TaskRecord => Boolean(task));
        const task = this.db.createTask({
          roomId: group.roomId,
          userId: group.userId,
          origin: 'reflection',
          prompt: buildReflectionPrompt(sourceTasks, batch.evidence)
        });
        this.db.updateReflectionBatch(batch.id, { status: 'running' });
        await this.queue.enqueue(
          task,
          async (signal) => {
            try {
              await this.hermes.execute(task, [], signal, { stage: async () => undefined });
              const run = this.db.getHermesRunByTask(task.id);
              this.db.updateReflectionBatch(batch.id, {
                status: 'completed',
                hermesRunId: run?.runId,
                result: 'reviewed'
              });
            } catch (error) {
              this.db.updateReflectionBatch(batch.id, {
                status: 'failed',
                result: safeErrorSummary(error, 500) || 'reflection_failed'
              });
              throw error;
            }
          },
          false,
          this.config.agent.hermes.requestTimeoutMs + 30_000
        );
      }
    } catch (error) {
      this.logger.error({ error: safeErrorSummary(error) }, 'reflection batch failed');
    } finally {
      this.running = false;
    }
  }
}

function buildReflectionPrompt(
  tasks: TaskRecord[],
  candidates: Array<{ taskId: string; signal: string; evidence: string }>
): string {
  const evidence = tasks.map((task, index) => [
    `记录 ${index + 1} taskId=${task.id}`,
    `用户原话：${task.prompt.slice(0, 4_000)}`,
    task.resultText ? `当时最终回答：${task.resultText.slice(0, 2_000)}` : ''
  ].filter(Boolean).join('\n')).join('\n\n');
  const signals = candidates
    .map(
      (candidate, index) =>
        `候选 ${index + 1} taskId=${candidate.taskId} signal=${candidate.signal}\n证据：${candidate.evidence.slice(0, 4_000)}`
    )
    .join('\n\n');
  return [
    '这是 DangBot 的隔离反思批次。只复核下面的当前群、当前用户证据。',
    '你只能调用 dangbot_memory_recall、dangbot_memory_propose、dangbot_memory_feedback。',
    '个人记忆：只有稳定、非敏感、非临时、无冲突的事实或偏好才可提案；confidence>=0.95 时 evidence 必须逐字取自“用户原话”，每批最多一条个人提案。',
    '群记忆与跨群 Agent 经验只能提案，永远不能自行批准。Agent 经验必须是短小、可撤销的工具行为或失败恢复提示，不能要求修改技能、代码、配置或宿主文件。',
    '没有值得长期保留的内容时，不要为了凑数提案。不要生成任何面向微信群的回答。',
    signals || '本批没有有效候选证据。',
    evidence || '本批没有可关联任务。'
  ].join('\n\n');
}

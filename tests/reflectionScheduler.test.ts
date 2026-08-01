import { describe, expect, it, vi } from 'vitest';
import { ReflectionScheduler } from '../src/domain/reflectionScheduler.js';
import { TaskQueue } from '../src/domain/taskQueue.js';
import type { HermesTaskExecutor } from '../src/services/hermes/hermesTaskExecutor.js';
import { AppDatabase } from '../src/storage/database.js';
import { makeTestConfig, silentLogger } from './helpers.js';

describe('ReflectionScheduler failure recovery', () => {
  it('releases consumed candidates after a transient Hermes failure and retries them', async () => {
    const config = await makeTestConfig({
      reflection: { candidateThreshold: 1, minSessionIntervalMs: 1 }
    });
    const db = AppDatabase.memory();
    db.seedConfig(config);
    const source = db.createTask({
      roomId: 'room1', userId: 'u1', origin: 'interactive', status: 'completed', prompt: '请回答简短'
    });
    db.addReflectionCandidate({
      roomId: 'room1', userId: 'u1', taskId: source.id,
      signal: 'user_correction', evidence: '用户明确要求简短回答。'
    });
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error('temporary Hermes outage'))
      .mockResolvedValueOnce({ text: '' });
    const hermes = { execute } as unknown as HermesTaskExecutor;
    const queue = new TaskQueue(db, silentLogger(), {
      maxConcurrentTasks: 2, maxConcurrentLongTasks: 1, taskTimeoutMs: 5_000
    });
    const scheduler = new ReflectionScheduler(config, db, queue, hermes, silentLogger());

    await scheduler.runDueOnce(new Date('2026-08-01T00:00:00.000Z'));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(db.listReflectionCandidateGroups()).toMatchObject([
      { roomId: 'room1', userId: 'u1', count: 1 }
    ]);

    await scheduler.runDueOnce(new Date('2026-08-01T00:00:01.000Z'));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(db.listReflectionCandidateGroups()).toEqual([]);
    db.close();
  });
});

import { describe, expect, it } from 'vitest';
import { TaskQueue } from '../src/domain/taskQueue.js';
import { AppDatabase } from '../src/storage/database.js';
import { makeTestConfig, silentLogger } from './helpers.js';

describe('TaskQueue completion', () => {
  it('resolves only after the queued task completes', async () => {
    const config = await makeTestConfig();
    const db = AppDatabase.memory();
    db.seedConfig(config);
    const task = db.createTask({
      roomId: 'room1',
      userId: 'user1',
      requestType: 'qa',
      prompt: 'test',
      status: 'received'
    });
    const queue = new TaskQueue(db, silentLogger(), {
      maxConcurrentTasks: 1,
      maxConcurrentLongTasks: 1,
      taskTimeoutMs: 1000
    });

    await queue.enqueue(task, async () => undefined);

    expect(db.getTask(task.id)?.status).toBe('completed');
  });

  it('rejects when the queued task fails', async () => {
    const config = await makeTestConfig();
    const db = AppDatabase.memory();
    db.seedConfig(config);
    const task = db.createTask({
      roomId: 'room1',
      userId: 'user1',
      requestType: 'qa',
      prompt: 'test',
      status: 'received'
    });
    const queue = new TaskQueue(db, silentLogger(), {
      maxConcurrentTasks: 1,
      maxConcurrentLongTasks: 1,
      taskTimeoutMs: 1000
    });

    await expect(
      queue.enqueue(task, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(db.getTask(task.id)).toMatchObject({ status: 'failed', error: 'boom' });
  });
});

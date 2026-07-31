import { describe, expect, it, vi } from 'vitest';
import { BotRequestRouter } from '../src/core/router.js';
import { TaskQueue } from '../src/domain/taskQueue.js';
import { FileService } from '../src/services/files/fileService.js';
import type { HermesTaskExecutor } from '../src/services/hermes/hermesTaskExecutor.js';
import type { OpenAICompatibleClient } from '../src/services/llm/openaiCompatibleClient.js';
import { AppDatabase } from '../src/storage/database.js';
import type { IncomingMessage } from '../src/types.js';
import { makeTestConfig, MemoryResponder, silentLogger } from './helpers.js';

describe('BotRequestRouter Hermes mode', () => {
  it('bypasses the legacy classifier and agent loop for normal tasks', async () => {
    const config = await makeTestConfig({
      agent: {
        backend: 'hermes',
        hermes: { apiKey: 'test-api-key-long-enough' }
      },
      auth: {
        rooms: [{ id: 'room1', topic: '测试群', enabled: true, admins: ['admin'] }]
      }
    });
    const db = AppDatabase.memory();
    db.seedConfig(config);
    const logger = silentLogger();
    const queue = new TaskQueue(db, logger, {
      maxConcurrentTasks: 2,
      maxConcurrentLongTasks: 1,
      taskTimeoutMs: 5_000
    });
    const chat = vi.fn(async () => {
      throw new Error('legacy LLM loop must not run');
    });
    const llm = {
      configured: () => true,
      speechConfigured: () => false,
      chat
    } as unknown as OpenAICompatibleClient;
    const execute = vi.fn(async () => ({ text: 'Hermes answer' }));
    const hermes = {
      configured: () => true,
      health: async () => ({ status: 'ok' }),
      execute,
      approveTask: async () => false,
      stopTask: async () => undefined
    } as unknown as HermesTaskExecutor;
    const router = new BotRequestRouter(
      config,
      db,
      queue,
      llm,
      new FileService(config),
      logger,
      'test system prompt',
      undefined,
      undefined,
      hermes
    );
    const responder = new MemoryResponder();

    await router.handleMessage(message(), responder);
    await vi.waitFor(() => expect(responder.texts).toContain('Hermes answer'));

    expect(execute).toHaveBeenCalledOnce();
    expect(chat).not.toHaveBeenCalled();
    expect(db.listRoomTasks('room1', 1)[0]).toMatchObject({
      requestType: 'qa',
      status: 'completed',
      resultText: 'Hermes answer'
    });
    db.close();
  });
});

function message(): IncomingMessage {
  return {
    id: 'message-hermes',
    roomId: 'room1',
    roomTopic: '测试群',
    senderId: 'user1',
    senderName: 'User One',
    text: '@DangBot 解释一下 Hermes',
    mentionText: '解释一下 Hermes',
    mentioned: true,
    timestamp: new Date(),
    attachments: []
  };
}

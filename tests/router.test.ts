import { describe, expect, it, vi } from 'vitest';
import { BotRequestRouter } from '../src/core/router.js';
import { TaskQueue } from '../src/domain/taskQueue.js';
import { FileService } from '../src/services/files/fileService.js';
import type { OpenAICompatibleClient } from '../src/services/llm/openaiCompatibleClient.js';
import { AppDatabase } from '../src/storage/database.js';
import type { IncomingMessage } from '../src/types.js';
import { makeTestConfig, MemoryResponder, silentLogger } from './helpers.js';

describe('BotRequestRouter', () => {
  it('does not reply to normal chat, then allows admin to enable room', async () => {
    const { router } = await setup();
    const responder = new MemoryResponder();

    await router.handleMessage(message({ mentioned: false, text: 'hello' }), responder);
    expect(responder.texts).toEqual([]);

    await router.handleMessage(
      message({ senderId: 'admin', senderName: 'Admin', mentioned: true, mentionText: '启用' }),
      responder
    );
    expect(responder.texts.at(-1)).toContain('已启用');
  });

  it('runs a normal mentioned request after the room is enabled', async () => {
    const { router, db } = await setup({ enabled: true });
    const responder = new MemoryResponder();

    await router.handleMessage(message({ mentioned: true, mentionText: '解释 TypeScript strict mode' }), responder);

    await vi.waitFor(() => expect(responder.texts).toContain('mock answer'));
    expect(responder.texts.join('\n')).not.toContain('task_');
    expect(responder.texts.join('\n')).not.toContain('任务');
    expect(db.getContext({ scope: 'user', roomId: 'room1', userId: 'user1', limit: 10 }).length).toBe(2);
  });

  it('creates approval task for high risk prompts', async () => {
    const { router, db } = await setup({ enabled: true });
    const responder = new MemoryResponder();

    await router.handleMessage(message({ mentioned: true, mentionText: '批量发送这段内容到所有群' }), responder);

    expect(responder.texts.at(-1)).toContain('需要管理员审批');
    expect(db.listRoomTasks('room1', 1)[0]?.status).toBe('waiting_approval');
  });

  it('does not require approval in adminless mode', async () => {
    const { router, db } = await setup({ enabled: true, adminless: true });
    const responder = new MemoryResponder();

    await router.handleMessage(message({ mentioned: true, mentionText: '批量发送这段内容到所有群' }), responder);

    await vi.waitFor(() => expect(responder.texts).toContain('mock answer'));
    expect(db.listRoomTasks('room1', 1)[0]?.status).toBe('completed');
  });

  it('stores persistent memories and injects them into later requests', async () => {
    const { router, db, chatCalls } = await setup({ enabled: true, adminless: true });
    const responder = new MemoryResponder();

    await router.handleMessage(message({ mentioned: true, mentionText: '记住 我喜欢短回答' }), responder);
    await router.handleMessage(message({ mentioned: true, mentionText: '全局记住 默认使用中文' }), responder);
    await router.handleMessage(message({ mentioned: true, mentionText: '我的记忆' }), responder);
    await router.handleMessage(message({ mentioned: true, mentionText: '你记得什么？' }), responder);

    await vi.waitFor(() => expect(responder.texts).toContain('mock answer'));
    expect(responder.texts.join('\n')).toContain('我喜欢短回答');
    expect(db.listMemories({ scope: 'user', roomId: 'room1', userId: 'user1', limit: 10 })).toHaveLength(1);
    const latestSystemPrompt = chatCalls.at(-1)?.[0]?.content ?? '';
    expect(latestSystemPrompt).toContain('我喜欢短回答');
    expect(latestSystemPrompt).toContain('默认使用中文');
  });
});

async function setup(options: { enabled?: boolean; adminless?: boolean } = {}) {
  const admins = options.adminless ? [] : ['admin'];
  const config = await makeTestConfig({
    auth: {
      systemAdmins: options.adminless ? [] : ['sys'],
      rooms: [{ id: 'room1', topic: '测试群', enabled: options.enabled ?? false, admins }]
    }
  });
  const db = AppDatabase.memory();
  db.seedConfig(config);
  const logger = silentLogger();
  const queue = new TaskQueue(db, logger, {
    maxConcurrentTasks: 2,
    maxConcurrentLongTasks: 1,
    taskTimeoutMs: 5000
  });
  const chatCalls: Array<Array<{ role: string; content: string }>> = [];
  const llm = {
    configured: () => true,
    chat: async (messages: Array<{ role: string; content: string }>) => {
      chatCalls.push(messages);
      return 'mock answer';
    },
    vision: async () => 'mock vision',
    video: async () => 'mock video',
    generateImage: async () => '/tmp/mock.png'
  } as unknown as OpenAICompatibleClient;
  const fileService = new FileService(config);
  const router = new BotRequestRouter(config, db, queue, llm, fileService, logger);
  return { router, db, chatCalls };
}

function message(overrides: Partial<IncomingMessage>): IncomingMessage {
  return {
    id: `msg_${Math.random()}`,
    roomId: 'room1',
    roomTopic: '测试群',
    senderId: 'user1',
    senderName: 'User One',
    text: overrides.mentionText ?? overrides.text ?? '',
    mentioned: false,
    mentionText: '',
    attachments: [],
    timestamp: new Date(),
    ...overrides
  };
}

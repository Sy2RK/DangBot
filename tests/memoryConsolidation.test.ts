import { describe, expect, it, vi } from 'vitest';
import { MemoryConsolidationService, nextBeijingMidnightDelayMs } from '../src/domain/memoryConsolidation.js';
import { AppDatabase } from '../src/storage/database.js';
import type { OpenAICompatibleClient } from '../src/services/llm/openaiCompatibleClient.js';
import { makeTestConfig, silentLogger } from './helpers.js';

describe('MemoryConsolidationService', () => {
  it('consolidates a full user context into automatic persistent memory', async () => {
    const config = await makeTestConfig({
      limits: {
        contextMessagesPerUser: 4,
        memoryConsolidationKeepContextMessages: 2
      }
    });
    const db = AppDatabase.memory();
    const llm = {
      configured: () => true,
      chat: async () => '- 用户喜欢短回答'
    } as unknown as OpenAICompatibleClient;
    const service = new MemoryConsolidationService(config, db, llm, silentLogger());

    db.appendContext({ scope: 'user', roomId: 'room1', userId: 'u1', role: 'user', content: '我喜欢短回答' });
    db.appendContext({ scope: 'user', roomId: 'room1', userId: 'u1', role: 'assistant', content: '记住啦' });
    db.appendContext({ scope: 'user', roomId: 'room1', userId: 'u1', role: 'user', content: '以后简单点' });
    db.appendContext({ scope: 'user', roomId: 'room1', userId: 'u1', role: 'assistant', content: '好的' });

    service.triggerUserLimitCheck('room1', 'u1');

    await vi.waitFor(() => {
      expect(
        db.getMemoryBySource({
          scope: 'user',
          roomId: 'room1',
          userId: 'u1',
          source: 'auto_user_summary'
        })?.content
      ).toContain('短回答');
    });
    expect(db.getContextCount({ scope: 'user', roomId: 'room1', userId: 'u1' })).toBe(2);
    db.close();
  });

  it('calculates next Beijing midnight', () => {
    const delay = nextBeijingMidnightDelayMs(new Date('2026-05-26T15:00:00.000Z'));
    expect(delay).toBe(60 * 60 * 1000);
  });
});

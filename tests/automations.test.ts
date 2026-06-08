import { describe, expect, it, vi } from 'vitest';
import {
  AutomationScheduler,
  parseAutomationDefinitionFromLlmOutput,
  parseAutomationDefinitionWithLlm,
  serializeScheduleSpec
} from '../src/domain/automations.js';
import type { OpenAICompatibleClient } from '../src/services/llm/openaiCompatibleClient.js';
import { AppDatabase } from '../src/storage/database.js';
import type { AutomationRecord, BotResponder } from '../src/types.js';
import { makeTestConfig, MemoryResponder, silentLogger } from './helpers.js';

describe('automations', () => {
  it('builds one-time, daily, weekly, and interval schedules from LLM JSON', () => {
    const now = new Date('2026-06-05T01:30:00.000Z');
    const timezone = 'Asia/Shanghai';

    const once = parseAutomationDefinitionFromLlmOutput(
      JSON.stringify({
        valid: true,
        kind: 'reminder',
        prompt: '喝水',
        schedule: { type: 'once_relative', amount: 10, unit: 'minute' }
      }),
      { now, timezone }
    );
    expect(once).toMatchObject({
      kind: 'reminder',
      scheduleType: 'once',
      prompt: '喝水'
    });
    expect(once?.nextRunAt).toBe('2026-06-05T01:40:00.000Z');

    const daily = parseAutomationDefinitionFromLlmOutput(
      JSON.stringify({
        valid: true,
        kind: 'scheduled_prompt',
        prompt: '总结群聊',
        schedule: { type: 'daily', time: '09:00' }
      }),
      { now, timezone }
    );
    expect(daily).toMatchObject({
      kind: 'scheduled_prompt',
      scheduleType: 'daily',
      prompt: '总结群聊'
    });
    expect(daily?.nextRunAt).toBe('2026-06-06T01:00:00.000Z');

    const absoluteReminder = parseAutomationDefinitionFromLlmOutput(
      JSON.stringify({
        valid: true,
        kind: 'reminder',
        prompt: '喝水',
        schedule: { type: 'once_absolute', date: '2026-06-06', time: '10:00' }
      }),
      { now, timezone }
    );
    expect(absoluteReminder).toMatchObject({
      kind: 'reminder',
      scheduleType: 'once',
      prompt: '喝水'
    });

    const dailyReminder = parseAutomationDefinitionFromLlmOutput(
      JSON.stringify({
        valid: true,
        kind: 'reminder',
        prompt: '喝水',
        schedule: { type: 'daily', hour: 10, minute: 0 }
      }),
      { now, timezone }
    );
    expect(dailyReminder).toMatchObject({
      kind: 'reminder',
      prompt: '喝水'
    });
    expect(
      parseAutomationDefinitionFromLlmOutput(
        '{"valid":true,"kind":"reminder","prompt":"喝水","schedule":{"type":"daily","time":"99:00"}}',
        { now, timezone }
      )
    ).toBeUndefined();
    expect(
      parseAutomationDefinitionFromLlmOutput(
        '{"valid":true,"kind":"reminder","prompt":"喝水","schedule":{"type":"once_absolute","date":"2026-02-31","time":"09:00"}}',
        { now, timezone }
      )
    ).toBeUndefined();
    expect(
      parseAutomationDefinitionFromLlmOutput(
        '{"valid":true,"kind":"reminder","prompt":"喝水","schedule":{"type":"once_relative","amount":999999999999,"unit":"day"}}',
        { now, timezone }
      )
    ).toBeUndefined();

    const weekly = parseAutomationDefinitionFromLlmOutput(
      JSON.stringify({
        valid: true,
        kind: 'scheduled_prompt',
        prompt: '发周报',
        schedule: { type: 'weekly', weekday: 1, time: '09:30' }
      }),
      { now, timezone }
    );
    expect(weekly).toMatchObject({ scheduleType: 'weekly', prompt: '发周报' });

    const interval = parseAutomationDefinitionFromLlmOutput(
      JSON.stringify({
        valid: true,
        kind: 'scheduled_prompt',
        prompt: '联网搜索 Qwen 最新消息',
        schedule: { type: 'interval', amount: 30, unit: 'minute' }
      }),
      { now, timezone }
    );
    expect(interval).toMatchObject({ scheduleType: 'interval', prompt: '联网搜索 Qwen 最新消息' });
    expect(interval?.nextRunAt).toBe('2026-06-05T02:00:00.000Z');
  });

  it('uses the LLM to parse automation definitions and rejects invalid model output', async () => {
    const calls: Array<{
      messages: Array<{ role: string; content: string }>;
      options?: { temperature?: number };
    }> = [];
    const llm = mockLlm(async (messages, _signal, options) => {
      calls.push({ messages, options });
      return JSON.stringify({
        valid: true,
        kind: 'scheduled_prompt',
        prompt: '总结群聊',
        schedule: { type: 'daily', time: '09:00' }
      });
    });

    const definition = await parseAutomationDefinitionWithLlm('设置定时任务 每天 09:00 总结群聊', {
      now: new Date('2026-06-05T01:30:00.000Z'),
      timezone: 'Asia/Shanghai',
      llm,
      logger: silentLogger()
    });

    expect(definition).toMatchObject({
      kind: 'scheduled_prompt',
      scheduleType: 'daily',
      prompt: '总结群聊'
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages[0]?.content).toContain('自动化定时任务解析器');
    expect(calls[0]?.messages.at(-1)?.content).toContain('用户原文：设置定时任务 每天 09:00 总结群聊');
    expect(calls[0]?.options).toMatchObject({ temperature: 0 });

    const invalid = await parseAutomationDefinitionWithLlm('提醒我 10分钟后 喝水', {
      now: new Date('2026-06-05T01:30:00.000Z'),
      timezone: 'Asia/Shanghai',
      llm: mockLlm(async () => '我猜是提醒，但没有 JSON'),
      logger: silentLogger()
    });
    expect(invalid).toBeUndefined();
  });

  it('treats second day as today before 04:00 local time', async () => {
    const timezone = 'Asia/Shanghai';
    const modelOutput = JSON.stringify({
      valid: true,
      kind: 'reminder',
      prompt: '叫我起床',
      schedule: { type: 'once_absolute', date: '2026-06-07', time: '09:00' }
    });

    const beforeFour = parseAutomationDefinitionFromLlmOutput(modelOutput, {
      now: new Date('2026-06-05T16:30:00.000Z'),
      timezone,
      rawText: '设置定时任务 第二天早上九点叫我起床'
    });
    expect(beforeFour).toMatchObject({
      kind: 'reminder',
      scheduleType: 'once',
      prompt: '叫我起床',
      nextRunAt: '2026-06-06T01:00:00.000Z'
    });

    const afterFour = parseAutomationDefinitionFromLlmOutput(modelOutput, {
      now: new Date('2026-06-05T20:01:00.000Z'),
      timezone,
      rawText: '设置定时任务 第二天早上九点叫我起床'
    });
    expect(afterFour?.nextRunAt).toBe('2026-06-07T01:00:00.000Z');
  });

  it('runs due automations and advances recurring schedules', async () => {
    const config = await makeTestConfig({
      auth: {
        systemAdmins: ['sys'],
        rooms: [{ id: 'room1', topic: '测试群', enabled: true, admins: ['admin'] }]
      },
      automations: {
        maxConsecutiveFailures: 2
      }
    });
    const db = AppDatabase.memory();
    db.seedConfig(config);
    const responder = new MemoryResponder();
    const runner = {
      handleAutomationTrigger: vi.fn(async (_automation: AutomationRecord, _responder: BotResponder) => {})
    };
    const scheduler = new AutomationScheduler(
      config,
      db,
      runner,
      { createRoomResponder: async () => responder },
      silentLogger()
    );
    const automation = db.createAutomation({
      roomId: 'room1',
      creatorId: 'admin',
      name: '测试自动化',
      kind: 'scheduled_prompt',
      requestType: 'qa',
      scheduleType: 'interval',
      scheduleSpecJson: serializeScheduleSpec({
        type: 'interval',
        everyMs: 30 * 60 * 1000,
        label: '每30分钟'
      }),
      timezone: 'Asia/Shanghai',
      prompt: '报个状态',
      nextRunAt: '2026-06-05T01:00:00.000Z'
    });

    await scheduler.runDueOnce(new Date('2026-06-05T01:30:00.000Z'));

    expect(runner.handleAutomationTrigger).toHaveBeenCalledWith(automation, responder);
    expect(db.getAutomation(automation.id)).toMatchObject({
      status: 'active',
      consecutiveFailures: 0,
      nextRunAt: '2026-06-05T02:00:00.000Z'
    });
    db.close();
  });
});

function mockLlm(
  chat: (
    messages: Array<{ role: string; content: string }>,
    signal?: AbortSignal,
    options?: { temperature?: number }
  ) => Promise<string>
): OpenAICompatibleClient {
  return {
    configured: () => true,
    chat
  } as unknown as OpenAICompatibleClient;
}

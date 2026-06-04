import { describe, expect, it, vi } from 'vitest';
import {
  AutomationScheduler,
  parseAutomationDefinition,
  serializeScheduleSpec
} from '../src/domain/automations.js';
import { AppDatabase } from '../src/storage/database.js';
import type { AutomationRecord, BotResponder } from '../src/types.js';
import { makeTestConfig, MemoryResponder, silentLogger } from './helpers.js';

describe('automations', () => {
  it('parses one-time, daily, weekly, and interval schedules', () => {
    const now = new Date('2026-06-05T01:30:00.000Z');
    const timezone = 'Asia/Shanghai';

    const once = parseAutomationDefinition('提醒我 10分钟后 喝水', { now, timezone });
    expect(once).toMatchObject({
      kind: 'reminder',
      scheduleType: 'once',
      prompt: '喝水'
    });
    expect(once?.nextRunAt).toBe('2026-06-05T01:40:00.000Z');

    const daily = parseAutomationDefinition('定时 每天 09:00 总结群聊', { now, timezone });
    expect(daily).toMatchObject({
      kind: 'scheduled_prompt',
      scheduleType: 'daily',
      prompt: '总结群聊'
    });
    expect(daily?.nextRunAt).toBe('2026-06-06T01:00:00.000Z');

    const dailyReminder = parseAutomationDefinition('提醒我每天 10:00 喝水', { now, timezone });
    expect(dailyReminder).toMatchObject({
      kind: 'reminder',
      prompt: '喝水'
    });
    expect(parseAutomationDefinition('提醒我 每天 99:00 喝水', { now, timezone })).toBeUndefined();
    expect(
      parseAutomationDefinition('提醒我 2026-02-31 09:00 喝水', { now, timezone })
    ).toBeUndefined();
    expect(parseAutomationDefinition('提醒我 999999999999天后 喝水', { now, timezone })).toBeUndefined();

    const weekly = parseAutomationDefinition('定时 每周一 09:30 发周报', { now, timezone });
    expect(weekly).toMatchObject({ scheduleType: 'weekly', prompt: '发周报' });

    const interval = parseAutomationDefinition('自动化 每30分钟 联网搜索 Qwen 最新消息', {
      now,
      timezone
    });
    expect(interval).toMatchObject({ scheduleType: 'interval', prompt: '联网搜索 Qwen 最新消息' });
    expect(interval?.nextRunAt).toBe('2026-06-05T02:00:00.000Z');
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

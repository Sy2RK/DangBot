import { describe, expect, it, vi } from 'vitest';
import {
  AutomationScheduler,
  computeNextRunForAutomation,
  serializeScheduleSpec,
  validateScheduleSpec
} from '../src/domain/automations.js';
import { AppDatabase } from '../src/storage/database.js';
import { makeTestConfig, MemoryResponder, silentLogger } from './helpers.js';

describe('Hermes-native automations', () => {
  it('validates the strict schedule produced by Hermes', () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    const daily = validateScheduleSpec('daily', { hour: 9, minute: 30 }, now, 'Asia/Shanghai');
    expect(daily.spec).toMatchObject({ type: 'daily', hour: 9, minute: 30 });
    expect(new Date(daily.nextRunAt).getTime()).toBeGreaterThan(now.getTime());
    expect(() => validateScheduleSpec('weekly', { weekday: 9, hour: 1, minute: 0 }, now)).toThrow();
  });

  it('Node only wakes a due task and sends it back through the Agent runner', async () => {
    const config = await makeTestConfig();
    config.auth.rooms[0]!.enabled = true;
    const db = AppDatabase.memory();
    db.seedConfig(config);
    const dueAt = new Date('2026-08-01T00:00:00.000Z');
    const automation = db.createAutomation({
      roomId: 'room1',
      creatorId: 'admin',
      name: '日报',
      kind: 'scheduled_prompt',
      scheduleType: 'once',
      scheduleSpecJson: serializeScheduleSpec({ type: 'once', at: dueAt.toISOString(), label: '现在' }),
      timezone: 'Asia/Shanghai',
      prompt: '总结今日公开消息',
      nextRunAt: dueAt.toISOString()
    });
    const handleAutomationTrigger = vi.fn(async () => undefined);
    const responder = new MemoryResponder();
    const scheduler = new AutomationScheduler(
      config,
      db,
      { handleAutomationTrigger },
      { createRoomResponder: async () => responder },
      silentLogger()
    );
    await scheduler.runDueOnce(new Date(dueAt.getTime() + 1));
    expect(handleAutomationTrigger).toHaveBeenCalledWith(expect.objectContaining({ id: automation.id }), responder);
    expect(db.getAutomation(automation.id)?.status).toBe('completed');
    db.close();
  });

  it('computes a future interval run without language-model parsing', async () => {
    const config = await makeTestConfig();
    const db = AppDatabase.memory();
    db.seedConfig(config);
    const automation = db.createAutomation({
      roomId: 'room1', creatorId: 'admin', name: '巡检', kind: 'scheduled_prompt',
      scheduleType: 'interval',
      scheduleSpecJson: JSON.stringify({ type: 'interval', everyMs: 60_000, label: '每分钟' }),
      timezone: 'Asia/Shanghai', prompt: '巡检', nextRunAt: new Date().toISOString()
    });
    const from = new Date('2026-08-01T00:00:00.000Z');
    expect(computeNextRunForAutomation(automation, from)).toBe('2026-08-01T00:01:00.000Z');
    db.close();
  });

  it('never replays an Agent run after dispatch may have produced side effects', async () => {
    const config = await makeTestConfig({
      automations: { retryCount: 3, retryDelayMs: 1 }
    });
    config.auth.rooms[0]!.enabled = true;
    const db = AppDatabase.memory();
    db.seedConfig(config);
    const dueAt = new Date('2026-08-01T00:00:00.000Z');
    const automation = db.createAutomation({
      roomId: 'room1', creatorId: 'admin', name: '付费报告', kind: 'scheduled_prompt',
      scheduleType: 'once',
      scheduleSpecJson: serializeScheduleSpec({ type: 'once', at: dueAt.toISOString(), label: '现在' }),
      timezone: 'Asia/Shanghai', prompt: '生成视频报告', nextRunAt: dueAt.toISOString()
    });
    const handleAutomationTrigger = vi.fn(async () => {
      throw new Error('artifact delivery failed after dispatch');
    });
    const scheduler = new AutomationScheduler(
      config,
      db,
      { handleAutomationTrigger },
      { createRoomResponder: async () => new MemoryResponder() },
      silentLogger()
    );
    await scheduler.runDueOnce(new Date(dueAt.getTime() + 1));
    expect(handleAutomationTrigger).toHaveBeenCalledTimes(1);
    expect(db.getAutomation(automation.id)?.status).toBe('failed');
    db.close();
  });
});

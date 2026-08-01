import { describe, expect, it } from 'vitest';
import { canUseCommand } from '../src/domain/permissions.js';
import type { ParsedCommand, RoomState } from '../src/types.js';

const enabledRoom: RoomState = {
  id: 'room1',
  topic: '测试群',
  enabled: true,
  authorized: true,
  admins: ['admin']
};

describe('permissions', () => {
  it('blocks member admin commands', () => {
    const command: ParsedCommand = { type: 'disable_room', rawText: '停用' };
    expect(canUseCommand(command, 'member', enabledRoom)).toBe(false);
    expect(canUseCommand(command, 'group_admin', enabledRoom)).toBe(true);
  });

  it('allows admin commands for members in explicit adminless mode', () => {
    const command: ParsedCommand = {
      type: 'create_automation',
      rawText: '设置定时任务 每天 09:00 总结群聊',
      automationText: '设置定时任务 每天 09:00 总结群聊'
    };
    expect(canUseCommand(command, 'member', { ...enabledRoom, admins: [] }, { adminless: true })).toBe(true);
  });

  it('blocks global memory writes from normal members', () => {
    expect(canUseCommand({ type: 'remember_global', rawText: '全局记住', memoryText: 'x' }, 'member', enabledRoom)).toBe(
      false
    );
    expect(canUseCommand({ type: 'clear_global_memory', rawText: '清空全局记忆' }, 'group_admin', enabledRoom)).toBe(
      true
    );
  });

  it('reserves cross-room Agent lesson management for system administrators', () => {
    const list: ParsedCommand = { type: 'list_agent_lessons', rawText: 'Agent 经验' };
    const revoke: ParsedCommand = {
      type: 'revoke_agent_lesson',
      rawText: '撤销 Agent 经验 lesson_abc12345',
      lessonId: 'lesson_abc12345'
    };
    expect(canUseCommand(list, 'group_admin', enabledRoom)).toBe(false);
    expect(canUseCommand(revoke, 'group_admin', enabledRoom)).toBe(false);
    expect(canUseCommand(list, 'system_admin', enabledRoom)).toBe(true);
    expect(canUseCommand(revoke, 'system_admin', enabledRoom)).toBe(true);
  });

  it('allows status and health for normal members in disabled rooms', () => {
    const disabled = { ...enabledRoom, enabled: false };
    expect(canUseCommand({ type: 'status', rawText: '状态' }, 'member', disabled)).toBe(true);
    expect(canUseCommand({ type: 'health', rawText: '/health' }, 'member', disabled)).toBe(true);
    expect(canUseCommand({ type: 'normal_request', rawText: 'hi', prompt: 'hi' }, 'member', disabled)).toBe(false);
  });
});

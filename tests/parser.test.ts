import { describe, expect, it } from 'vitest';
import { parseCommand, stripBotMention } from '../src/core/parser.js';

describe('parser', () => {
  it('parses admin commands', () => {
    expect(parseCommand('启用').type).toBe('enable_room');
    expect(parseCommand('停用').type).toBe('disable_room');
    expect(parseCommand('状态').type).toBe('status');
    expect(parseCommand('/health').type).toBe('health');
    expect(parseCommand('自检').type).toBe('health');
    expect(parseCommand('同意 task_abc12345')).toMatchObject({
      type: 'approve_task',
      taskId: 'task_abc12345'
    });
  });

  it('parses memory commands', () => {
    expect(parseCommand('记住 我喜欢短回答')).toMatchObject({
      type: 'remember_user',
      memoryText: '我喜欢短回答'
    });
    expect(parseCommand('全局记住 默认用中文')).toMatchObject({
      type: 'remember_global',
      memoryText: '默认用中文'
    });
    expect(parseCommand('我的记忆').type).toBe('show_user_memory');
    expect(parseCommand('全局记忆').type).toBe('show_global_memory');
    expect(parseCommand('记忆提案').type).toBe('list_memory_proposals');
    expect(parseCommand('Agent 经验').type).toBe('list_agent_lessons');
    expect(parseCommand('撤销 Agent 经验 lesson_abc12345')).toMatchObject({
      type: 'revoke_agent_lesson',
      lessonId: 'lesson_abc12345'
    });
    expect(parseCommand('忘记 mem_abc12345')).toMatchObject({
      type: 'delete_user_memory',
      memoryId: 'mem_abc12345'
    });
    expect(parseCommand('清空我的记忆').type).toBe('clear_user_memory');
    expect(parseCommand('清空全局记忆').type).toBe('clear_global_memory');
  });

  it('parses automation commands', () => {
    expect(parseCommand('提醒我 10分钟后 喝水')).toMatchObject({
      type: 'create_automation',
      automationText: '提醒我 10分钟后 喝水'
    });
    expect(parseCommand('设置定时任务 每天 09:00 总结群聊')).toMatchObject({
      type: 'create_automation',
      automationText: '设置定时任务 每天 09:00 总结群聊'
    });
    expect(parseCommand('设置定时任务，每天下午六点提醒我去锻炼')).toMatchObject({
      type: 'create_automation',
      automationText: '设置定时任务，每天下午六点提醒我去锻炼'
    });
    expect(parseCommand('设置提醒 10分钟后 喝水')).toMatchObject({
      type: 'create_automation',
      automationText: '设置提醒 10分钟后 喝水'
    });
    expect(parseCommand('自动化列表').type).toBe('list_automations');
    expect(parseCommand('暂停 auto_abc12345')).toMatchObject({
      type: 'pause_automation',
      automationId: 'auto_abc12345'
    });
    expect(parseCommand('暂停第1个')).toMatchObject({
      type: 'pause_automation',
      automationIndex: 1
    });
    expect(parseCommand('恢复 auto_abc12345')).toMatchObject({
      type: 'resume_automation',
      automationId: 'auto_abc12345'
    });
    expect(parseCommand('恢复第一个')).toMatchObject({
      type: 'resume_automation',
      automationIndex: 1
    });
    expect(parseCommand('删除 auto_abc12345')).toMatchObject({
      type: 'delete_automation',
      automationId: 'auto_abc12345'
    });
    expect(parseCommand('删除第十二条')).toMatchObject({
      type: 'delete_automation',
      automationIndex: 12
    });
  });

  it('strips bot mentions with aliases', () => {
    expect(stripBotMention('@DangBot 总结一下', ['DangBot'])).toEqual({
      mentioned: true,
      text: '总结一下'
    });
  });
});

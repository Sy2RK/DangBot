import { describe, expect, it } from 'vitest';
import { parseCommand, stripBotMention } from '../src/core/parser.js';

describe('parser', () => {
  it('parses admin commands', () => {
    expect(parseCommand('启用').type).toBe('enable_room');
    expect(parseCommand('停用').type).toBe('disable_room');
    expect(parseCommand('状态').type).toBe('status');
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
    expect(parseCommand('清空我的记忆').type).toBe('clear_user_memory');
    expect(parseCommand('清空全局记忆').type).toBe('clear_global_memory');
  });

  it('strips bot mentions with aliases', () => {
    expect(stripBotMention('@DangBot 总结一下', ['DangBot'])).toEqual({
      mentioned: true,
      text: '总结一下'
    });
  });
});

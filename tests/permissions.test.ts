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

  it('allows only status for normal members in disabled rooms', () => {
    const disabled = { ...enabledRoom, enabled: false };
    expect(canUseCommand({ type: 'status', rawText: '状态' }, 'member', disabled)).toBe(true);
    expect(canUseCommand({ type: 'normal_request', rawText: 'hi', prompt: 'hi' }, 'member', disabled)).toBe(false);
  });
});

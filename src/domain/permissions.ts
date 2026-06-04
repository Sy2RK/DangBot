import type { ParsedCommand, RoomState, UserRole } from '../types.js';

const adminCommands = new Set<ParsedCommand['type']>([
  'enable_room',
  'disable_room',
  'clear_room_context',
  'cancel_task',
  'approve_task',
  'reject_task',
  'remember_global',
  'clear_global_memory',
  'create_automation',
  'pause_automation',
  'resume_automation',
  'delete_automation'
]);

export function canUseCommand(command: ParsedCommand, role: UserRole, room?: RoomState): boolean {
  if (role === 'system_admin') return true;

  if (!room?.authorized) return false;

  if (adminCommands.has(command.type)) {
    return role === 'group_admin';
  }

  if (!room.enabled) {
    return command.type === 'status';
  }

  return true;
}

export function roleLabel(role: UserRole): string {
  switch (role) {
    case 'system_admin':
      return '系统管理员';
    case 'group_admin':
      return '群管理员';
    case 'member':
      return '普通成员';
  }
}

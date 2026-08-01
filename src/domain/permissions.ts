import type { ParsedCommand, RoomState, UserRole } from '../types.js';

interface PermissionOptions {
  adminless?: boolean;
}

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

const systemAdminCommands = new Set<ParsedCommand['type']>([
  'list_agent_lessons',
  'revoke_agent_lesson'
]);

export function canUseCommand(
  command: ParsedCommand,
  role: UserRole,
  room?: RoomState,
  options: PermissionOptions = {}
): boolean {
  if (role === 'system_admin') return true;

  if (!room?.authorized) return false;

  if (systemAdminCommands.has(command.type)) return false;

  if (adminCommands.has(command.type)) {
    return role === 'group_admin' || options.adminless === true;
  }

  if (!room.enabled) {
    return command.type === 'status' || command.type === 'health';
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

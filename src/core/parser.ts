import type { ParsedCommand } from '../types.js';

const taskIdPattern = /(task_[a-f0-9-]{8,36})/i;
const automationIdPattern = /(auto_[a-f0-9-]{8,36})/i;
const automationOrdinalPattern = /第\s*([0-9一二三四五六七八九十两]+)\s*(?:个|条|项|只)?/;

export function parseCommand(text: string): ParsedCommand {
  const rawText = text.trim();
  const normalized = rawText.replace(/\s+/g, ' ');
  const lower = normalized.toLowerCase();

  if (/^(启用|开启|enable|start|启动)$/.test(lower)) {
    return { type: 'enable_room', rawText };
  }

  if (/^(停用|关闭|disable|stop)$/.test(lower)) {
    return { type: 'disable_room', rawText };
  }

  if (/^(状态|status|运行状态|任务状态)$/.test(lower)) {
    return { type: 'status', rawText };
  }

  if (/^(\/health|health|自检|健康检查|健康状态)$/.test(lower)) {
    return { type: 'health', rawText };
  }

  if (/^(自动化列表|提醒列表|定时任务列表|查看自动化|查看提醒|automations|reminders)$/i.test(normalized)) {
    return { type: 'list_automations', rawText };
  }

  const automationId = normalized.match(automationIdPattern)?.[1];
  const automationIndex = parseAutomationIndex(normalized);
  if ((automationId || automationIndex) && /^(暂停|停用|pause)/i.test(normalized)) {
    return { type: 'pause_automation', rawText, automationId, automationIndex };
  }
  if ((automationId || automationIndex) && /^(恢复|启用|resume|start)/i.test(normalized)) {
    return { type: 'resume_automation', rawText, automationId, automationIndex };
  }
  if ((automationId || automationIndex) && /^(删除|移除|取消自动化|delete|remove)/i.test(normalized)) {
    return { type: 'delete_automation', rawText, automationId, automationIndex };
  }

  const createAutomation = normalized.match(
    /^(?:(?:创建|新增|设置)(?:一个|个)?自动化|(?:创建|设置)(?:一个|个)?定时任务|自动化|定时任务|定时|(?:创建|设置)(?:一个|个)?提醒|提醒我|提醒|schedule|remind me|remind)[\s:：,，;；、]*(.+)$/i
  );
  if (createAutomation?.[1]?.trim()) {
    return { type: 'create_automation', rawText, automationText: normalized };
  }

  const globalMemory = normalized.match(/^(?:全局|公共|大家)(?:记住|记一下|记忆)[:：]?\s*(.+)$/i);
  if (globalMemory?.[1]?.trim()) {
    return { type: 'remember_global', rawText, memoryText: globalMemory[1].trim() };
  }

  const userMemory = normalized.match(/^(?:记住|帮我记住|记一下|remember)[:：]?\s*(.+)$/i);
  if (userMemory?.[1]?.trim()) {
    return { type: 'remember_user', rawText, memoryText: userMemory[1].trim() };
  }

  if (/^(我的记忆|查看我的记忆|查看记忆|记忆列表|my memory|memories)$/i.test(normalized)) {
    return { type: 'show_user_memory', rawText };
  }

  if (/^(全局记忆|公共记忆|大家的记忆|查看全局记忆|global memory)$/i.test(normalized)) {
    return { type: 'show_global_memory', rawText };
  }

  if (/^(清空我的记忆|清除我的记忆|忘掉我的记忆|clear my memory)$/i.test(normalized)) {
    return { type: 'clear_user_memory', rawText };
  }

  if (/^(清空全局记忆|清除全局记忆|清空公共记忆|clear global memory)$/i.test(normalized)) {
    return { type: 'clear_global_memory', rawText };
  }

  if (/^(清空上下文|清除上下文|重置上下文|reset|clear context)$/.test(lower)) {
    return { type: 'clear_user_context', rawText };
  }

  if (/^(清空群上下文|清除群上下文|清空公共上下文|清理群上下文)$/.test(lower)) {
    return { type: 'clear_room_context', rawText };
  }

  const taskId = normalized.match(taskIdPattern)?.[1];
  if (taskId && /^(取消|cancel)/i.test(normalized)) {
    return { type: 'cancel_task', rawText, taskId };
  }
  if (/^(取消任务|取消|cancel)$/.test(lower)) {
    return { type: 'cancel_task', rawText };
  }

  if (taskId && /^(同意|批准|approve|allow)/i.test(normalized)) {
    return { type: 'approve_task', rawText, taskId };
  }
  if (/^(同意|批准|approve|allow)$/.test(lower)) {
    return { type: 'approve_task', rawText };
  }

  if (taskId && /^(拒绝|驳回|reject|deny)/i.test(normalized)) {
    return { type: 'reject_task', rawText, taskId };
  }
  if (/^(拒绝|驳回|reject|deny)$/.test(lower)) {
    return { type: 'reject_task', rawText };
  }

  return { type: 'normal_request', rawText, prompt: rawText };
}

function parseAutomationIndex(text: string): number | undefined {
  const token = text.match(automationOrdinalPattern)?.[1];
  if (!token) return undefined;
  const numeric = Number(token);
  if (Number.isInteger(numeric) && numeric > 0) return numeric;

  const chinese = parseSmallChineseNumber(token);
  return chinese && chinese > 0 ? chinese : undefined;
}

function parseSmallChineseNumber(token: string): number | undefined {
  const digitMap: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  };
  if (token === '十') return 10;
  if (token.length === 1) return digitMap[token];
  const tenIndex = token.indexOf('十');
  if (tenIndex === -1) return undefined;

  const before = token.slice(0, tenIndex);
  const after = token.slice(tenIndex + 1);
  const tens = before ? digitMap[before] : 1;
  const ones = after ? digitMap[after] : 0;
  if (!tens || ones === undefined) return undefined;
  return tens * 10 + ones;
}

export function stripBotMention(
  text: string,
  aliases: string[]
): { mentioned: boolean; text: string } {
  let output = text;
  let mentioned = false;

  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mentionPattern = new RegExp(`@${escaped}\\s*`, 'gi');
    if (mentionPattern.test(output)) {
      mentioned = true;
      output = output.replace(mentionPattern, '');
    }
  }

  return { mentioned, text: output.trim() };
}

import type { IncomingAttachment, ParsedCommand, RequestKind } from '../types.js';

const taskIdPattern = /(task_[a-f0-9-]{8,36})/i;

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

export function inferRequestKind(prompt: string, attachments: IncomingAttachment[]): RequestKind {
  const text = prompt.toLowerCase();
  const hasImage = attachments.some((attachment) => attachment.kind === 'image');
  const hasVideo = attachments.some((attachment) => attachment.kind === 'video');
  const hasFile = attachments.some((attachment) => attachment.kind === 'file');

  if (/(生成图片|画一张|出图|image generation|generate image)/i.test(text)) return 'image_generation';
  if (hasImage || /(图片|照片|截图|ocr|识别图|看图|分析图|这张图|刚才的图)/i.test(text)) return 'image_analysis';
  if (hasVideo || /(视频|录像|短视频|mp4|mpeg|mov|webm|看视频|分析视频|这个视频|刚才的视频)/i.test(text)) {
    return 'video_analysis';
  }
  if (hasFile || /(文件|文档|表格|pdf|docx|xlsx|csv|附件)/i.test(text)) return 'file_analysis';
  if (/(总结|纪要|归纳|提取待办|最近讨论|群聊内容)/i.test(text)) return 'summary';
  if (/(翻译|translate)/i.test(text)) return 'translate';
  if (/(改写|润色|rewrite|polish)/i.test(text)) return 'rewrite';
  if (/(报告|report)/i.test(text)) return 'report';

  return 'qa';
}

export function referencesAttachment(prompt: string): 'file' | 'image' | 'video' | undefined {
  if (/(图片|照片|截图|ocr|识别图|看图|这张图|刚才的图)/i.test(prompt)) return 'image';
  if (/(视频|录像|短视频|mp4|mpeg|mov|webm|看视频|分析视频|这个视频|刚才的视频)/i.test(prompt)) {
    return 'video';
  }
  if (/(文件|文档|表格|pdf|docx|xlsx|csv|附件|刚才的文件)/i.test(prompt)) return 'file';
  return undefined;
}

export function stripBotMention(text: string, aliases: string[]): { mentioned: boolean; text: string } {
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

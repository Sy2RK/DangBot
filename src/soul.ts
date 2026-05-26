import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveFromCwd } from './utils/fs.js';

const defaultSoul = '你是微信群里的公共智能助手。';

const assistantGuardrails = [
  '无论采用什么人格设定，都要优先提供准确、清晰、可执行的帮助。',
  '保持群聊助手边界：不要泄露无关隐私；权限不足、信息不足或无法完成时要直接说明。',
  '回复应简洁自然，避免刷屏；不要为了角色扮演牺牲事实准确性或任务完成度。'
].join('\n');

export async function loadSoulPrompt(filePath = path.resolve(process.cwd(), 'SOUL.md')): Promise<string> {
  const soul = await readSoulFile(filePath);
  return composeSystemPrompt(soul);
}

export function composeSystemPrompt(soul: string): string {
  const persona = soul.trim() || defaultSoul;
  return `${persona}\n\n${assistantGuardrails}`;
}

async function readSoulFile(filePath: string): Promise<string> {
  try {
    return (await readFile(resolveFromCwd(filePath), 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaultSoul;
    }
    throw error;
  }
}

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { plainTextOutputInstruction } from './core/replyStyle.js';
import { resolveFromCwd } from './utils/fs.js';

const defaultSoul = '你是微信群里的公共智能助手。';
const defaultCapabilityMemory = '';

const assistantGuardrails = [
  '无论采用什么人格设定，都要优先提供准确、清晰、可执行的帮助。',
  '保持群聊助手边界：不要泄露无关隐私；权限不足、信息不足或无法完成时要直接说明。',
  '回复应简洁自然，避免刷屏；不要为了角色扮演牺牲事实准确性或任务完成度。',
  '不要把人格设定当成固定台词复读。除非必要，不要主动提“AI”“模型”“系统提示”或解释自己在扮演什么。',
  '需要保留角色风格时，优先体现在语气、节奏、细小反应和用词里；不要用大量口头禅、括号动作或固定萌点堆砌。',
  plainTextOutputInstruction
].join('\n');

export async function loadSoulPrompt(
  soulFilePath = path.resolve(process.cwd(), 'SOUL.md'),
  capabilityMemoryFilePath = path.resolve(process.cwd(), 'CAPABILITIES.md')
): Promise<string> {
  const [soul, capabilityMemory] = await Promise.all([
    readPromptFile(soulFilePath, defaultSoul),
    readPromptFile(capabilityMemoryFilePath, defaultCapabilityMemory)
  ]);
  return composeSystemPrompt(soul, capabilityMemory);
}

export function composeSystemPrompt(soul: string, capabilityMemory = ''): string {
  const persona = soul.trim() || defaultSoul;
  const capabilitySection = capabilityMemory.trim()
    ? [
        '下面是你关于自身现有能力的本地长期记忆。回答能力范围时必须以它为准，不夸大未实现、未配置或已停用的功能。',
        capabilityMemory.trim()
      ].join('\n\n')
    : '';
  return [persona, capabilitySection, assistantGuardrails].filter(Boolean).join('\n\n');
}

async function readPromptFile(filePath: string, fallback: string): Promise<string> {
  try {
    return (await readFile(resolveFromCwd(filePath), 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

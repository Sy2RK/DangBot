import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeSystemPrompt, loadSoulPrompt } from '../src/soul.js';

describe('soul prompt', () => {
  it('injects capability memory between persona and guardrails', () => {
    const prompt = composeSystemPrompt('你是小当。', '我会认真帮群友处理文件，喵。');

    expect(prompt).toContain('你是小当。');
    expect(prompt).toContain('自身现有能力的本地长期记忆');
    expect(prompt).toContain('我会认真帮群友处理文件，喵。');
    expect(prompt).toContain('不要泄露无关隐私');
    expect(prompt.indexOf('你是小当。')).toBeLessThan(prompt.indexOf('我会认真帮群友处理文件'));
  });

  it('loads soul and capability memory from separate local files', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dangbot-soul-'));
    const soulPath = path.join(dir, 'SOUL.md');
    const capabilityPath = path.join(dir, 'CAPABILITIES.md');
    await writeFile(soulPath, '你是住在群里的小当。', 'utf8');
    await writeFile(capabilityPath, '我会把文字合成为语音文件，喵。', 'utf8');

    const prompt = await loadSoulPrompt(soulPath, capabilityPath);

    expect(prompt).toContain('你是住在群里的小当。');
    expect(prompt).toContain('我会把文字合成为语音文件，喵。');
  });

  it('keeps working when the optional capability memory file is absent', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dangbot-soul-'));
    const soulPath = path.join(dir, 'SOUL.md');
    await writeFile(soulPath, '你是小当。', 'utf8');

    const prompt = await loadSoulPrompt(soulPath, path.join(dir, 'missing.md'));

    expect(prompt).toContain('你是小当。');
    expect(prompt).not.toContain('自身现有能力的本地长期记忆');
  });
});

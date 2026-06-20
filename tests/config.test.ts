import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('preserves primitive puppet option overrides', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dangbot-config-'));
    const configPath = path.join(dir, 'local.yaml');
    await writeFile(
      configPath,
      [
        'wechat:',
        '  puppetOptions:',
        '    head: true',
        '    uos: true',
        '    stealthless: true',
        '    launchOptions:',
        '      executablePath: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      ].join('\n')
    );

    const config = await loadConfig(configPath);
    expect(config.wechat.puppetOptions).toMatchObject({
      head: true,
      uos: true,
      stealthless: true,
      launchOptions: {
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      }
    });
  });

  it('loads independent speech synthesis settings', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dangbot-config-'));
    const configPath = path.join(dir, 'local.yaml');
    await writeFile(
      configPath,
      [
        'llm:',
        '  tts:',
        '    enabled: true',
        '    baseURL: https://openspeech.bytedance.com/api/v3',
        '    apiKey: test-speech-key',
        '    resourceId: seed-tts-2.0',
        '    voice: zh_male_tiancaitongsheng_uranus_bigtts',
        '    speechRate: 15'
      ].join('\n')
    );

    const config = await loadConfig(configPath);
    expect(config.llm.tts).toMatchObject({
      enabled: true,
      baseURL: 'https://openspeech.bytedance.com/api/v3',
      apiKey: 'test-speech-key',
      resourceId: 'seed-tts-2.0',
      voice: 'zh_male_tiancaitongsheng_uranus_bigtts',
      speechRate: 15
    });
  });
});

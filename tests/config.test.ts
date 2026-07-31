import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('defaults new deployments to the dedicated DashScope model routing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dangbot-config-'));
    const config = await loadConfig(path.join(dir, 'missing-local.yaml'));

    expect(config.llm).toMatchObject({
      provider: 'dashscope',
      textModel: 'qwen3.7-flash',
      visionModel: 'qwen3.7-flash',
      imageModel: 'qwen-image-3.0-pro',
      videoModels: {
        textToVideo: 'happyhorse-1.1-t2v',
        imageToVideo: 'happyhorse-1.1-i2v',
        referenceToVideo: 'happyhorse-1.1-r2v',
        videoEdit: 'happyhorse-1.0-video-edit'
      },
      tts: { provider: 'dashscope', model: 'qwen-audio-3.0-tts-flash' }
    });
    expect(config.search).toMatchObject({ enabled: true, provider: 'hermes' });
  });

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

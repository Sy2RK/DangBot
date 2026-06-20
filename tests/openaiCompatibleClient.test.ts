import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  OpenAICompatibleClient,
  parseVideoDurationSeconds
} from '../src/services/llm/openaiCompatibleClient.js';
import { makeTestConfig } from './helpers.js';

describe('OpenAICompatibleClient video generation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses requested video duration from Chinese and English prompts', () => {
    expect(parseVideoDurationSeconds('生成一段5s 720p的视频')).toBe(5);
    expect(parseVideoDurationSeconds('做一个 10 秒短片')).toBe(10);
    expect(parseVideoDurationSeconds('生成五秒视频')).toBe(5);
    expect(parseVideoDurationSeconds('生成十一秒视频')).toBe(11);
    expect(parseVideoDurationSeconds('没有写时长')).toBe(4);
  });

  it('passes the requested duration to the video API body', async () => {
    const config = await makeTestConfig({ llm: { apiKey: 'test-key' } });
    const client = new OpenAICompatibleClient(config.llm, config.storage.outputsDir);
    let submittedBody: Record<string, unknown> | undefined;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target.endsWith('/videos')) {
          submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(
            JSON.stringify({
              id: 'video-job',
              status: 'completed',
              unsigned_urls: ['https://cdn.example.test/video.mp4']
            }),
            { status: 200 }
          );
        }

        if (target === 'https://cdn.example.test/video.mp4') {
          return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        }

        throw new Error(`unexpected fetch URL: ${target}`);
      })
    );

    await client.generateVideo('调用 seedance2.0 生成一段5s 720p的视频');

    expect(submittedBody).toMatchObject({
      model: config.llm.videoModel,
      duration: 5,
      resolution: '720p'
    });
  });

  it('writes Doubao speech chunks as an MP3 file', async () => {
    const config = await makeTestConfig({
      llm: {
        tts: {
          enabled: true,
          apiKey: 'speech-key',
          resourceId: 'seed-tts-2.0',
          voice: 'zh_male_tiancaitongsheng_uranus_bigtts',
          speechRate: 10
        }
      }
    });
    const client = new OpenAICompatibleClient(config.llm, config.storage.outputsDir);
    let submittedBody: Record<string, unknown> | undefined;
    let apiKey = '';
    let resourceId = '';
    const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe('https://openspeech.bytedance.com/api/v3/tts/unidirectional');
        submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const headers = new Headers(init?.headers);
        apiKey = headers.get('x-api-key') ?? '';
        resourceId = headers.get('x-api-resource-id') ?? '';
        return new Response(
          [
            JSON.stringify({
              code: 0,
              message: 'OK',
              data: mp3.toString('base64')
            }),
            JSON.stringify({ code: 20_000_000, message: 'OK' })
          ].join('\n'),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/x-ndjson',
              'X-Tt-Logid': 'test-logid'
            }
          }
        );
      })
    );

    const voice = await client.generateVoice('今天也要开心呀');

    expect(client.speechConfigured()).toBe(true);
    expect(submittedBody).toMatchObject({
      req_params: {
        text: '今天也要开心呀',
        speaker: 'zh_male_tiancaitongsheng_uranus_bigtts',
        audio_params: {
          format: 'mp3',
          sample_rate: 24_000,
          speech_rate: 10
        }
      }
    });
    expect(apiKey).toBe('speech-key');
    expect(resourceId).toBe('seed-tts-2.0');
    expect(voice.filePath.endsWith('.mp3')).toBe(true);
    expect(await readFile(voice.filePath)).toEqual(mp3);
  });

  it('rejects a successful Doubao response that is not MP3 audio', async () => {
    const config = await makeTestConfig({
      llm: {
        tts: {
          enabled: true,
          apiKey: 'speech-key'
        }
      }
    });
    const client = new OpenAICompatibleClient(config.llm, config.storage.outputsDir);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          [
            JSON.stringify({
              code: 0,
              message: 'OK',
              data: Buffer.from('not mp3').toString('base64')
            }),
            JSON.stringify({ code: 20_000_000, message: 'OK' })
          ].join('\n'),
          {
            status: 200,
            headers: { 'X-Tt-Logid': 'invalid-audio-logid' }
          }
        );
      })
    );

    await expect(client.generateVoice('测试')).rejects.toThrow(
      '豆包语音合成返回的内容不是有效 MP3（logid: invalid-audio-logid）'
    );
  });
});

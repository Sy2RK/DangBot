import { afterEach, describe, expect, it, vi } from 'vitest';
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
});

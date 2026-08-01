import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DashScopeMediaClient,
  selectDashScopeVideoRoute
} from '../src/services/llm/dashScopeClient.js';
import { makeTestConfig } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());

describe('DashScopeMediaClient', () => {
  it('strictly selects HappyHorse routes by input type', () => {
    expect(selectDashScopeVideoRoute({})).toBe('text-to-video');
    expect(selectDashScopeVideoRoute({ frameImage: { filePath: 'x', mimeType: 'image/png' } })).toBe('image-to-video');
    expect(selectDashScopeVideoRoute({ referenceImages: [{ filePath: 'a', mimeType: 'image/png' }, { filePath: 'b', mimeType: 'image/png' }] })).toBe('reference-to-video');
    expect(selectDashScopeVideoRoute({ sourceVideo: { filePath: 'v', mimeType: 'video/mp4' } })).toBe('video-edit');
  });

  it('uses qwen3.7-flash only for a dedicated multimodal call', async () => {
    const config = await makeTestConfig({ media: { apiKey: 'dashscope-test-key' } });
    const image = path.join(path.dirname(config.storage.sqlitePath), 'image.png');
    await writeFile(image, Buffer.from('89504e470d0a1a0a', 'hex'));
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'red' } }] }), { status: 200 });
    }));
    const client = new DashScopeMediaClient(config.media, config.storage.outputsDir);
    await expect(client.analyzeImage('颜色？', { filePath: image, mimeType: 'image/png' })).resolves.toBe('red');
    expect(body?.model).toBe('qwen3.7-flash');
  });

  it('routes video understanding through qwen3.7-flash video_url content', async () => {
    const config = await makeTestConfig({ media: { apiKey: 'dashscope-test-key' } });
    const video = path.join(path.dirname(config.storage.sqlitePath), 'video.mp4');
    await writeFile(video, Buffer.from('000000186674797069736f6d', 'hex'));
    let body: Record<string, any> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, any>;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'motion' } }] }), { status: 200 });
    }));
    const client = new DashScopeMediaClient(config.media, config.storage.outputsDir);
    await expect(
      client.analyzeVideo('发生了什么？', { filePath: video, mimeType: 'video/mp4' })
    ).resolves.toBe('motion');
    expect(body?.model).toBe('qwen3.7-flash');
    expect(body?.messages?.[0]?.content?.[1]?.type).toBe('video_url');
  });

  it('preserves the supplier 403 detail for unavailable Qwen Image access', async () => {
    const config = await makeTestConfig({ media: { apiKey: 'dashscope-test-key' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'Forbidden', message: 'model access denied' }), { status: 403 })));
    const client = new DashScopeMediaClient(config.media, config.storage.outputsDir);
    await expect(client.generateImage('test')).rejects.toThrow(/HTTP 403.*model access denied/u);
  });

  it('maps every HappyHorse input mode to the official model and media schema', async () => {
    const config = await makeTestConfig({ media: { apiKey: 'dashscope-test-key' } });
    const base = path.dirname(config.storage.sqlitePath);
    const imageA = path.join(base, 'a.png');
    const imageB = path.join(base, 'b.png');
    const sourceVideo = path.join(base, 'source.mp4');
    await writeFile(imageA, Buffer.from('89504e470d0a1a0a', 'hex'));
    await writeFile(imageB, Buffer.from('89504e470d0a1a0a', 'hex'));
    await writeFile(sourceVideo, Buffer.from('000000186674797069736f6d', 'hex'));
    const submissions: Array<{ body: Record<string, any>; headers: Headers }> = [];
    vi.stubGlobal('fetch', vi.fn(async (urlValue: string | URL, init?: RequestInit) => {
      const url = String(urlValue);
      if (url.includes('/uploads?')) {
        return new Response(JSON.stringify({
          data: {
            policy: 'policy', signature: 'signature', upload_dir: 'temporary',
            upload_host: 'https://upload.aliyuncs.com', max_file_size_mb: 100,
            oss_access_key_id: 'access', x_oss_object_acl: 'private',
            x_oss_forbid_overwrite: 'true'
          }
        }), { status: 200 });
      }
      if (url === 'https://upload.aliyuncs.com/') return new Response('', { status: 200 });
      if (url.includes('/video-synthesis')) {
        submissions.push({
          body: JSON.parse(String(init?.body)) as Record<string, any>,
          headers: new Headers(init?.headers)
        });
        return new Response(JSON.stringify({ output: { task_id: `task-${submissions.length}`, task_status: 'PENDING' } }), { status: 200 });
      }
      if (url.includes('/tasks/')) {
        return new Response(JSON.stringify({
          output: {
            task_status: 'SUCCEEDED',
            video_url: `data:video/mp4;base64,${Buffer.from('000000186674797069736f6d', 'hex').toString('base64')}`
          }
        }), { status: 200 });
      }
      throw new Error(`unexpected URL: ${url}`);
    }));
    const client = new DashScopeMediaClient(config.media, config.storage.outputsDir);
    const image = { filePath: imageA, mimeType: 'image/png' };
    await client.generateVideo('text', { mode: 'text-to-video', pollIntervalMs: 1 });
    await client.generateVideo('frame', { mode: 'image-to-video', frameImage: image, pollIntervalMs: 1 });
    await client.generateVideo('refs', {
      mode: 'reference-to-video',
      referenceImages: [image, { filePath: imageB, mimeType: 'image/png' }],
      pollIntervalMs: 1
    });
    await client.generateVideo('edit', {
      mode: 'video-edit',
      sourceVideo: { filePath: sourceVideo, mimeType: 'video/mp4' },
      referenceImages: [image],
      pollIntervalMs: 1
    });

    expect(submissions.map((entry) => entry.body.model)).toEqual([
      'happyhorse-1.1-t2v',
      'happyhorse-1.1-i2v',
      'happyhorse-1.1-r2v',
      'happyhorse-1.0-video-edit'
    ]);
    expect(submissions[0]?.body.input.media).toBeUndefined();
    expect(submissions[1]?.body.input.media.map((entry: any) => entry.type)).toEqual(['first_frame']);
    expect(submissions[2]?.body.input.media.map((entry: any) => entry.type)).toEqual([
      'reference_image', 'reference_image'
    ]);
    expect(submissions[3]?.body.input.media.map((entry: any) => entry.type)).toEqual([
      'video', 'reference_image'
    ]);
    expect(submissions[3]?.headers.get('X-DashScope-OssResourceResolve')).toBe('enable');
  });
});

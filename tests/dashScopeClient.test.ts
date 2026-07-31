import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashScopeClient, selectDashScopeVideoRoute } from '../src/services/llm/dashScopeClient.js';
import { OpenAICompatibleClient } from '../src/services/llm/openaiCompatibleClient.js';
import { makeTestConfig } from './helpers.js';

describe('DashScope media client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('selects the HappyHorse model route from authorized input types', () => {
    const image = { filePath: '/tmp/image.png', mimeType: 'image/png' };
    const video = { filePath: '/tmp/video.mp4', mimeType: 'video/mp4' };

    expect(selectDashScopeVideoRoute({})).toBe('text-to-video');
    expect(selectDashScopeVideoRoute({ referenceImages: [image] })).toBe('image-to-video');
    expect(selectDashScopeVideoRoute({ referenceImages: [image, image] })).toBe(
      'reference-to-video'
    );
    expect(selectDashScopeVideoRoute({ sourceVideo: video, referenceImages: [image] })).toBe(
      'video-edit'
    );
    expect(selectDashScopeVideoRoute({ mode: 'text-to-video', sourceVideo: video })).toBe(
      'text-to-video'
    );
  });

  it('uses Qwen Image 3.0 native format with up to three reference images', async () => {
    const config = await makeTestConfig({
      llm: { provider: 'dashscope', apiKey: 'dashscope-test-key' }
    });
    const imagePath = path.join(config.storage.uploadsDir, 'reference.png');
    await mkdir(config.storage.uploadsDir, { recursive: true });
    await writeFile(imagePath, minimalPng());
    let requestBody: Record<string, unknown> | undefined;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target.endsWith('/services/aigc/multimodal-generation/generation')) {
          requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return jsonResponse({
            output: {
              choices: [
                { message: { content: [{ image: 'https://result.aliyuncs.com/image.png' }] } }
              ]
            }
          });
        }
        if (target === 'https://result.aliyuncs.com/image.png') {
          return new Response(new Uint8Array(minimalPng()), {
            headers: { 'Content-Type': 'image/png' }
          });
        }
        throw new Error(`unexpected fetch URL: ${target}`);
      })
    );

    const client = new DashScopeClient(config.llm, config.storage.outputsDir);
    const output = await client.generateImage('保留主体，改成水彩风格', {
      referenceImages: Array.from({ length: 4 }, () => ({
        filePath: imagePath,
        mimeType: 'image/png'
      }))
    });

    const content = readRequestContent(requestBody);
    expect(requestBody).toMatchObject({ model: 'test-image' });
    expect(content.filter((item) => 'image' in item)).toHaveLength(3);
    expect(content.at(-1)).toEqual({ text: '保留主体，改成水彩风格' });
    expect(output.endsWith('.png')).toBe(true);
  });

  it('uses Qwen Audio TTS and accepts the main DashScope key as a secure fallback', async () => {
    const config = await makeTestConfig({
      llm: {
        provider: 'dashscope',
        apiKey: 'dashscope-main-key',
        tts: {
          enabled: true,
          provider: 'dashscope',
          apiKey: '',
          voice: 'longanhuan_v3.6'
        }
      }
    });
    let authorization = '';
    let requestBody: Record<string, unknown> | undefined;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target.endsWith('/services/audio/tts/SpeechSynthesizer')) {
          authorization = new Headers(init?.headers).get('authorization') ?? '';
          requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return jsonResponse({
            output: { audio: { url: 'http://result.aliyuncs.com/voice.wav' } }
          });
        }
        if (target === 'https://result.aliyuncs.com/voice.wav') {
          return new Response(new Uint8Array(minimalWav()), {
            headers: { 'Content-Type': 'audio/wav' }
          });
        }
        throw new Error(`unexpected fetch URL: ${target}`);
      })
    );

    const client = new OpenAICompatibleClient(config.llm, config.storage.outputsDir);
    const result = await client.generateVoice('小当开始播报啦');

    expect(client.speechConfigured()).toBe(true);
    expect(authorization).toBe('Bearer dashscope-main-key');
    expect(requestBody).toMatchObject({
      model: 'qwen-audio-3.0-tts-flash',
      input: {
        text: '小当开始播报啦',
        voice: 'longanhuan_v3.6',
        format: 'wav',
        sample_rate: 24_000
      }
    });
    expect(result.filePath.endsWith('.wav')).toBe(true);
  });

  it('routes multiple images to HappyHorse reference-to-video and downloads the result', async () => {
    const config = await makeTestConfig({
      llm: { provider: 'dashscope', apiKey: 'dashscope-test-key' }
    });
    const imagePath = path.join(config.storage.uploadsDir, 'reference.png');
    await mkdir(config.storage.uploadsDir, { recursive: true });
    await writeFile(imagePath, minimalPng());
    let submittedBody: Record<string, unknown> | undefined;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target.endsWith('/services/aigc/video-generation/video-synthesis')) {
          submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          expect(new Headers(init?.headers).get('x-dashscope-async')).toBe('enable');
          return jsonResponse({ output: { task_id: 'task-1', task_status: 'PENDING' } });
        }
        if (target.endsWith('/tasks/task-1')) {
          return jsonResponse({
            output: {
              task_id: 'task-1',
              task_status: 'SUCCEEDED',
              video_url: 'https://result.aliyuncs.com/video.mp4'
            }
          });
        }
        if (target === 'https://result.aliyuncs.com/video.mp4') {
          return new Response(new Uint8Array(minimalMp4()), {
            headers: { 'Content-Type': 'video/mp4' }
          });
        }
        throw new Error(`unexpected fetch URL: ${target}`);
      })
    );

    const client = new DashScopeClient(config.llm, config.storage.outputsDir);
    const result = await client.generateVideo('用两张图生成 7 秒横屏视频', {
      referenceImages: [
        { filePath: imagePath, mimeType: 'image/png' },
        { filePath: imagePath, mimeType: 'image/png' }
      ],
      pollIntervalMs: 1
    });

    expect(submittedBody).toMatchObject({
      model: 'happyhorse-1.1-r2v',
      parameters: { resolution: '720P', ratio: '16:9', duration: 7 }
    });
    expect(readVideoMedia(submittedBody)).toHaveLength(2);
    expect(result.endsWith('.mp4')).toBe(true);
  });

  it('uploads a source video under a random OSS key and routes video editing safely', async () => {
    const config = await makeTestConfig({
      llm: { provider: 'dashscope', apiKey: 'dashscope-test-key' }
    });
    await mkdir(config.storage.uploadsDir, { recursive: true });
    const sourcePath = path.join(config.storage.uploadsDir, 'private-source.mp4');
    await writeFile(sourcePath, minimalMp4());
    let uploadedKey = '';
    let submittedBody: Record<string, unknown> | undefined;
    let ossResolveHeader = '';

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target.includes('/uploads?action=getPolicy')) {
          return jsonResponse({
            data: {
              policy: 'policy',
              signature: 'signature',
              upload_dir: 'dashscope-instant/account/task',
              upload_host: 'https://upload.aliyuncs.com',
              max_file_size_mb: 100,
              oss_access_key_id: 'access-key-id',
              x_oss_object_acl: 'private',
              x_oss_forbid_overwrite: 'true'
            }
          });
        }
        if (target === 'https://upload.aliyuncs.com/') {
          uploadedKey = String((init?.body as FormData).get('key'));
          return new Response('', { status: 200 });
        }
        if (target.endsWith('/services/aigc/video-generation/video-synthesis')) {
          submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          ossResolveHeader = new Headers(init?.headers).get('x-dashscope-ossresourceresolve') ?? '';
          return jsonResponse({ output: { task_id: 'edit-task', task_status: 'PENDING' } });
        }
        if (target.endsWith('/tasks/edit-task')) {
          return jsonResponse({
            output: {
              task_id: 'edit-task',
              task_status: 'SUCCEEDED',
              video_url: 'https://result.aliyuncs.com/edited.mp4'
            }
          });
        }
        if (target === 'https://result.aliyuncs.com/edited.mp4') {
          return new Response(new Uint8Array(minimalMp4()), {
            headers: { 'Content-Type': 'video/mp4' }
          });
        }
        throw new Error(`unexpected fetch URL: ${target}`);
      })
    );

    const client = new DashScopeClient(config.llm, config.storage.outputsDir);
    await client.generateVideo('给源视频增加水彩风格', {
      sourceVideo: { filePath: sourcePath, mimeType: 'video/mp4' },
      pollIntervalMs: 1
    });

    expect(uploadedKey).toMatch(/^dashscope-instant\/account\/task\/[0-9a-f-]+\.mp4$/u);
    expect(uploadedKey).not.toContain(sourcePath);
    expect(submittedBody).toMatchObject({ model: 'happyhorse-1.0-video-edit' });
    expect(readVideoMedia(submittedBody)[0]).toEqual({
      type: 'video',
      url: `oss://${uploadedKey}`
    });
    expect(ossResolveHeader).toBe('enable');
  });

  it('attempts to cancel a submitted HappyHorse task when the caller aborts', async () => {
    const config = await makeTestConfig({
      llm: { provider: 'dashscope', apiKey: 'dashscope-test-key' }
    });
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const target = String(url);
        requestedUrls.push(target);
        if (target.endsWith('/services/aigc/video-generation/video-synthesis')) {
          return jsonResponse({ output: { task_id: 'cancel-me', task_status: 'PENDING' } });
        }
        if (target.endsWith('/tasks/cancel-me/cancel')) {
          return jsonResponse({ output: { task_id: 'cancel-me', task_status: 'CANCELED' } });
        }
        throw new Error(`unexpected fetch URL: ${target}`);
      })
    );

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0);
    const client = new DashScopeClient(config.llm, config.storage.outputsDir);
    await expect(
      client.generateVideo('生成五秒测试视频', { pollIntervalMs: 1_000 }, controller.signal)
    ).rejects.toThrow('任务已超时或取消');
    expect(requestedUrls.some((url) => url.endsWith('/tasks/cancel-me/cancel'))).toBe(true);
  });

  it('rejects untrusted provider artifact URLs before downloading', async () => {
    const config = await makeTestConfig({
      llm: { provider: 'dashscope', apiKey: 'dashscope-test-key' }
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          output: {
            choices: [{ message: { content: [{ image: 'http://127.0.0.1/private' }] } }]
          }
        })
      )
    );

    const client = new DashScopeClient(config.llm, config.storage.outputsDir);
    await expect(client.generateImage('测试图片')).rejects.toThrow('不受信任的产物地址');
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function readRequestContent(
  body: Record<string, unknown> | undefined
): Array<Record<string, string>> {
  const input = body?.input as { messages?: Array<{ content?: Array<Record<string, string>> }> };
  return input?.messages?.[0]?.content ?? [];
}

function readVideoMedia(body: Record<string, unknown> | undefined): Array<Record<string, string>> {
  const input = body?.input as { media?: Array<Record<string, string>> };
  return input?.media ?? [];
}

function minimalWav(): Buffer {
  return Buffer.from('524946460400000057415645', 'hex');
}

function minimalPng(): Buffer {
  return Buffer.from('89504e470d0a1a0a', 'hex');
}

function minimalMp4(): Buffer {
  return Buffer.from('000000186674797069736f6d', 'hex');
}

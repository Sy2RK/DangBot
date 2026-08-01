import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../../types.js';
import { ensureDir } from '../../utils/fs.js';

export type DashScopeVideoMode =
  | 'auto'
  | 'text-to-video'
  | 'image-to-video'
  | 'reference-to-video'
  | 'video-edit';

export interface DashScopeMediaInput {
  filePath: string;
  mimeType: string;
}

export interface DashScopeImageOptions {
  referenceImages?: DashScopeMediaInput[];
}

export interface DashScopeVideoOptions {
  mode?: DashScopeVideoMode;
  frameImage?: DashScopeMediaInput;
  referenceImages?: DashScopeMediaInput[];
  sourceVideo?: DashScopeMediaInput;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

interface DashScopeResponse {
  code?: string;
  message?: string;
  output?: {
    choices?: Array<{
      message?: {
        content?: Array<{ image?: string }>;
      };
    }>;
    audio?: {
      url?: string;
      data?: string;
    };
    task_id?: string;
    task_status?: string;
    video_url?: string;
    code?: string;
    message?: string;
  };
}

interface DashScopeMultimodalResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

interface UploadPolicyResponse extends DashScopeResponse {
  data?: {
    policy?: string;
    signature?: string;
    upload_dir?: string;
    upload_host?: string;
    max_file_size_mb?: number | string;
    oss_access_key_id?: string;
    x_oss_object_acl?: string;
    x_oss_forbid_overwrite?: string;
  };
}

const imageDownloadLimit = 25 * 1024 * 1024;
const audioDownloadLimit = 25 * 1024 * 1024;
const videoDownloadLimit = 100 * 1024 * 1024;

export class DashScopeMediaClient {
  constructor(
    private readonly config: AppConfig['media'],
    private readonly outputsDir: string
  ) {}

  configured(): boolean {
    return this.config.apiKey.trim().length > 0;
  }

  speechConfigured(): boolean {
    return this.config.tts.enabled && Boolean(this.speechApiKey());
  }

  async analyzeImage(
    prompt: string,
    media: DashScopeMediaInput,
    signal?: AbortSignal
  ): Promise<string> {
    return this.analyzeMultimodal(prompt, media, 'image_url', signal);
  }

  async analyzeVideo(
    prompt: string,
    media: DashScopeMediaInput,
    signal?: AbortSignal
  ): Promise<string> {
    return this.analyzeMultimodal(prompt, media, 'video_url', signal);
  }

  async generateImage(
    prompt: string,
    options: DashScopeImageOptions = {},
    signal?: AbortSignal
  ): Promise<string> {
    if (!this.config.imageModel) throw new Error('DashScope 图片生成模型尚未配置。');
    const references = (options.referenceImages ?? []).slice(0, 3);
    const requestContent: Array<{ image: string } | { text: string }> = await Promise.all(
      references.map(async (reference) => ({
        image: await fileToDataUrl(reference.filePath, reference.mimeType)
      }))
    );
    requestContent.push({ text: prompt });

    const response = await this.postJson<DashScopeResponse>(
      '/services/aigc/multimodal-generation/generation',
      {
        model: this.config.imageModel,
        input: { messages: [{ role: 'user', content: requestContent }] },
        parameters: { prompt_extend: true, n: 1, watermark: false }
      },
      signal
    );
    const imageUrl = response.output?.choices?.[0]?.message?.content?.find(
      (item) => typeof item.image === 'string' && item.image.length > 0
    )?.image;
    if (!imageUrl) throw new Error('DashScope 图片生成服务未返回图片。');
    return this.saveArtifact(imageUrl, 'image', signal);
  }

  async generateVoice(text: string, signal?: AbortSignal): Promise<{ filePath: string }> {
    const apiKey = this.speechApiKey();
    if (!this.config.tts.enabled || !apiKey) throw new Error('DashScope 语音合成尚未配置。');

    const response = await this.postJson<DashScopeResponse>(
      '/services/audio/tts/SpeechSynthesizer',
      {
        model: this.config.tts.model,
        input: {
          text,
          voice: this.config.tts.voice,
          format: 'wav',
          sample_rate: 24_000
        }
      },
      signal,
      apiKey
    );
    const audio = response.output?.audio;
    if (audio?.url) return { filePath: await this.saveArtifact(audio.url, 'audio', signal) };
    if (audio?.data) {
      const buffer = Buffer.from(audio.data, 'base64');
      if (buffer.length > audioDownloadLimit) {
        throw new Error('DashScope 语音产物超过本地下载大小限制。');
      }
      assertWav(buffer);
      await ensureDir(this.outputsDir);
      const filePath = path.join(this.outputsDir, `voice_${randomUUID()}.wav`);
      await writeFile(filePath, buffer);
      return { filePath };
    }
    throw new Error('DashScope 语音合成服务未返回音频。');
  }

  async generateVideo(
    prompt: string,
    options: DashScopeVideoOptions = {},
    signal?: AbortSignal
  ): Promise<string> {
    const route = selectDashScopeVideoRoute(options);
    const model = modelForRoute(this.config.videoModels, route);
    const input: Record<string, unknown> = { prompt };
    const parameters: Record<string, unknown> = { resolution: '720P' };
    let usesOssResource = false;

    if (route === 'text-to-video') {
      parameters.ratio = '16:9';
      parameters.duration = dashScopeVideoDuration(prompt);
    } else if (route === 'image-to-video') {
      const frame = options.frameImage ?? options.referenceImages?.[0];
      if (!frame) throw new Error('图生视频需要一张首帧图片。');
      input.media = [
        { type: 'first_frame', url: await fileToDataUrl(frame.filePath, frame.mimeType) }
      ];
      parameters.duration = dashScopeVideoDuration(prompt);
    } else if (route === 'reference-to-video') {
      const references = (options.referenceImages ?? []).slice(0, 9);
      if (references.length === 0) throw new Error('多图参考生视频至少需要一张参考图。');
      input.media = await Promise.all(
        references.map(async (reference) => ({
          type: 'reference_image',
          url: await fileToDataUrl(reference.filePath, reference.mimeType)
        }))
      );
      parameters.ratio = '16:9';
      parameters.duration = dashScopeVideoDuration(prompt);
    } else {
      if (!options.sourceVideo) throw new Error('视频编辑需要一个源视频。');
      const sourceUrl = await this.uploadTemporaryFile(options.sourceVideo, model, signal);
      usesOssResource = true;
      const references = (options.referenceImages ?? []).slice(0, 5);
      input.media = [
        { type: 'video', url: sourceUrl },
        ...(await Promise.all(
          references.map(async (reference) => ({
            type: 'reference_image',
            url: await fileToDataUrl(reference.filePath, reference.mimeType)
          }))
        ))
      ];
    }

    let taskId: string | undefined;
    let completed = false;
    try {
      const submitted = await this.postJson<DashScopeResponse>(
        '/services/aigc/video-generation/video-synthesis',
        { model, input, parameters },
        signal,
        undefined,
        {
          'X-DashScope-Async': 'enable',
          ...(usesOssResource ? { 'X-DashScope-OssResourceResolve': 'enable' } : {})
        }
      );
      taskId = submitted.output?.task_id;
      if (!taskId) throw new Error('DashScope 视频服务未返回任务 ID。');

      const deadline = Date.now() + (options.timeoutMs ?? 10 * 60 * 1_000);
      let current = submitted;
      while (current.output?.task_status !== 'SUCCEEDED') {
        const status = current.output?.task_status;
        if (status && ['FAILED', 'CANCELED', 'UNKNOWN'].includes(status)) {
          throw new Error(`DashScope 视频生成失败：${readDashScopeError(current) || status}`);
        }
        if (Date.now() >= deadline) throw new Error('DashScope 视频生成超时。');
        await delayWithAbort(options.pollIntervalMs ?? 15_000, signal);
        current = await this.getJson<DashScopeResponse>(
          `/tasks/${encodeURIComponent(taskId)}`,
          signal
        );
      }

      const videoUrl = current.output.video_url;
      if (!videoUrl) throw new Error('DashScope 视频任务完成但未返回视频。');
      const result = await this.saveArtifact(videoUrl, 'video', signal);
      completed = true;
      return result;
    } finally {
      if (taskId && !completed) await this.cancelTask(taskId);
    }
  }

  private speechApiKey(): string {
    return (this.config.tts.apiKey || this.config.apiKey).trim();
  }

  private async analyzeMultimodal(
    prompt: string,
    media: DashScopeMediaInput,
    mediaType: 'image_url' | 'video_url',
    signal?: AbortSignal
  ): Promise<string> {
    if (!this.configured()) throw new Error('DashScope 多模态服务尚未配置。');
    const dataUrl = await fileToDataUrl(media.filePath, media.mimeType);
    const response = await this.requestCompatibleJson<DashScopeMultimodalResponse>(
      '/chat/completions',
      {
        model: this.config.multimodalModel,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: mediaType, [mediaType]: { url: dataUrl } }
            ]
          }
        ],
        temperature: 0.2
      },
      signal
    );
    const text = response.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('DashScope 多模态服务没有返回分析结果。');
    return text;
  }

  private async requestCompatibleJson<T extends DashScopeMultimodalResponse>(
    endpoint: string,
    body: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(resolveEndpoint(this.config.baseURL, endpoint), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal
      });
    } catch (error) {
      throw new Error(`DashScope 多模态网络请求失败：${describeNetworkError(error)}`);
    }
    const responseText = await response.text();
    const json = parseJson<T>(responseText);
    if (!response.ok || json.error?.message) {
      const detail = json.error?.message ?? responseText.trim().slice(0, 300);
      throw new Error(`DashScope 多模态请求失败：HTTP ${response.status} ${detail}`);
    }
    return json;
  }

  private async uploadTemporaryFile(
    media: DashScopeMediaInput,
    model: string,
    signal?: AbortSignal
  ): Promise<string> {
    const query = new URLSearchParams({ action: 'getPolicy', model });
    const policy = await this.getJson<UploadPolicyResponse>(`/uploads?${query}`, signal);
    const data = policy.data;
    if (
      !data?.policy ||
      !data.signature ||
      !data.upload_dir ||
      !data.upload_host ||
      !data.oss_access_key_id ||
      !data.x_oss_object_acl ||
      !data.x_oss_forbid_overwrite
    ) {
      throw new Error('DashScope 临时文件服务未返回完整上传凭据。');
    }
    const uploadUrl = assertTrustedAliyunUrl(data.upload_host);
    const file = await readFile(media.filePath);
    const maximum = Number(data.max_file_size_mb || 100) * 1024 * 1024;
    if (!Number.isFinite(maximum) || file.length > maximum) {
      throw new Error('源视频超过 DashScope 临时文件上传限制。');
    }

    const extension = extensionForMimeType(media.mimeType, '.mp4');
    const objectKey = `${data.upload_dir.replace(/\/+$/u, '')}/${randomUUID()}${extension}`;
    const form = new FormData();
    form.append('OSSAccessKeyId', data.oss_access_key_id);
    form.append('Signature', data.signature);
    form.append('policy', data.policy);
    form.append('x-oss-object-acl', data.x_oss_object_acl);
    form.append('x-oss-forbid-overwrite', data.x_oss_forbid_overwrite);
    form.append('key', objectKey);
    form.append('success_action_status', '200');
    form.append(
      'file',
      new Blob([new Uint8Array(file)], { type: media.mimeType }),
      `source${extension}`
    );

    let response: Response;
    try {
      response = await fetch(uploadUrl, { method: 'POST', body: form, signal });
    } catch (error) {
      throw new Error(`DashScope 临时文件上传网络失败：${describeNetworkError(error)}`);
    }
    if (!response.ok) throw new Error(`DashScope 临时文件上传失败：HTTP ${response.status}`);
    return `oss://${objectKey}`;
  }

  private async cancelTask(taskId: string): Promise<void> {
    try {
      await this.postJson(
        `/tasks/${encodeURIComponent(taskId)}/cancel`,
        {},
        AbortSignal.timeout(5_000)
      );
    } catch {
      // Best effort only: the task may already be terminal or the network may be unavailable.
    }
  }

  private async saveArtifact(
    artifactUrl: string,
    kind: 'image' | 'audio' | 'video',
    signal?: AbortSignal
  ): Promise<string> {
    const parsed = parseDataUrl(artifactUrl);
    let buffer: Buffer;
    let mimeType: string | undefined;
    if (parsed) {
      buffer = parsed.buffer;
      mimeType = parsed.mimeType;
      if (buffer.length > limitForKind(kind)) {
        throw new Error('DashScope 产物超过本地下载大小限制。');
      }
    } else {
      const url = assertTrustedAliyunUrl(artifactUrl);
      let response: Response;
      try {
        response = await fetch(url, { signal });
      } catch (error) {
        throw new Error(`DashScope 产物下载网络失败：${describeNetworkError(error)}`);
      }
      if (!response.ok) throw new Error(`DashScope 产物下载失败：HTTP ${response.status}`);
      mimeType = response.headers.get('content-type')?.split(';')[0]?.trim();
      buffer = await readResponseBufferLimited(response, limitForKind(kind));
    }

    if (kind === 'image') assertImage(buffer);
    if (kind === 'audio') assertWav(buffer);
    if (kind === 'video') assertMp4(buffer);
    await ensureDir(this.outputsDir);
    const fallback = kind === 'image' ? '.png' : kind === 'audio' ? '.wav' : '.mp4';
    const filePath = path.join(
      this.outputsDir,
      `${kind}_${randomUUID()}${extensionForMimeType(mimeType ?? '', fallback)}`
    );
    await writeFile(filePath, buffer);
    return filePath;
  }

  private async getJson<T extends DashScopeResponse>(
    endpoint: string,
    signal?: AbortSignal
  ): Promise<T> {
    return this.requestJson<T>('GET', endpoint, undefined, signal);
  }

  private async postJson<T extends DashScopeResponse>(
    endpoint: string,
    body: unknown,
    signal?: AbortSignal,
    apiKey = this.config.apiKey,
    extraHeaders: Record<string, string> = {}
  ): Promise<T> {
    return this.requestJson<T>('POST', endpoint, body, signal, apiKey, extraHeaders);
  }

  private async requestJson<T extends DashScopeResponse>(
    method: 'GET' | 'POST',
    endpoint: string,
    body: unknown,
    signal?: AbortSignal,
    apiKey = this.config.apiKey,
    extraHeaders: Record<string, string> = {}
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(resolveEndpoint(this.config.nativeBaseURL, endpoint), {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...extraHeaders
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal
      });
    } catch (error) {
      throw new Error(`DashScope 网络请求失败：${describeNetworkError(error)}`);
    }

    const responseText = await response.text();
    const json = parseJson<T>(responseText);
    if (!response.ok || json.code) {
      const detail = readDashScopeError(json) || responseText.trim().slice(0, 300);
      throw new Error(
        detail
          ? `DashScope 请求失败：HTTP ${response.status} ${detail}`
          : `DashScope 请求失败：HTTP ${response.status}`
      );
    }
    return json;
  }
}

export function selectDashScopeVideoRoute(
  options: DashScopeVideoOptions
): Exclude<DashScopeVideoMode, 'auto'> {
  if (options.mode && options.mode !== 'auto') return options.mode;
  if (options.sourceVideo) return 'video-edit';
  const referenceCount = options.referenceImages?.length ?? 0;
  if (referenceCount >= 2) return 'reference-to-video';
  if (options.frameImage || referenceCount === 1) return 'image-to-video';
  return 'text-to-video';
}

function modelForRoute(
  models: AppConfig['media']['videoModels'],
  route: Exclude<DashScopeVideoMode, 'auto'>
): string {
  switch (route) {
    case 'text-to-video':
      return models.textToVideo;
    case 'image-to-video':
      return models.imageToVideo;
    case 'reference-to-video':
      return models.referenceToVideo;
    case 'video-edit':
      return models.videoEdit;
  }
}

function dashScopeVideoDuration(prompt: string): number {
  const match = prompt.match(/(?:^|[^\d.])(\d{1,2})\s*(?:秒|s|sec|secs|second|seconds)(?![a-z])/iu);
  const value = match?.[1] ? Number(match[1]) : 5;
  return Math.min(15, Math.max(3, Math.round(value)));
}

async function fileToDataUrl(filePath: string, mimeType: string): Promise<string> {
  const data = await readFile(filePath);
  return `data:${mimeType};base64,${data.toString('base64')}`;
}

function resolveEndpoint(baseURL: string, endpoint: string): string {
  const base = baseURL.replace(/\/+$/u, '');
  return `${base}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
}

function assertTrustedAliyunUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DashScope 返回了无效的产物地址。');
  }
  if (!url.hostname.toLowerCase().endsWith('.aliyuncs.com')) {
    throw new Error('DashScope 返回了不受信任的产物地址。');
  }
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') throw new Error('DashScope 返回了不受信任的产物地址。');
  return url.toString();
}

function parseDataUrl(value: string): { mimeType: string; buffer: Buffer } | undefined {
  const match = value.match(/^data:([^;,]+);base64,(.*)$/su);
  if (!match?.[1] || !match[2]) return undefined;
  return { mimeType: match[1], buffer: Buffer.from(match[2], 'base64') };
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      text.trim()
        ? `DashScope 返回了非 JSON 响应：${text.slice(0, 300)}`
        : 'DashScope 返回了空响应。'
    );
  }
}

function readDashScopeError(response: DashScopeResponse): string {
  const code = response.output?.code ?? response.code;
  const message = response.output?.message ?? response.message;
  return [code, message].filter(Boolean).join(' ');
}

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('任务已超时或取消。'));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new Error('任务已超时或取消。'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readResponseBufferLimited(response: Response, limit: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (contentLength > limit) throw new Error('DashScope 产物超过本地下载大小限制。');
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error('DashScope 产物超过本地下载大小限制。');
    }
    chunks.push(value);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total
  );
}

function limitForKind(kind: 'image' | 'audio' | 'video'): number {
  if (kind === 'image') return imageDownloadLimit;
  if (kind === 'audio') return audioDownloadLimit;
  return videoDownloadLimit;
}

function assertWav(buffer: Buffer): void {
  if (
    buffer.length < 12 ||
    buffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    buffer.subarray(8, 12).toString('ascii') !== 'WAVE'
  ) {
    throw new Error('DashScope 语音合成返回的内容不是有效 WAV。');
  }
}

function assertImage(buffer: Buffer): void {
  const png =
    buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const jpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const webp =
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!png && !jpeg && !webp) {
    throw new Error('DashScope 图片生成返回的内容不是有效图片。');
  }
}

function assertMp4(buffer: Buffer): void {
  if (buffer.length < 12 || buffer.subarray(4, 8).toString('ascii') !== 'ftyp') {
    throw new Error('DashScope 视频生成返回的内容不是有效 MP4。');
  }
}

function extensionForMimeType(mimeType: string, fallback: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/png':
      return '.png';
    case 'audio/wav':
    case 'audio/x-wav':
      return '.wav';
    case 'video/quicktime':
      return '.mov';
    case 'video/mp4':
      return '.mp4';
    default:
      return fallback;
  }
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    if (error.cause instanceof Error && error.cause.message) return error.cause.message;
    return error.message;
  }
  return String(error);
}

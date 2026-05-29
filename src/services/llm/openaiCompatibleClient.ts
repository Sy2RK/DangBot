import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../types.js';
import { ensureDir } from '../../utils/fs.js';

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
}

type MultimodalKind = 'image' | 'video';
const defaultVideoDurationSeconds = 4;
const minVideoDurationSeconds = 1;
const maxVideoDurationSeconds = 30;

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
      images?: GeneratedImage[];
      annotations?: ChatAnnotation[];
    };
  }>;
  error?: {
    message?: string;
  };
}

interface ChatAnnotation {
  type?: string;
  url_citation?: {
    url?: string;
    title?: string;
    content?: string;
  };
}

interface GeneratedImage {
  image_url?: {
    url?: string;
  };
  imageUrl?: {
    url?: string;
  };
}

interface VideoJobResponse {
  id?: string;
  polling_url?: string;
  status?: string;
  unsigned_urls?: string[];
  error?:
    | string
    | {
        message?: string;
      };
}

export interface VideoGenerationOptions {
  frameImagePath?: string;
  frameImageMimeType?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ImageGenerationOptions {
  referenceImagePath?: string;
  referenceImageMimeType?: string;
}

export interface WebSearchToolOptions {
  maxResults: number;
  searchContextSize: 'low' | 'medium' | 'high';
  engine?: 'auto' | 'native' | 'exa' | 'firecrawl' | 'parallel';
}

export interface WebSearchToolSource {
  title: string;
  url: string;
  content?: string;
}

export interface WebSearchToolAnswer {
  text: string;
  sources: WebSearchToolSource[];
}

interface ApiErrorResponse {
  error?:
    | {
        message?: string;
      }
    | string;
}

export class OpenAICompatibleClient {
  constructor(
    private readonly config: AppConfig['llm'],
    private readonly outputsDir: string,
    private readonly systemPrompt = '你是微信群里的公共智能助手。回答要清晰、简洁，并避免泄露无关隐私。'
  ) {}

  configured(): boolean {
    return this.config.apiKey.trim().length > 0;
  }

  async chat(
    messages: ChatTurn[],
    signal?: AbortSignal,
    options: ChatOptions = {}
  ): Promise<string> {
    if (!this.configured()) {
      return 'LLM API key 尚未配置。请在 config/local.yaml 或 OPENAI_API_KEY 中配置后重试。';
    }

    const response = await this.post<ChatCompletionResponse>(
      '/chat/completions',
      {
        model: this.config.textModel,
        messages,
        temperature: options.temperature ?? 0.3
      },
      signal
    );

    return readAssistantText(response);
  }

  async chatWithWebSearch(
    messages: ChatTurn[],
    options: WebSearchToolOptions,
    signal?: AbortSignal
  ): Promise<WebSearchToolAnswer> {
    if (!this.configured()) {
      throw new Error('联网搜索需要先配置 OpenRouter API key。');
    }

    const parameters: Record<string, unknown> = {
      max_results: options.maxResults,
      max_total_results: options.maxResults,
      search_context_size: options.searchContextSize
    };
    if (options.engine) parameters.engine = options.engine;

    const response = await this.post<ChatCompletionResponse>(
      '/chat/completions',
      {
        model: this.config.textModel,
        messages,
        tools: [
          {
            type: 'openrouter:web_search',
            parameters
          }
        ],
        temperature: 0.2
      },
      signal
    );

    return {
      text: readAssistantText(response),
      sources: readWebSearchSources(response)
    };
  }

  async vision(
    prompt: string,
    imagePath: string,
    mimeType: string,
    signal?: AbortSignal,
    systemPrompt?: string
  ): Promise<string> {
    return this.multimodal(prompt, imagePath, mimeType, 'image', signal, systemPrompt);
  }

  async video(
    prompt: string,
    videoPath: string,
    mimeType: string,
    signal?: AbortSignal,
    systemPrompt?: string
  ): Promise<string> {
    return this.multimodal(prompt, videoPath, mimeType, 'video', signal, systemPrompt);
  }

  async multimodal(
    prompt: string,
    mediaPath: string,
    mimeType: string,
    kind: MultimodalKind,
    signal?: AbortSignal,
    systemPrompt = this.systemPrompt
  ): Promise<string> {
    if (!this.configured()) {
      return '多模态模型 API key 尚未配置。请配置后再分析图片或视频。';
    }

    const media = await readFile(mediaPath);
    const dataUrl = `data:${mimeType};base64,${media.toString('base64')}`;
    const response = await this.post<ChatCompletionResponse>(
      '/chat/completions',
      {
        model: this.config.visionModel,
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: [{ type: 'text', text: prompt }, mediaContent(kind, dataUrl)]
          }
        ],
        temperature: 0.2
      },
      signal
    );

    return readAssistantText(response);
  }

  async generateImage(
    prompt: string,
    options: ImageGenerationOptions = {},
    signal?: AbortSignal
  ): Promise<string> {
    if (!this.configured() || !this.config.imageModel) {
      throw new Error('图片生成模型尚未配置。请设置 llm.imageModel。');
    }

    const content =
      options.referenceImagePath && options.referenceImageMimeType
        ? [
            { type: 'text', text: prompt },
            mediaContent(
              'image',
              await fileToDataUrl(options.referenceImagePath, options.referenceImageMimeType)
            )
          ]
        : prompt;

    const response = await this.post<ChatCompletionResponse>(
      '/chat/completions',
      {
        model: this.config.imageModel,
        messages: [
          {
            role: 'user',
            content
          }
        ],
        modalities: ['image'],
        stream: false
      },
      signal
    );

    const imageUrl = readGeneratedImageUrl(response);
    return this.saveGeneratedImage(imageUrl, signal);
  }

  async generateVideo(
    prompt: string,
    options: VideoGenerationOptions = {},
    signal?: AbortSignal
  ): Promise<string> {
    if (!this.configured() || !this.config.videoModel) {
      throw new Error('视频生成模型尚未配置。请设置 llm.videoModel。');
    }

    const body: Record<string, unknown> = {
      model: this.config.videoModel,
      prompt,
      duration: parseVideoDurationSeconds(prompt),
      resolution: '720p',
      generate_audio: false
    };

    if (options.frameImagePath && options.frameImageMimeType) {
      body.frame_images = [
        {
          type: 'image_url',
          image_url: {
            url: await fileToDataUrl(options.frameImagePath, options.frameImageMimeType)
          },
          frame_type: 'first_frame'
        }
      ];
    }

    const submitted = await this.post<VideoJobResponse>('/videos', body, signal);
    const jobId = submitted.id;
    if (!jobId) throw new Error('视频生成服务未返回任务 ID。');

    const deadline = Date.now() + (options.timeoutMs ?? 10 * 60 * 1000);
    let current = submitted;

    while (current.status !== 'completed') {
      if (isTerminalFailedVideoStatus(current.status)) {
        throw new Error(`视频生成失败：${readVideoError(current)}`);
      }

      if (Date.now() >= deadline) {
        throw new Error('视频生成超时。');
      }

      await delayWithAbort(options.pollIntervalMs ?? 10_000, signal);
      current = await this.getJson<VideoJobResponse>(
        current.polling_url ?? `/videos/${jobId}`,
        signal
      );
    }

    const contentUrl = current.unsigned_urls?.[0] ?? `/videos/${jobId}/content?index=0`;
    return this.downloadGeneratedVideo(contentUrl, signal);
  }

  private async saveGeneratedImage(imageUrl: string, signal?: AbortSignal): Promise<string> {
    await ensureDir(this.outputsDir);
    const parsed = parseDataUrl(imageUrl);
    if (parsed) {
      const outputPath = path.join(
        this.outputsDir,
        `image_${randomUUID()}${extensionForMimeType(parsed.mimeType, '.png')}`
      );
      await writeFile(outputPath, parsed.buffer);
      return outputPath;
    }

    const outputPath = path.join(this.outputsDir, `image_${randomUUID()}.png`);
    const url = this.resolveApiUrl(imageUrl);
    let download: Response;
    try {
      download = await fetch(url, {
        headers: this.shouldSendAuth(url) ? this.authHeaders() : undefined,
        signal
      });
    } catch (error) {
      throw new Error(`图片下载网络失败：${describeNetworkError(error)}`);
    }
    if (!download.ok) throw new Error(`图片下载失败：HTTP ${download.status}`);
    await writeFile(outputPath, Buffer.from(await download.arrayBuffer()));
    return outputPath;
  }

  private async downloadGeneratedVideo(contentUrl: string, signal?: AbortSignal): Promise<string> {
    await ensureDir(this.outputsDir);
    const outputPath = path.join(this.outputsDir, `video_${randomUUID()}.mp4`);
    const url = this.resolveApiUrl(contentUrl);
    let download: Response;
    try {
      download = await fetch(url, {
        headers: this.shouldSendAuth(url) ? this.authHeaders() : undefined,
        signal
      });
    } catch (error) {
      throw new Error(`视频下载网络失败：${describeNetworkError(error)}`);
    }
    if (!download.ok) throw new Error(`视频下载失败：HTTP ${download.status}`);
    await writeFile(outputPath, Buffer.from(await download.arrayBuffer()));
    return outputPath;
  }

  private async getJson<T>(urlOrEndpoint: string, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.resolveApiUrl(urlOrEndpoint), {
        headers: this.authHeaders(),
        signal
      });
    } catch (error) {
      throw new Error(`LLM 网络请求失败：${describeNetworkError(error)}`);
    }

    const responseText = await response.text();
    const json = parseJsonResponse<T>(responseText);
    if (!response.ok) {
      const detail = readApiError(json) ?? responseText.trim();
      throw new Error(
        detail
          ? `LLM 请求失败：HTTP ${response.status} ${detail}`
          : `LLM 请求失败：HTTP ${response.status}`
      );
    }

    return json;
  }

  private async post<T>(endpoint: string, body: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.resolveApiUrl(endpoint), {
        method: 'POST',
        headers: this.authHeaders({ json: true }),
        body: JSON.stringify(body),
        signal
      });
    } catch (error) {
      throw new Error(`LLM 网络请求失败：${describeNetworkError(error)}`);
    }

    const responseText = await response.text();
    const json = parseJsonResponse<T>(responseText);
    if (!response.ok) {
      const detail = readApiError(json) ?? responseText.trim();
      throw new Error(
        detail
          ? `LLM 请求失败：HTTP ${response.status} ${detail}`
          : `LLM 请求失败：HTTP ${response.status}`
      );
    }

    return json;
  }

  private resolveApiUrl(urlOrEndpoint: string): string {
    if (/^https?:\/\//i.test(urlOrEndpoint)) return urlOrEndpoint;
    const baseURL = this.config.baseURL.replace(/\/+$/, '');
    return `${baseURL}${urlOrEndpoint.startsWith('/') ? urlOrEndpoint : `/${urlOrEndpoint}`}`;
  }

  private shouldSendAuth(url: string): boolean {
    const requestUrl = new URL(url);
    const baseUrl = new URL(this.config.baseURL);
    return requestUrl.origin === baseUrl.origin;
  }

  private authHeaders(options: { json?: boolean } = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      ...(options.json ? { 'Content-Type': 'application/json' } : {})
    };
  }
}

function parseJsonResponse<T>(text: string): T & ApiErrorResponse {
  try {
    return JSON.parse(text) as T & ApiErrorResponse;
  } catch {
    throw new Error(
      text.trim() ? `LLM 返回了非 JSON 响应：${text.slice(0, 300)}` : 'LLM 返回了空响应。'
    );
  }
}

function mediaContent(kind: MultimodalKind, dataUrl: string): Record<string, unknown> {
  if (kind === 'image') {
    return { type: 'image_url', image_url: { url: dataUrl } };
  }

  return { type: 'video_url', video_url: { url: dataUrl } };
}

function readAssistantText(response: ChatCompletionResponse): string {
  const text = response.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error(response.error?.message ?? '模型未返回文本结果。');
  }
  return text;
}

function readWebSearchSources(response: ChatCompletionResponse): WebSearchToolSource[] {
  const annotations = response.choices?.[0]?.message?.annotations ?? [];
  const sources = annotations
    .map((annotation) => annotation.url_citation)
    .filter((citation): citation is NonNullable<ChatAnnotation['url_citation']> =>
      Boolean(citation?.url)
    )
    .map((citation) => ({
      title: normalizeField(citation.title) || normalizeField(citation.url) || 'Untitled',
      url: normalizeField(citation.url),
      content: normalizeField(citation.content) || undefined
    }));

  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

function readGeneratedImageUrl(response: ChatCompletionResponse): string {
  const images = response.choices?.[0]?.message?.images ?? [];
  const imageUrl = images.map((image) => image.image_url?.url ?? image.imageUrl?.url).find(Boolean);
  if (!imageUrl) {
    throw new Error(response.error?.message ?? '图片生成服务未返回图片。');
  }
  return imageUrl;
}

async function fileToDataUrl(filePath: string, mimeType: string): Promise<string> {
  const data = await readFile(filePath);
  return `data:${mimeType};base64,${data.toString('base64')}`;
}

function parseDataUrl(dataUrl: string): { mimeType: string; buffer: Buffer } | undefined {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/s);
  if (!match?.[1] || !match[2]) return undefined;
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], 'base64')
  };
}

function extensionForMimeType(mimeType: string, fallback: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/png':
      return '.png';
    case 'video/mp4':
      return '.mp4';
    default:
      return fallback;
  }
}

function isTerminalFailedVideoStatus(status?: string): boolean {
  return status === 'failed' || status === 'cancelled' || status === 'expired';
}

function readVideoError(response: VideoJobResponse): string {
  if (!response.error) return response.status ?? '未知错误';
  if (typeof response.error === 'string') return response.error;
  return response.error.message ?? response.status ?? '未知错误';
}

export function parseVideoDurationSeconds(
  prompt: string,
  fallback = defaultVideoDurationSeconds
): number {
  const numeric = prompt.match(
    /(?:^|[^\d.])(\d{1,2})(?:\s*)(?:秒|s|sec|secs|second|seconds)(?![a-z])/i
  );
  const parsedNumeric = numeric?.[1] ? Number(numeric[1]) : undefined;
  if (typeof parsedNumeric === 'number' && Number.isFinite(parsedNumeric)) {
    return clampVideoDuration(parsedNumeric);
  }

  const chinese = prompt.match(/([一二两三四五六七八九十]{1,3})\s*秒/);
  if (chinese?.[1]) {
    const parsedChinese = parseChineseInteger(chinese[1]);
    if (parsedChinese !== undefined) return clampVideoDuration(parsedChinese);
  }

  return clampVideoDuration(fallback);
}

function clampVideoDuration(value: number): number {
  return Math.min(maxVideoDurationSeconds, Math.max(minVideoDurationSeconds, Math.round(value)));
}

function parseChineseInteger(text: string): number | undefined {
  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  };

  if (text === '十') return 10;
  if (!text.includes('十')) return digits[text];

  const [tensText = '', onesText = ''] = text.split('十');
  const tens = tensText ? digits[tensText] : 1;
  const ones = onesText ? digits[onesText] : 0;
  if (tens === undefined || ones === undefined) return undefined;
  return tens * 10 + ones;
}

function normalizeField(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function readApiError(response: ApiErrorResponse): string | undefined {
  if (!response.error) return undefined;
  if (typeof response.error === 'string') return response.error;
  return response.error.message;
}

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error('任务已超时或取消。'));
  }

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

function describeNetworkError(error: unknown): string {
  const base = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const causeMessage =
    cause instanceof Error
      ? cause.message
      : cause && typeof cause === 'object' && 'code' in cause
        ? String((cause as { code?: unknown }).code)
        : undefined;
  return causeMessage && causeMessage !== base ? `${base} (${causeMessage})` : base;
}

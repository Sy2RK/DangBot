import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../types.js';
import { ensureDir } from '../../utils/fs.js';

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

type MultimodalKind = 'image' | 'video';

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

interface ImageGenerationResponse {
  data?: Array<{
    b64_json?: string;
    url?: string;
  }>;
  error?: {
    message?: string;
  };
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

  async chat(messages: ChatTurn[], signal?: AbortSignal): Promise<string> {
    if (!this.configured()) {
      return 'LLM API key 尚未配置。请在 config/local.yaml 或 OPENAI_API_KEY 中配置后重试。';
    }

    const response = await this.post<ChatCompletionResponse>(
      '/chat/completions',
      {
        model: this.config.textModel,
        messages,
        temperature: 0.3
      },
      signal
    );

    return readAssistantText(response);
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
            content: [
              { type: 'text', text: prompt },
              mediaContent(kind, dataUrl)
            ]
          }
        ],
        temperature: 0.2
      },
      signal
    );

    return readAssistantText(response);
  }

  async generateImage(prompt: string, signal?: AbortSignal): Promise<string> {
    if (!this.configured() || !this.config.imageModel) {
      throw new Error('图片生成模型尚未配置。当前 Qwen 多模态配置支持图片/视频理解，不等同于图片生成。');
    }

    const response = await this.post<ImageGenerationResponse>(
      '/images/generations',
      {
        model: this.config.imageModel,
        prompt,
        size: '1024x1024'
      },
      signal
    );

    const first = response.data?.[0];
    if (!first) throw new Error('图片生成服务未返回结果。');

    await ensureDir(this.outputsDir);
    const outputPath = path.join(this.outputsDir, `image_${randomUUID()}.png`);

    if (first.b64_json) {
      await writeFile(outputPath, Buffer.from(first.b64_json, 'base64'));
      return outputPath;
    }

    if (first.url) {
      const download = await fetch(first.url, { signal });
      if (!download.ok) throw new Error(`图片下载失败：HTTP ${download.status}`);
      await writeFile(outputPath, Buffer.from(await download.arrayBuffer()));
      return outputPath;
    }

    throw new Error('图片生成服务返回格式不支持。');
  }

  private async post<T>(endpoint: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const baseURL = this.config.baseURL.replace(/\/+$/, '');
    const response = await fetch(`${baseURL}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal
    });

    const responseText = await response.text();
    const json = parseJsonResponse<T>(responseText);
    if (!response.ok) {
      const detail = json.error?.message ?? responseText.trim();
      throw new Error(detail ? `LLM 请求失败：HTTP ${response.status} ${detail}` : `LLM 请求失败：HTTP ${response.status}`);
    }

    return json;
  }
}

function parseJsonResponse<T>(text: string): T & { error?: { message?: string } } {
  try {
    return JSON.parse(text) as T & { error?: { message?: string } };
  } catch {
    throw new Error(text.trim() ? `LLM 返回了非 JSON 响应：${text.slice(0, 300)}` : 'LLM 返回了空响应。');
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

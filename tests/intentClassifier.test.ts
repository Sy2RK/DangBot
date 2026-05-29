import pino from 'pino';
import { describe, expect, it } from 'vitest';
import {
  classifyRequestKind,
  parseRequestKind
} from '../src/core/intentClassifier.js';
import type { OpenAICompatibleClient } from '../src/services/llm/openaiCompatibleClient.js';
import type { IncomingAttachment } from '../src/types.js';

describe('intentClassifier', () => {
  it('uses LLM JSON output as the request type', async () => {
    const calls: Array<{
      messages: Array<{ role: string; content: string }>;
      options?: { temperature?: number };
    }> = [];
    const llm = mockLlm(async (messages, _signal, options) => {
      calls.push({ messages, options });
      return '{"requestType":"web_search"}';
    });

    const requestType = await classifyRequestKind(
      '帮我看一下今年杭州的高考日程',
      [],
      llm,
      silentLogger()
    );

    expect(requestType).toBe('web_search');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages[0]?.content).toContain('请求意图分类器');
    expect(calls[0]?.messages.at(-1)?.content).toContain('用户请求：帮我看一下今年杭州的高考日程');
    expect(calls[0]?.options).toMatchObject({ temperature: 0 });
  });

  it('passes attachment facts to the LLM classifier', async () => {
    const attachment: IncomingAttachment = {
      name: 'cat.png',
      path: '/tmp/cat.png',
      mimeType: 'image/png',
      sizeBytes: 1,
      kind: 'image'
    };
    let userPrompt = '';
    const llm = mockLlm(async (messages) => {
      userPrompt = messages.at(-1)?.content ?? '';
      return '{"requestType":"image_generation"}';
    });

    const requestType = await classifyRequestKind(
      '帮我把它弄得更可爱一点',
      [attachment],
      llm,
      silentLogger()
    );

    expect(requestType).toBe('image_generation');
    expect(userPrompt).toContain('kind=image');
    expect(userPrompt).toContain('cat.png');
  });

  it('parses strict JSON, fenced JSON, and bare request type tokens', () => {
    expect(parseRequestKind('{"requestType":"file_analysis"}')).toBe('file_analysis');
    expect(parseRequestKind('```json\n{"request_type":"video_generation"}\n```')).toBe(
      'video_generation'
    );
    expect(parseRequestKind('WEB_SEARCH')).toBe('web_search');
  });

  it('does not fall back to regex-like local intent rules when LLM output is invalid', async () => {
    const llm = mockLlm(async () => '我不确定，可能要搜一下');

    const requestType = await classifyRequestKind(
      '帮我看一下今年杭州的高考日程',
      [],
      llm,
      silentLogger()
    );

    expect(requestType).toBe('qa');
  });
});

function mockLlm(
  chat: (
    messages: Array<{ role: string; content: string }>,
    signal?: AbortSignal,
    options?: { temperature?: number }
  ) => Promise<string>
): OpenAICompatibleClient {
  return {
    configured: () => true,
    chat
  } as unknown as OpenAICompatibleClient;
}

function silentLogger() {
  return pino({ level: 'silent' });
}

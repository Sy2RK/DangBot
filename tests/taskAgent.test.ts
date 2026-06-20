import { describe, expect, it } from 'vitest';
import { buildAgentMessages, parseAgentDecision } from '../src/core/taskAgent.js';

describe('task agent protocol', () => {
  it('parses tool and finish decisions from strict or fenced JSON', () => {
    expect(
      parseAgentDecision(
        '```json\n{"action":"tool","toolName":"web.search","input":{"query":"滕王阁序 全文","prompt":"只返回正文"}}\n```'
      )
    ).toMatchObject({
      action: 'tool',
      toolName: 'web.search',
      input: { query: '滕王阁序 全文', prompt: '只返回正文' }
    });
    expect(parseAgentDecision('{"action":"finish","result":"last_tool"}')).toEqual({
      action: 'finish',
      result: 'last_tool'
    });
  });

  it('tells the planner never to synthesize a named-work placeholder', () => {
    const messages = buildAgentMessages({
      systemPrompt: '你是小当。',
      userPrompt: '朗读一下《滕王阁序》',
      requestType: 'voice_generation',
      suggestedTool: 'voice.generate',
      suggestedInput: { text: '《滕王阁序》' },
      tools: [
        {
          name: 'web.search',
          description: '联网搜索',
          inputDescription: '{"query":"...","prompt":"..."}'
        },
        {
          name: 'voice.generate',
          description: '合成语音',
          inputDescription: '{"text":"完整正文"}'
        }
      ],
      observations: [],
      maxToolOutputChars: 8000
    });

    expect(messages[0]?.content).toContain('不能把作品名本身送去合成');
    expect(messages.at(-1)?.content).toContain('原单步输入：{"text":"《滕王阁序》"}');
  });
});

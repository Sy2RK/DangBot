import { describe, expect, it } from 'vitest';
import { buildToolInputForRequest, extractSpeechText } from '../src/tools/builtin.js';

describe('builtin tool inputs', () => {
  it('extracts only the text that should be synthesized', () => {
    expect(extractSpeechText('生成语音：今天也要开心呀')).toBe('今天也要开心呀');
    expect(extractSpeechText('朗读：春天来了')).toBe('春天来了');
    expect(extractSpeechText('把“欢迎回来”合成语音')).toBe('欢迎回来');
    expect(extractSpeechText('请把 明天上午十点开会 做成音频')).toBe('明天上午十点开会');
  });

  it('stores only the text required by the voice tool', () => {
    expect(buildToolInputForRequest('voice_generation', '生成语音：你好')).toEqual({
      text: '你好'
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildToolInputForRequest,
  extractBoundedText,
  extractSpeechText,
  isUnresolvedSpeechReference
} from '../src/tools/builtin.js';

describe('builtin tool inputs', () => {
  it('extracts only the text that should be synthesized', () => {
    expect(extractSpeechText('生成语音：今天也要开心呀')).toBe('今天也要开心呀');
    expect(extractSpeechText('朗读：春天来了')).toBe('春天来了');
    expect(extractSpeechText('把“欢迎回来”合成语音')).toBe('欢迎回来');
    expect(extractSpeechText('请把 明天上午十点开会 做成音频')).toBe('明天上午十点开会');
    expect(extractSpeechText('朗读一下《滕王阁序》')).toBe('《滕王阁序》');
  });

  it('stores only the text required by the voice tool', () => {
    expect(buildToolInputForRequest('voice_generation', '生成语音：你好')).toEqual({
      text: '你好'
    });
  });

  it('recognizes a named work placeholder that is not actual speech content', () => {
    expect(isUnresolvedSpeechReference('《滕王阁序》')).toBe(true);
    expect(isUnresolvedSpeechReference('一下《滕王阁序》')).toBe(true);
    expect(isUnresolvedSpeechReference('滕王阁序')).toBe(true);
    expect(isUnresolvedSpeechReference('落霞与孤鹜齐飞，秋水共长天一色。')).toBe(false);
  });

  it('extracts bounded text despite punctuation and line-break differences', () => {
    expect(
      extractBoundedText(
        '标题\n豫章故郡，洪都新府。\n正文中段\n请洒潘江，各倾陆海云尔！\n滕王阁诗',
        '豫章故郡，洪都新府。',
        '请洒潘江，各倾陆海云尔。'
      )
    ).toBe('豫章故郡，洪都新府。\n正文中段\n请洒潘江，各倾陆海云尔！');
  });
});

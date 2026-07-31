import { describe, expect, it } from 'vitest';
import {
  appendPlainSources,
  formatPlainList,
  normalizeOutgoingText
} from '../src/core/replyStyle.js';

describe('reply style helpers', () => {
  it('normalizes common Markdown shapes into WeChat plain text', () => {
    const text = normalizeOutgoingText(
      [
        '# 结论',
        '',
        '**可以做**，看这个：[文档](https://example.test/doc)',
        '',
        '```ts',
        'const ok = true;',
        '```',
        '',
        '- 先处理入口',
        '- 再处理输出',
        '',
        '| 字段 | 含义 |',
        '| --- | --- |',
        '| text | 回复内容 |',
        '',
        '[1] 来源标题 https://example.test/source'
      ].join('\n')
    );

    expect(text).toBe(
      [
        '结论',
        '',
        '可以做，看这个：文档 https://example.test/doc',
        '',
        'const ok = true;',
        '',
        '1、先处理入口',
        '2、再处理输出',
        '',
        '字段 / 含义',
        'text / 回复内容',
        '',
        '来源 1：来源标题 https://example.test/source'
      ].join('\n')
    );
    expect(text).not.toContain('# ');
    expect(text).not.toContain('**');
    expect(text).not.toContain('```');
    expect(text).not.toContain('- ');
    expect(text).not.toContain('[文档](');
    expect(text).not.toContain('[1]');
  });

  it('formats lists and sources without Markdown markers', () => {
    expect(formatPlainList('你的持久记忆', ['喜欢短回答', '默认中文'])).toBe(
      ['你的持久记忆：', '1、喜欢短回答', '2、默认中文'].join('\n')
    );
    expect(
      appendPlainSources('查到啦', [{ title: 'Qwen news', url: 'https://example.test/qwen' }])
    ).toBe('查到啦\n\n来源 1：Qwen news https://example.test/qwen');
  });

  it('never exposes local filesystem paths in outgoing text', () => {
    expect(
      normalizeOutgoingText(
        '[文件结果] /Users/example/Workspace/DangBot/data/outputs/result.docx'
      )
    ).toBe('[文件结果] [本地路径已隐藏]');
  });
});

import { describe, expect, it } from 'vitest';
import { currentBeijingDateContext, currentBeijingDateLabel } from '../src/utils/time.js';

describe('time helpers', () => {
  it('formats current date context in Beijing time', () => {
    const date = new Date('2026-05-29T17:04:25.000Z');

    expect(currentBeijingDateLabel(date)).toBe('2026-05-30 北京时间');
    expect(currentBeijingDateContext(date)).toContain('今天是北京时间 2026 年 5 月 30 日');
    expect(currentBeijingDateContext(date)).toContain('相对时间');
  });
});

import { describe, expect, it } from 'vitest';
import { guessWechatyMimeType } from '../src/adapters/wechaty/wechatyAdapter.js';

describe('WechatyAdapter helpers', () => {
  it('recognizes images sent as generic WeChat attachments', () => {
    expect(guessWechatyMimeType('cat.png', undefined)).toBe('image/png');
    expect(guessWechatyMimeType('cat.jpg', undefined)).toBe('image/jpeg');
    expect(guessWechatyMimeType('cat.jpeg', undefined)).toBe('image/jpeg');
    expect(guessWechatyMimeType('cat.webp', undefined)).toBe('image/webp');
  });
});

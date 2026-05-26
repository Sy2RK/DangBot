import { describe, expect, it } from 'vitest';
import { SlidingWindowRateLimiter } from '../src/domain/rateLimiter.js';

describe('SlidingWindowRateLimiter', () => {
  it('limits within a window and recovers later', () => {
    const limiter = new SlidingWindowRateLimiter();
    expect(limiter.allow('u1', 2, 1000, 1000)).toBe(true);
    expect(limiter.allow('u1', 2, 1000, 1100)).toBe(true);
    expect(limiter.allow('u1', 2, 1000, 1200)).toBe(false);
    expect(limiter.allow('u1', 2, 1000, 2101)).toBe(true);
  });
});

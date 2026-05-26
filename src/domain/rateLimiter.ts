interface Bucket {
  timestamps: number[];
}

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const bucket = this.buckets.get(key) ?? { timestamps: [] };
    const threshold = now - windowMs;
    bucket.timestamps = bucket.timestamps.filter((timestamp) => timestamp > threshold);

    if (bucket.timestamps.length >= limit) {
      this.buckets.set(key, bucket);
      return false;
    }

    bucket.timestamps.push(now);
    this.buckets.set(key, bucket);
    return true;
  }

  remaining(key: string, limit: number, windowMs: number, now = Date.now()): number {
    const bucket = this.buckets.get(key) ?? { timestamps: [] };
    const threshold = now - windowMs;
    const used = bucket.timestamps.filter((timestamp) => timestamp > threshold).length;
    return Math.max(0, limit - used);
  }

  reset(): void {
    this.buckets.clear();
  }
}

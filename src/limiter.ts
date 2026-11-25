// Token bucket, design §6C. Every call to Salesforce awaits take() first:
// first attempts, retries, 412 re-reads. Guarantee: at most rate + capacity
// calls start in any 1 s window. On 429: halve (floor), pause for Retry-After,
// then +5/s per 10 s without a 429, back up to the target.
export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  private pausedUntil = 0;
  private lastThrottle = 0;
  private queue: Promise<void> = Promise.resolve();
  rate: number;

  constructor(private target: number, readonly capacity: number, private floor = Math.min(10, target)) {
    this.rate = target; this.tokens = capacity;
  }

  take(): Promise<void> {
    const next = this.queue.then(() => this.acquire());
    this.queue = next;
    return next;
  }

  /** Salesforce said slow down. */
  throttled(retryAfterMs: number): void {
    this.rate = Math.max(this.floor, this.rate / 2);
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + retryAfterMs);
    this.lastThrottle = Date.now();
  }

  private refill(now: number): void {
    if (this.rate < this.target && now - this.lastThrottle >= 10_000) { this.rate = Math.min(this.target, this.rate + 5); this.lastThrottle = now; }
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
  }

  private async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      if (now < this.pausedUntil) { await sleep(this.pausedUntil - now); continue; }
      this.refill(now);
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      await sleep(Math.ceil(((1 - this.tokens) / this.rate) * 1000));
    }
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

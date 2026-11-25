import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket } from '../src/limiter.ts';

const maxInWindow = (ts: number[], ms = 1000) => {
  let best = 0; for (let i = 0, j = 0; j < ts.length; j++) { while (ts[j] - ts[i] >= ms) i++; best = Math.max(best, j - i + 1); } return best;
};

test('§6C token bucket: never more than rate + capacity starts in any 1 s window', async () => {
  const b = new TokenBucket(20, 2);
  const ts: number[] = [];
  await Promise.all(Array.from({ length: 50 }, async () => { await b.take(); ts.push(Date.now()); }));
  ts.sort((x, y) => x - y);
  assert.ok(maxInWindow(ts) <= 22, `max ${maxInWindow(ts)}`);
  assert.ok(ts[ts.length - 1] - ts[0] >= 2000, 'took at least (50-2)/20 s');
});

test('§6C on 429 the rate halves and sends pause for Retry-After', async () => {
  const b = new TokenBucket(20, 1);
  await b.take();
  b.throttled(300);
  assert.equal(b.rate, 10);
  const t0 = Date.now(); await b.take();
  assert.ok(Date.now() - t0 >= 290);
});

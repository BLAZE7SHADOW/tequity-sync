// HMAC-SHA256 webhook signature (design Q10). Demo-only shared secret: not a credential.
import { createHmac, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.WEBHOOK_SECRET ?? 'demo-only-not-a-secret';

export const sign = (rawBody: string): string => createHmac('sha256', SECRET).update(rawBody).digest('hex');

export function verify(rawBody: string, signature: string | undefined, timestamp: string | undefined, now = Date.now()): boolean {
  if (!signature || !timestamp || Math.abs(now - Number(timestamp)) > 5 * 60_000) return false;
  const a = Buffer.from(sign(rawBody)), b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

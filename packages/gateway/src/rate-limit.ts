import { config } from "./config.ts";

// Sliding window: Map<clientIp, timestamps[]>
const buckets = new Map<string, number[]>();

export function check(clientIp: string): { allowed: boolean; retryAfter: number } {
  if (!config.CORDON_RATE_LIMIT) return { allowed: true, retryAfter: 0 };

  const now = Date.now() / 1_000; // seconds
  const cutoff = now - config.CORDON_RATE_WINDOW;

  let bucket = buckets.get(clientIp) ?? [];
  // Evict outside window
  bucket = bucket.filter((t) => t > cutoff);

  if (bucket.length >= config.CORDON_RATE_LIMIT) {
    const oldest = bucket[0] ?? now;
    const retryAfter = Math.ceil(config.CORDON_RATE_WINDOW - (now - oldest)) + 1;
    buckets.set(clientIp, bucket);
    return { allowed: false, retryAfter };
  }

  bucket.push(now);
  buckets.set(clientIp, bucket);
  return { allowed: true, retryAfter: 0 };
}

export function reset(clientIp?: string) {
  if (clientIp === undefined) buckets.clear();
  else buckets.delete(clientIp);
}

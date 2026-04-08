import type { RateLimitConfig } from 'cordon-sdk';

/**
 * Sliding-window rate limiter. Tracks call counts per minute across three
 * dimensions: global, per-server, and per-tool. All three must pass for a
 * call to be allowed.
 *
 * Blocked calls are NOT recorded — they don't consume a slot.
 */
export class RateLimiter {
  private windows = new Map<string, number[]>();

  constructor(private config: RateLimitConfig) {}

  /**
   * Returns true if the call is within all applicable limits and records it.
   * Returns false if any limit is exceeded (call is not recorded).
   */
  check(serverName: string, toolName: string): boolean {
    const now = Date.now();
    const windowMs = 60_000;

    // Check all windows before recording anything — blocked calls consume no slot
    if (!this.fits('__global__', this.config.maxCallsPerMinute, now, windowMs)) return false;

    const serverLimit = this.config.perServer?.[serverName];
    if (serverLimit !== undefined && !this.fits(`s:${serverName}`, serverLimit, now, windowMs)) return false;

    const toolLimit = this.config.perTool?.[toolName];
    if (toolLimit !== undefined && !this.fits(`t:${toolName}`, toolLimit, now, windowMs)) return false;

    // All checks passed — record in every applicable window
    this.push('__global__', now, windowMs);
    if (serverLimit !== undefined) this.push(`s:${serverName}`, now, windowMs);
    if (toolLimit !== undefined) this.push(`t:${toolName}`, now, windowMs);

    return true;
  }

  private fits(key: string, limit: number, now: number, windowMs: number): boolean {
    const ts = this.windows.get(key);
    if (!ts) return true;
    const recent = ts.filter((t) => now - t < windowMs);
    return recent.length < limit;
  }

  private push(key: string, now: number, windowMs: number): void {
    const ts = (this.windows.get(key) ?? []).filter((t) => now - t < windowMs);
    ts.push(now);
    this.windows.set(key, ts);
  }
}

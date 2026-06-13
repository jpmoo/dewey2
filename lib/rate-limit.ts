/**
 * Tiny in-memory fixed-window rate limiter. Adequate for this single-process
 * deployment (systemd, one instance); limits reset on restart and would NOT
 * coordinate across multiple instances — switch to a shared store (e.g. Redis)
 * if the app is ever scaled out.
 */

type Window = { count: number; resetAt: number };
const windows = new Map<string, Window>();

function hit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now >= w.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (w.count >= max) return false;
  w.count += 1;
  return true;
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

// Per-user ceilings for LLM-backed actions (env-overridable).
const AI_PER_MIN = num(process.env.AI_RATE_PER_MIN, 15);
const AI_PER_HOUR = num(process.env.AI_RATE_PER_HOUR, 120);

/**
 * Whether this user may make another AI request now (checks both a per-minute
 * and a per-hour budget). Consumes one token from each when allowed.
 */
export function allowAiRequest(userId: number): boolean {
  // Check both windows without consuming until both pass would be ideal, but a
  // tiny over-count at the boundary is harmless; check minute first (tighter).
  if (!hit(`ai:min:${userId}`, AI_PER_MIN, 60_000)) return false;
  if (!hit(`ai:hour:${userId}`, AI_PER_HOUR, 3_600_000)) return false;
  return true;
}

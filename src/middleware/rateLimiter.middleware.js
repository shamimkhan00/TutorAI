// middleware/rateLimiter.middleware.js
"use strict";

/**
 * Minimal in-memory sliding-window rate limiter.
 * Good enough for a single-instance Node server. If you scale to multiple
 * instances later, swap the `hits` Map for a Redis-backed counter —
 * the public API (rateLimiter(opts)) stays the same.
 */

const buckets = new Map(); // key -> { count, windowStart }

function rateLimiter({ windowMs = 60_000, max = 20, keyFn } = {}) {
  return (req, res, next) => {
    const key = keyFn
      ? keyFn(req)
      : (req.user?.uid || req.userId || req.ip || "anonymous");

    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || now - bucket.windowStart >= windowMs) {
      buckets.set(key, { count: 1, windowStart: now });
      return next();
    }

    if (bucket.count >= max) {
      const retryAfterMs = windowMs - (now - bucket.windowStart);
      res.setHeader("Retry-After", Math.ceil(retryAfterMs / 1000));
      return res.status(429).json({
        error: "Too many requests. Please slow down.",
        retryAfterMs,
      });
    }

    bucket.count += 1;
    next();
  };
}

// Periodic cleanup so the Map doesn't grow unbounded over a long-running process
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (now - bucket.windowStart > 10 * 60_000) buckets.delete(key);
  }
}, 5 * 60_000);

module.exports = { rateLimiter };
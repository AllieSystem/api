import NodeCache from 'node-cache';
import { logger } from '../utils/logger.js';

const requestCounts = new NodeCache({
  stdTTL: 60,
  checkperiod: 60,
  maxKeys: 1000,
});

export function rateLimitMiddleware(options = {}) {
  const maxRequests = options.maxRequests || 100;
  const windowMs = options.windowMs || 60000;
  const keyPrefix = options.keyPrefix || 'rl:';

  return (req, res, next) => {
    const apiKey = req.apiKey?.id || req.ip || 'unknown';
    const key = `${keyPrefix}${apiKey}`;

    let count = requestCounts.get(key) || 0;
    count++;

    if (count === 1) {
      requestCounts.set(key, count, windowMs / 1000);
    } else {
      requestCounts.set(key, count);
    }

    const remaining = Math.max(0, maxRequests - count);
    const ttl = requestCounts.getTtl(key);
    const resetIn = ttl > 0
      ? Math.max(0, Math.floor((ttl - Date.now()) / 1000))
      : Math.floor(windowMs / 1000);

    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', resetIn);

    if (count > maxRequests) {
      logger.warn({ apiKey, count, maxRequests }, 'Rate limit exceeded');
      return res.status(429).json({
        success: false,
        error: 'Demasiadas solicitudes. Intenta de nuevo más tarde.',
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfter: resetIn,
      });
    }

    next();
  };
}

export function createKeyBasedRateLimit(maxRequests = 100, windowSeconds = 60) {
  const cache = new NodeCache({
    stdTTL: windowSeconds,
    checkperiod: 10,
  });

  return (key, increment = true) => {
    if (increment) {
      const count = cache.get(key) || 0;
      cache.set(key, count + 1);
      return { count: count + 1, remaining: Math.max(0, maxRequests - count - 1) };
    }
    return { count: cache.get(key) || 0, remaining: maxRequests };
  };
}

export default rateLimitMiddleware;
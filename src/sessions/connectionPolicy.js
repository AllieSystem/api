const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const STOP_CODES = new Set([401, 403, 411, 440, 500]);

export function reconnectDelayMs(attempt, random = Math.random) {
  const step = Math.max(1, Number(attempt) || 1);
  const base = Math.min(RECONNECT_BASE_MS * 2 ** (step - 1), RECONNECT_MAX_MS);
  const roll = typeof random === 'function' ? random() : Number(random);
  const jitter = Math.floor(base * 0.2 * Math.min(1, Math.max(0, roll)));
  return base + jitter;
}

export function classifyClose({ statusCode, reason = '' } = {}) {
  const text = String(reason || '');
  if (STOP_CODES.has(statusCode) || text.includes('BadSession') || text.includes('invalid_mechanisms')) {
    return { action: 'stop', status: 'needs_repair' };
  }
  if (statusCode === 515 || text.includes('restart required')) {
    return { action: 'reconnect', delayMs: RECONNECT_BASE_MS };
  }
  return { action: 'reconnect' };
}

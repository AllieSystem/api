export function mediaKeyToBuffer(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return Buffer.from(trimmed, 'base64');
  }
  if (typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
    return Buffer.from(value.data);
  }
  if (typeof value === 'object') {
    const indexes = Object.keys(value)
      .filter((key) => /^\d+$/.test(key))
      .map(Number)
      .sort((left, right) => left - right);
    if (indexes.length > 0) {
      return Buffer.from(indexes.map((index) => value[index]));
    }
  }
  return null;
}

export function normalizeMediaKey(value) {
  const buffer = mediaKeyToBuffer(value);
  return buffer ? buffer.toString('base64') : null;
}

export function normalizeFileLength(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  if (value && typeof value === 'object' && typeof value.low === 'number') {
    const high = typeof value.high === 'number' ? value.high : 0;
    return high * 4294967296 + (value.low >>> 0);
  }
  return null;
}

export function thumbnailToBase64(value) {
  const buffer = mediaKeyToBuffer(value);
  return buffer ? buffer.toString('base64') : null;
}

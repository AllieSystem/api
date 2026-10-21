import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import config from '../config/config.js';

const SCRYPT_SALT = 'whatsapp-hub-auth-v1';

export function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function hashesEqual(leftHex, rightHex) {
  if (typeof leftHex !== 'string' || typeof rightHex !== 'string') return false;
  const left = Buffer.from(leftHex, 'hex');
  const right = Buffer.from(rightHex, 'hex');
  if (left.length === 0 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function deriveEncryptionKey(secret) {
  const value = String(secret || '').trim();
  if (value.length < 16) {
    throw new Error('AUTH_ENCRYPTION_KEY debe tener al menos 16 caracteres');
  }
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return Buffer.from(value, 'hex');
  }
  return crypto.scryptSync(value, SCRYPT_SALT, 32);
}

let cachedKey = null;

export function loadEncryptionKey() {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.AUTH_ENCRYPTION_KEY;
  if (fromEnv) {
    cachedKey = deriveEncryptionKey(fromEnv);
    return cachedKey;
  }

  const file = path.join(config.secrets.dir, 'auth.key');
  if (fs.existsSync(file)) {
    cachedKey = deriveEncryptionKey(fs.readFileSync(file, 'utf8'));
    return cachedKey;
  }

  if (config.app.env === 'production') {
    throw new Error('AUTH_ENCRYPTION_KEY es obligatoria en producción');
  }

  const generated = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(config.secrets.dir, { recursive: true });
  fs.writeFileSync(file, `${generated}\n`, { mode: 0o600 });
  console.warn(
    `Se generó la clave de cifrado en ${file}. Haz una copia fuera del servidor: sin ella no se pueden abrir las sesiones.`
  );
  cachedKey = deriveEncryptionKey(generated);
  return cachedKey;
}

export function encryptString(plain, key = loadEncryptionKey()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    whub: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64'),
  });
}

export function decryptString(payload, key = loadEncryptionKey()) {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (!parsed || parsed.whub !== 1 || parsed.alg !== 'aes-256-gcm') {
    return null;
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(parsed.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function writeEncryptedFileSync(filePath, plain, key = loadEncryptionKey()) {
  const payload = encryptString(plain, key);
  const tmp = `${filePath}.tmp`;
  const bak = `${filePath}.bak`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, payload, { mode: 0o600 });

  const verified = decryptString(JSON.parse(fs.readFileSync(tmp, 'utf8')), key);
  if (verified !== plain) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`No se pudo verificar el cifrado de ${path.basename(filePath)}`);
  }

  if (fs.existsSync(bak)) fs.rmSync(bak, { force: true });
  if (fs.existsSync(filePath)) fs.renameSync(filePath, bak);
  fs.renameSync(tmp, filePath);

  const written = decryptString(JSON.parse(fs.readFileSync(filePath, 'utf8')), key);
  if (written !== plain) {
    if (fs.existsSync(bak)) {
      fs.rmSync(filePath, { force: true });
      fs.renameSync(bak, filePath);
    }
    throw new Error(`La copia cifrada de ${path.basename(filePath)} no se puede leer`);
  }
  if (fs.existsSync(bak)) fs.rmSync(bak, { force: true });
}

export function readMaybeEncryptedSync(filePath, key = loadEncryptionKey()) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed && parsed.whub === 1) {
    return decryptString(parsed, key);
  }
  return raw;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'base64');
  const expected = Buffer.from(parts[2], 'base64');
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function atomicWriteFileSync(filePath, contents) {
  const tmp = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
  fs.renameSync(tmp, filePath);
}

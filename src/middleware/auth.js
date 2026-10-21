import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import config from '../config/config.js';
import { logger } from '../utils/logger.js';
import {
  atomicWriteFileSync,
  hashPassword,
  hashSecret,
  hashesEqual,
  randomToken,
  verifyPassword,
} from '../utils/secrets.js';

const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));
const loginFailures = new Map();

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    logger.error(`Error reading ${path.basename(file)}: ${error.message}`);
    return fallback;
  }
}

function writeJson(file, data) {
  atomicWriteFileSync(file, JSON.stringify(data, null, 2));
}

export function generateApiKey() {
  return `sk_live_${crypto.randomBytes(32).toString('base64url')}`;
}

export function loadKeys() {
  try {
    if (!fs.existsSync(config.auth.keysFile)) {
      createDefaultKeysFile();
    }
    const data = JSON.parse(fs.readFileSync(config.auth.keysFile, 'utf8'));
    if (!Array.isArray(data.keys)) data.keys = [];
    migratePlainKeys(data);
    return data;
  } catch (error) {
    logger.error(`Error loading keys: ${error.message}`);
    return { version: '1.0', keys: [], metadata: {} };
  }
}

function migratePlainKeys(data) {
  const migrated = [];
  let changed = false;
  for (const entry of data.keys) {
    if (typeof entry.key !== 'string' || entry.key.length === 0) continue;
    migrated.push({ id: entry.id, name: entry.name, key: entry.key });
    entry.keyHash = hashSecret(entry.key);
    delete entry.key;
    changed = true;
  }
  if (!changed) return;

  writeJson(config.auth.keysFile, data);
  const dest = path.join(config.secrets.dir, 'api-keys.txt');
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(config.secrets.dir, { recursive: true });
    const body = [
      '# Llaves migradas fuera del código y del navegador.',
      '# Rótalas si el panel ya se publicó: estuvieron en una variable NEXT_PUBLIC.',
      '',
      ...migrated.map((entry) => `${entry.id} ${entry.name}\n${entry.key}`),
      '',
    ].join('\n');
    fs.writeFileSync(dest, body, { mode: 0o600 });
    logger.warn(`Las API keys en claro se movieron a ${dest}. No las vuelvas a poner en el frontend.`);
  }
}

export function saveKeys(keysData) {
  try {
    writeJson(config.auth.keysFile, keysData);
    return true;
  } catch (error) {
    logger.error(`Error saving keys: ${error.message}`);
    return false;
  }
}

export function createDefaultKeysFile() {
  const plainKey = generateApiKey();
  const defaultKeys = {
    version: '1.0',
    keys: [
      {
        id: 'key_001',
        keyHash: hashSecret(plainKey),
        name: 'Admin Principal',
        active: true,
        createdAt: new Date().toISOString(),
        permissions: ['*'],
      },
    ],
    metadata: {
      generatedAt: new Date().toISOString(),
    },
  };
  fs.mkdirSync(path.dirname(config.auth.keysFile), { recursive: true });
  writeJson(config.auth.keysFile, defaultKeys);

  const dest = path.join(config.secrets.dir, 'api-keys.txt');
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(config.secrets.dir, { recursive: true });
    fs.writeFileSync(dest, `key_001 Admin Principal\n${plainKey}\n`, { mode: 0o600 });
    logger.warn(`Se creó una API key en ${dest}. No se imprime en el log.`);
  }
  return defaultKeys;
}

export function createApiKey(name, permissions = ['*']) {
  const keysData = loadKeys();
  const plainKey = generateApiKey();
  const newKey = {
    id: `key_${String(keysData.keys.length + 1).padStart(3, '0')}`,
    keyHash: hashSecret(plainKey),
    name,
    active: true,
    createdAt: new Date().toISOString(),
    permissions,
  };
  keysData.keys.push(newKey);
  saveKeys(keysData);
  logger.info({ keyName: name, keyId: newKey.id }, 'API key created');
  return { ...newKey, key: plainKey };
}

export function revokeApiKey(keyId) {
  const keysData = loadKeys();
  const keyIndex = keysData.keys.findIndex((entry) => entry.id === keyId);
  if (keyIndex === -1) {
    return { success: false, error: 'API Key no encontrada' };
  }
  keysData.keys[keyIndex].active = false;
  keysData.keys[keyIndex].revokedAt = new Date().toISOString();
  saveKeys(keysData);
  logger.info({ keyId }, 'API key revoked');
  return { success: true, message: 'API Key revocada' };
}

export function listApiKeys() {
  const keysData = loadKeys();
  return keysData.keys.map((entry) => ({
    id: entry.id,
    name: entry.name,
    active: entry.active,
    createdAt: entry.createdAt,
    permissions: entry.permissions,
  }));
}

function findActiveKey(presented) {
  const presentedHash = hashSecret(presented);
  const keysData = loadKeys();
  return keysData.keys.find(
    (entry) => entry.active && entry.keyHash && hashesEqual(entry.keyHash, presentedHash)
  );
}

export function verifyApiKey(apiKey) {
  return Boolean(findActiveKey(apiKey));
}

export function hasPermission(principal, permission) {
  const permissions = principal?.permissions || [];
  return permissions.includes('*') || permissions.includes(permission);
}

export function permissionForRequest(req) {
  const route = `${req.baseUrl || ''}${req.path || ''}`;
  if (route.includes('/send')) return 'messages:send';
  if (route.includes('/chats') || route.includes('/download') || route.includes('/check')) {
    return req.method === 'GET' ? 'chats:read' : 'chats:write';
  }
  if (req.method === 'GET' || req.method === 'HEAD') return 'sessions:read';
  return 'sessions:write';
}

export function requireRequestPermission(req, res, next) {
  const permission = permissionForRequest(req);
  if (!hasPermission(req.principal, permission)) {
    return res.status(403).json({
      success: false,
      error: 'Permiso insuficiente',
      code: 'FORBIDDEN',
    });
  }
  return next();
}

function loadUsers() {
  const data = readJson(config.auth.usersFile, { version: 1, users: [] });
  if (!Array.isArray(data.users)) data.users = [];
  return data;
}

function saveUsers(data) {
  writeJson(config.auth.usersFile, data);
}

function loadStoredSessions() {
  const data = readJson(config.auth.sessionsFile, { version: 1, sessions: [] });
  if (!Array.isArray(data.sessions)) data.sessions = [];
  return data;
}

function saveStoredSessions(data) {
  const now = Date.now();
  data.sessions = data.sessions.filter((entry) => Date.parse(entry.expiresAt) > now);
  writeJson(config.auth.sessionsFile, data);
}

function upsertUser(data, username, password) {
  const passwordHash = hashPassword(password);
  const existing = data.users.find((user) => user.username === username);
  if (existing) {
    existing.passwordHash = passwordHash;
    existing.updatedAt = new Date().toISOString();
    return existing;
  }
  const user = {
    id: `user_${crypto.randomBytes(4).toString('hex')}`,
    username,
    passwordHash,
    createdAt: new Date().toISOString(),
  };
  data.users.push(user);
  return user;
}

export function ensurePanelUser() {
  const username = (process.env.PANEL_USERNAME || 'admin').trim() || 'admin';
  const fromEnv = process.env.PANEL_PASSWORD || '';
  const data = loadUsers();

  if (fromEnv) {
    upsertUser(data, username, fromEnv);
    saveUsers(data);
    logger.info({ username }, 'Usuario del panel listo');
    return;
  }

  if (data.users.length > 0) return;

  const file = path.join(config.secrets.dir, 'panel-password.txt');
  let password = '';
  if (fs.existsSync(file)) {
    password = fs.readFileSync(file, 'utf8').trim();
  }
  if (!password) {
    password = crypto.randomBytes(18).toString('base64url');
    fs.mkdirSync(config.secrets.dir, { recursive: true });
    fs.writeFileSync(file, `${password}\n`, { mode: 0o600 });
    logger.warn(
      `Se generó la contraseña del panel en ${file}. Ábrela, guárdala fuera del repositorio y no la subas a git.`
    );
  }
  upsertUser(data, username, password);
  saveUsers(data);
}

export function panelLoginAvailable() {
  return loadUsers().users.length > 0;
}

function findSession(token, type) {
  if (!token || typeof token !== 'string' || token.length < 20) return null;
  const tokenHash = hashSecret(token);
  const now = Date.now();
  return loadStoredSessions().sessions.find((entry) => (
    entry.type === type
    && Date.parse(entry.expiresAt) > now
    && hashesEqual(entry.tokenHash, tokenHash)
  )) || null;
}

export function authenticatePanel(username, password) {
  const normalized = String(username || '').trim();
  const data = loadUsers();
  const user = data.users.find((entry) => entry.username === normalized);
  const valid = user
    ? verifyPassword(password, user.passwordHash)
    : (verifyPassword(password, DUMMY_PASSWORD_HASH), false);
  if (!user || !valid) return null;
  return createPanelSession(user);
}

function createPanelSession(user) {
  const token = randomToken();
  const data = loadStoredSessions();
  const expiresAt = new Date(Date.now() + config.auth.sessionTtlMs).toISOString();
  data.sessions.push({
    id: `ses_${crypto.randomBytes(6).toString('hex')}`,
    tokenHash: hashSecret(token),
    userId: user.id,
    username: user.username,
    type: 'panel',
    parentId: null,
    expiresAt,
    createdAt: new Date().toISOString(),
  });
  saveStoredSessions(data);
  return {
    token,
    username: user.username,
    expiresAt,
    maxAgeSeconds: Math.floor(config.auth.sessionTtlMs / 1000),
  };
}

export function revokeBearerSession(token) {
  const current = findSession(token, 'panel');
  if (!current) return;
  const data = loadStoredSessions();
  data.sessions = data.sessions.filter(
    (entry) => !hashesEqual(entry.tokenHash, hashSecret(token)) && entry.parentId !== current.id
  );
  saveStoredSessions(data);
}

export function createSocketToken(panelSession) {
  const token = randomToken();
  const data = loadStoredSessions();
  const expiresAt = new Date(Date.now() + config.auth.socketTtlMs).toISOString();
  data.sessions.push({
    id: `sok_${crypto.randomBytes(6).toString('hex')}`,
    tokenHash: hashSecret(token),
    userId: panelSession.userId,
    username: panelSession.username,
    type: 'socket',
    parentId: panelSession.id,
    expiresAt,
    createdAt: new Date().toISOString(),
  });
  saveStoredSessions(data);
  return { token, expiresAt };
}

export function verifySocketToken(token) {
  return findSession(token, 'socket');
}

export function loginRateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const recent = (loginFailures.get(ip) || []).filter((stamp) => now - stamp < windowMs);
  if (recent.length >= 8) {
    return res.status(429).json({
      success: false,
      error: 'Demasiados intentos. Espera unos minutos.',
      code: 'RATE_LIMIT_EXCEEDED',
    });
  }
  loginFailures.set(ip, recent);
  res.locals.noteLoginFailure = () => {
    recent.push(Date.now());
    loginFailures.set(ip, recent);
  };
  return next();
}

function principalFromKey(entry) {
  return {
    type: 'api_key',
    id: entry.id,
    name: entry.name,
    permissions: entry.permissions || [],
  };
}

function principalFromSession(entry) {
  return {
    type: 'session',
    id: entry.userId,
    name: entry.username,
    permissions: ['*'],
    sessionId: entry.id,
  };
}

export function authMiddleware(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const authorization = req.headers.authorization || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';

  if (typeof apiKey === 'string' && apiKey.length > 0) {
    const entry = findActiveKey(apiKey);
    if (!entry) {
      logger.warn({ ip: req.ip, path: req.path }, 'Invalid API key');
      return res.status(401).json({
        success: false,
        error: 'API Key inválida',
        code: 'INVALID_API_KEY',
      });
    }
    req.principal = principalFromKey(entry);
    req.apiKey = req.principal;
    return next();
  }

  if (bearer) {
    const session = findSession(bearer, 'panel');
    if (!session) {
      logger.warn({ ip: req.ip, path: req.path }, 'Invalid session');
      return res.status(401).json({
        success: false,
        error: 'Sesión inválida',
        code: 'INVALID_SESSION',
      });
    }
    req.principal = principalFromSession(session);
    req.apiKey = req.principal;
    req.panelSession = session;
    return next();
  }

  logger.warn({ ip: req.ip, path: req.path }, 'Missing credentials');
  return res.status(401).json({
    success: false,
    error: 'Autenticación requerida',
    code: 'MISSING_CREDENTIALS',
  });
}

export function optionalAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    const entry = findActiveKey(apiKey);
    if (entry) {
      req.principal = principalFromKey(entry);
      req.apiKey = req.principal;
    }
  }
  next();
}

export default authMiddleware;

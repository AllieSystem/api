import fs from 'fs';
import path from 'path';
import config from '../config/config.js';
import { logger } from '../utils/logger.js';

export function loadKeys() {
  try {
    if (!fs.existsSync(config.auth.keysFile)) {
      createDefaultKeysFile();
    }
    const data = fs.readFileSync(config.auth.keysFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    logger.error(`Error loading keys: ${error.message}`);
    return { version: '1.0', keys: [], metadata: {} };
  }
}

export function saveKeys(keysData) {
  try {
    const keysDir = path.dirname(config.auth.keysFile);
    if (!fs.existsSync(keysDir)) {
      fs.mkdirSync(keysDir, { recursive: true });
    }
    fs.writeFileSync(config.auth.keysFile, JSON.stringify(keysData, null, 2));
    return true;
  } catch (error) {
    logger.error(`Error saving keys: ${error.message}`);
    return false;
  }
}

export function createDefaultKeysFile() {
  const defaultKey = generateApiKey();
  const defaultKeys = {
    version: '1.0',
    keys: [
      {
        id: 'key_001',
        key: defaultKey,
        name: 'Admin Principal',
        active: true,
        createdAt: new Date().toISOString(),
        permissions: ['*'],
        metadata: {
          note: 'TODO: Migrar a base de datos en v2.0',
        },
      },
    ],
    metadata: {
      note: 'TODO: Migrar a base de datos en v2.0',
      description: 'API Keys para autenticación. En futuras versiones usar base de datos.',
      generatedAt: new Date().toISOString(),
    },
  };

  const keysDir = path.dirname(config.auth.keysFile);
  if (!fs.existsSync(keysDir)) {
    fs.mkdirSync(keysDir, { recursive: true });
  }
  fs.writeFileSync(config.auth.keysFile, JSON.stringify(defaultKeys, null, 2));
  logger.info(`Default API Key created: ${defaultKey}`);
  return defaultKeys;
}

export function generateApiKey(prefix = 'sk_live_') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let key = prefix;
  for (let i = 0; i < 32; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}

export function authMiddleware(req, res, next) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    logger.warn({ ip: req.ip, path: req.path }, 'API Key missing');
    return res.status(401).json({
      success: false,
      error: 'API Key requerida',
      code: 'MISSING_API_KEY',
    });
  }

  const keysData = loadKeys();
  const validKey = keysData.keys.find(
    (k) => k.key === apiKey && k.active
  );

  if (!validKey) {
    logger.warn({ ip: req.ip, path: req.path }, 'Invalid API Key');
    return res.status(401).json({
      success: false,
      error: 'API Key inválida',
      code: 'INVALID_API_KEY',
    });
  }

  req.apiKey = validKey;
  logger.debug({ keyName: validKey.name }, 'Authenticated request');
  next();
}

export function optionalAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const keysData = loadKeys();
    const validKey = keysData.keys.find(
      (k) => k.key === apiKey && k.active
    );
    if (validKey) {
      req.apiKey = validKey;
    }
  }
  next();
}

export function createApiKey(name, permissions = ['*']) {
  const keysData = loadKeys();
  const newKey = {
    id: `key_${String(keysData.keys.length + 1).padStart(3, '0')}`,
    key: generateApiKey(),
    name,
    active: true,
    createdAt: new Date().toISOString(),
    permissions,
    metadata: {},
  };

  keysData.keys.push(newKey);
  saveKeys(keysData);

  logger.info({ keyName: name, keyId: newKey.id }, 'API Key created');
  return newKey;
}

export function revokeApiKey(keyId) {
  const keysData = loadKeys();
  const keyIndex = keysData.keys.findIndex((k) => k.id === keyId);

  if (keyIndex === -1) {
    return { success: false, error: 'API Key no encontrada' };
  }

  keysData.keys[keyIndex].active = false;
  keysData.keys[keyIndex].revokedAt = new Date().toISOString();
  saveKeys(keysData);

  logger.info({ keyId }, 'API Key revoked');
  return { success: true, message: 'API Key revocada' };
}

export function listApiKeys() {
  const keysData = loadKeys();
  return keysData.keys.map((k) => ({
    id: k.id,
    name: k.name,
    active: k.active,
    createdAt: k.createdAt,
    permissions: k.permissions,
  }));
}

export function verifyApiKey(apiKey) {
  const keysData = loadKeys();
  const validKey = keysData.keys.find(
    (k) => k.key === apiKey && k.active
  );
  return !!validKey;
}

export default authMiddleware;
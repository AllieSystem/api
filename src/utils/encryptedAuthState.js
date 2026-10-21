import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import fs from 'fs/promises';
import path from 'path';
import {
  decryptString,
  loadEncryptionKey,
  writeEncryptedFileSync,
} from './secrets.js';

const locks = new Map();

function withLock(filePath, fn) {
  const prev = locks.get(filePath) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(filePath, next);
  return next;
}

function fixFileName(file) {
  return file?.replace(/\//g, '__')?.replace(/:/g, '-');
}

async function readPlain(filePath, key) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }

  const parsed = JSON.parse(raw);
  if (parsed && parsed.whub === 1) {
    const plain = decryptString(parsed, key);
    if (plain == null) {
      throw new Error(`No se pudo descifrar ${path.basename(filePath)}`);
    }
    return JSON.parse(plain, BufferJSON.reviver);
  }

  const legacy = JSON.parse(raw, BufferJSON.reviver);
  const serialized = JSON.stringify(legacy, BufferJSON.replacer);
  writeEncryptedFileSync(filePath, serialized, key);
  return JSON.parse(serialized, BufferJSON.reviver);
}

export async function useEncryptedAuthState(folder) {
  const key = loadEncryptionKey();
  await fs.mkdir(folder, { recursive: true });

  const writeData = async (data, file) => {
    const filePath = path.join(folder, fixFileName(file));
    const serialized = JSON.stringify(data, BufferJSON.replacer);
    return withLock(filePath, async () => {
      writeEncryptedFileSync(filePath, serialized, key);
    });
  };

  const readData = async (file) => {
    const filePath = path.join(folder, fixFileName(file));
    return withLock(filePath, () => readPlain(filePath, key));
  };

  const removeData = async (file) => {
    const filePath = path.join(folder, fixFileName(file));
    return withLock(filePath, async () => {
      await fs.rm(filePath, { force: true });
      await fs.rm(`${filePath}.bak`, { force: true });
    });
  };

  const existing = await fs.readdir(folder).catch(() => []);
  for (const name of existing) {
    if (name.endsWith('.json')) {
      await readData(name);
    }
  }

  const creds = (await readData('creds.json')) || initAuthCreds();
  if (!existing.includes('creds.json')) {
    await writeData(creds, 'creds.json');
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}.json`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => writeData(creds, 'creds.json'),
  };
}

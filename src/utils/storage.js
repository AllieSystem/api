import fs from 'fs';
import path from 'path';
import config from '../config/config.js';
import { decryptString, writeEncryptedFileSync } from './secrets.js';

export function createAuthFolder(sessionId) {
  const authDir = path.join(config.auth.dir, sessionId);
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }
  return authDir;
}

export function createDataFolder(sessionId) {
  const dataDir = path.join(config.data.dir, sessionId);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

export function getAuthFolder(sessionId) {
  return path.join(config.auth.dir, sessionId);
}

export function getDataFolder(sessionId) {
  return path.join(config.data.dir, sessionId);
}

export function getChatsFile(sessionId) {
  return path.join(getDataFolder(sessionId), config.data.chatsFile);
}

export function deleteSessionFolders(sessionId) {
  const authDir = getAuthFolder(sessionId);
  const dataDir = getDataFolder(sessionId);

  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
  }

  if (fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

export function saveChats(sessionId, chatsMap) {
  try {
    const chatsFile = getChatsFile(sessionId);
    const chatsArray = Array.from(chatsMap.values());
    writeEncryptedFileSync(chatsFile, JSON.stringify(chatsArray));
    return true;
  } catch (error) {
    console.error(`Error saving chats for session ${sessionId}:`, error.message);
    return false;
  }
}

export function loadChats(sessionId) {
  const chatsFile = getChatsFile(sessionId);
  if (!fs.existsSync(chatsFile)) return new Map();

  const raw = fs.readFileSync(chatsFile, 'utf8');
  const parsed = JSON.parse(raw);
  let chats = parsed;

  if (parsed && parsed.whub === 1) {
    const plain = decryptString(parsed);
    if (!plain) {
      throw new Error(`No se pudo descifrar el historial de ${sessionId}`);
    }
    chats = JSON.parse(plain);
  } else if (Array.isArray(parsed)) {
    writeEncryptedFileSync(chatsFile, JSON.stringify(parsed));
  } else {
    throw new Error(`Historial inválido para ${sessionId}`);
  }

  if (!Array.isArray(chats)) return new Map();
  return new Map(chats.map((chat) => [chat.phone, chat]));
}

export function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function ensureBaseDirs() {
  ensureDir(config.auth.dir);
  ensureDir(config.data.dir);
  ensureDir(config.app.uploadsDir);
  ensureDir(config.app.logsDir);
}
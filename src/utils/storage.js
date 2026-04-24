import fs from 'fs';
import path from 'path';
import config from '../config/config.js';

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
    fs.writeFileSync(chatsFile, JSON.stringify(chatsArray, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error(`Error saving chats for session ${sessionId}:`, error.message);
    return false;
  }
}

export function loadChats(sessionId) {
  try {
    const chatsFile = getChatsFile(sessionId);
    if (fs.existsSync(chatsFile)) {
      const data = fs.readFileSync(chatsFile, 'utf8');
      return new Map(JSON.parse(data).map(chat => [chat.phone, chat]));
    }
  } catch (error) {
    console.error(`Error loading chats for session ${sessionId}:`, error.message);
  }
  return new Map();
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
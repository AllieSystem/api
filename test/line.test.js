import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { classifyClose, reconnectDelayMs } from '../src/sessions/connectionPolicy.js';
import { createBackup, restoreBackup } from '../src/utils/backup.js';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-line-'));
process.env.NODE_ENV = 'test';
process.env.AUTH_ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.AUTH_DIR = path.join(tempRoot, 'auth');
process.env.SECRETS_DIR = path.join(tempRoot, 'secrets');
process.env.AUTH_KEYS_FILE = path.join(tempRoot, 'auth', 'keys.json');
process.env.AUTH_USERS_FILE = path.join(tempRoot, 'auth', 'panel-users.json');
process.env.AUTH_SESSIONS_FILE = path.join(tempRoot, 'auth', 'panel-sessions.json');
delete process.env.ALERT_WEBHOOK_URL;

function closeUpdate(statusCode, reason) {
  return {
    connection: 'close',
    lastDisconnect: {
      error: {
        message: reason,
        output: { statusCode, payload: {}, headers: {} },
      },
    },
  };
}

test('la espera de reconexión crece y se detiene en 30s', () => {
  assert.equal(reconnectDelayMs(1, () => 0), 2000);
  assert.equal(reconnectDelayMs(2, () => 0), 4000);
  assert.equal(reconnectDelayMs(3, () => 0), 8000);
  assert.equal(reconnectDelayMs(4, () => 0), 16000);
  assert.equal(reconnectDelayMs(5, () => 0), 30000);
  assert.equal(reconnectDelayMs(8, () => 0), 30000);
  assert.equal(reconnectDelayMs(1, () => 1), 2400);
});

test('solo un rechazo terminal detiene la línea', () => {
  for (const code of [401, 403, 411, 440, 500]) {
    const decision = classifyClose({ statusCode: code, reason: 'cerrado' });
    assert.equal(decision.action, 'stop');
    assert.equal(decision.status, 'needs_repair');
  }
  assert.equal(classifyClose({ reason: 'BadSession' }).action, 'stop');
  assert.equal(classifyClose({ reason: 'invalid_mechanisms' }).action, 'stop');

  for (const code of [408, 428, 405, 503, undefined]) {
    assert.equal(classifyClose({ statusCode: code, reason: 'caida' }).action, 'reconnect');
  }
  const restart = classifyClose({ statusCode: 515, reason: 'restart required' });
  assert.equal(restart.action, 'reconnect');
  assert.equal(restart.delayMs, 2000);
});

test('una copia no incluye la llave y se puede restaurar', () => {
  const authDir = path.join(tempRoot, 'backup-auth');
  const dataDir = path.join(tempRoot, 'backup-data');
  const secretsDir = path.join(tempRoot, 'backup-secrets');
  fs.mkdirSync(authDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(secretsDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, 'creds.json'), '{"whub":1}');
  fs.writeFileSync(path.join(dataDir, 'chats.json'), '{"whub":1,"data":"abc"}');
  fs.writeFileSync(path.join(secretsDir, 'auth.key'), 'llave-secreta');

  const dest = createBackup({
    authDir,
    dataDir,
    backupRoot: path.join(tempRoot, 'backups'),
    now: new Date('2026-10-14T12:00:00.000Z'),
  });

  const note = fs.readFileSync(path.join(dest, 'README.txt'), 'utf8');
  assert.match(note, /AUTH_ENCRYPTION_KEY/);
  assert.equal(fs.existsSync(path.join(dest, 'secrets', 'auth.key')), false);
  assert.equal(fs.readFileSync(path.join(dest, 'data', 'chats.json'), 'utf8').includes('llave-secreta'), false);

  fs.rmSync(dataDir, { recursive: true, force: true });
  restoreBackup(dest, { authDir, dataDir });
  assert.equal(fs.readFileSync(path.join(dataDir, 'chats.json'), 'utf8'), '{"whub":1,"data":"abc"}');
});

test('una caída recuperable reconecta y el historial queda cifrado', async () => {
  const { loadEncryptionKey } = await import('../src/utils/secrets.js');
  const { createDataFolder, getChatsFile, loadChats } = await import('../src/utils/storage.js');
  const { WhatsAppSession } = await import('../src/sessions/WhatsAppSession.js');
  const { SessionManager } = await import('../src/sessions/SessionManager.js');
  loadEncryptionKey();

  const session = new WhatsAppSession('line0001', null, {});
  let loggedOut = false;
  session.logout = async () => {
    loggedOut = true;
  };
  session.sock = { end() {}, ev: { removeAllListeners() {} } };
  session.pairingCode = 'ABCD1234';
  session._handleConnectionUpdate(closeUpdate(515, 'Stream Errored (restart required)'));
  assert.equal(loggedOut, false);
  assert.equal(session.status, 'reconnecting');
  assert.equal(session.reconnectAttempt, 1);
  assert.ok(session.reconnectTimer);
  const firstTimer = session.reconnectTimer;

  session.sock = { end() {}, ev: { removeAllListeners() {} } };
  session._handleConnectionUpdate(closeUpdate(408, 'Connection Lost'));
  assert.equal(session.reconnectAttempt, 1);
  assert.equal(session.reconnectTimer, firstTimer);

  session.socketGeneration = 1;
  session.sock = { end() {}, ev: { removeAllListeners() {} } };
  session._handleConnectionUpdate(closeUpdate(408, 'Connection Lost'));
  assert.equal(session.status, 'reconnecting');
  assert.equal(session.reconnectAttempt, 2);
  assert.notEqual(session.reconnectTimer, firstTimer);
  clearTimeout(session.reconnectTimer);
  session.reconnectTimer = null;

  session.socketGeneration = 2;
  session.sock = { end() {}, ev: { removeAllListeners() {} } };
  session._handleConnectionUpdate(closeUpdate(401, 'Connection Failure'));
  assert.equal(loggedOut, false);
  assert.equal(session.status, 'needs_repair');
  assert.equal(session.reconnectTimer, null);

  createDataFolder(session.sessionId);
  session.status = 'connected';
  session._handleMessages([{
    key: { id: 'm1', remoteJid: '50611111111@s.whatsapp.net', fromMe: false },
    message: { conversation: 'hola linea' },
    messageTimestamp: Math.floor(Date.now() / 1000),
  }]);
  await session._saveChain;
  const stored = fs.readFileSync(getChatsFile(session.sessionId), 'utf8');
  const envelope = JSON.parse(stored);
  assert.equal(envelope.whub, 1);
  assert.equal(Array.isArray(envelope), false);

  const backup = createBackup({
    authDir: process.env.AUTH_DIR,
    dataDir: process.env.DATA_DIR,
    backupRoot: path.join(tempRoot, 'live-backups'),
    now: new Date('2026-10-14T12:05:00.000Z'),
  });
  fs.rmSync(getChatsFile(session.sessionId), { force: true });
  restoreBackup(backup, {
    authDir: process.env.AUTH_DIR,
    dataDir: process.env.DATA_DIR,
  });
  const loaded = loadChats(session.sessionId);
  const chat = Array.from(loaded.values())[0];
  assert.equal(chat.messages[0].text, 'hola linea');

  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      hits.push(JSON.parse(body));
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${server.address().port}/hook`;
  const manager = new SessionManager();
  clearInterval(manager._watchdog);
  await new Promise((resolve) => setImmediate(resolve));

  manager.sessions.set('quiet', {
    sessionId: 'quiet',
    status: 'reconnecting',
    reconnectAttempt: 4,
    lastDisconnect: { statusCode: 408 },
  });
  await manager._watchLines();
  assert.equal(hits.length, 0);

  manager.sessions.set('down', {
    sessionId: 'down',
    status: 'reconnecting',
    reconnectAttempt: 5,
    lastDisconnect: { statusCode: 408 },
  });
  await manager._watchLines();
  await manager._watchLines();
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, 'down');
  assert.equal(hits[0].status, 'reconnecting');
  assert.equal(Object.hasOwn(hits[0], 'phoneNumber'), false);
  assert.equal(Object.hasOwn(hits[0], 'message'), false);

  delete process.env.ALERT_WEBHOOK_URL;
  await new Promise((resolve) => server.close(resolve));
});

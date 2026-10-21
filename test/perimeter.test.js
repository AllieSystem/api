import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-perimeter-'));
process.env.NODE_ENV = 'test';
process.env.AUTH_DIR = tmp;
process.env.AUTH_KEYS_FILE = path.join(tmp, 'keys.json');
process.env.AUTH_USERS_FILE = path.join(tmp, 'panel-users.json');
process.env.AUTH_SESSIONS_FILE = path.join(tmp, 'panel-sessions.json');
process.env.SECRETS_DIR = path.join(tmp, 'secrets');
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.AUTH_ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.PANEL_USERNAME = 'admin';
process.env.PANEL_PASSWORD = 'test-password-1234';
process.env.CORS_ORIGIN = 'http://localhost:3000';

const secrets = await import('../src/utils/secrets.js');
const auth = await import('../src/middleware/auth.js');
const configModule = await import('../src/config/config.js');
const helpers = await import('../src/utils/helpers.js');
const storage = await import('../src/utils/storage.js');

test('cifrado reversible y archivo legado se migra', () => {
  const key = secrets.deriveEncryptionKey(process.env.AUTH_ENCRYPTION_KEY);
  const plain = JSON.stringify({ noiseKey: { type: 'Buffer', data: 'AQID' } });
  const encrypted = secrets.encryptString(plain, key);
  assert.equal(secrets.decryptString(encrypted, key), plain);
  assert.equal(encrypted.includes('AQID'), false);

  const legacyPath = path.join(tmp, 'legacy.json');
  fs.writeFileSync(legacyPath, plain);
  secrets.writeEncryptedFileSync(legacyPath, plain, key);
  const stored = fs.readFileSync(legacyPath, 'utf8');
  assert.equal(stored.includes('noiseKey'), false);
  assert.equal(secrets.decryptString(stored, key), plain);
  assert.equal(fs.existsSync(`${legacyPath}.bak`), false);
});

test('la API key se guarda como hash y la contraseña abre sesión', () => {
  const plainKey = 'sk_live_test_key_value_1234567890';
  fs.writeFileSync(process.env.AUTH_KEYS_FILE, JSON.stringify({
    version: '1.0',
    keys: [{ id: 'key_001', key: plainKey, name: 'Admin', active: true, permissions: ['*'] }],
  }));

  const loaded = auth.loadKeys();
  assert.equal(loaded.keys[0].key, undefined);
  assert.equal(typeof loaded.keys[0].keyHash, 'string');
  assert.equal(auth.verifyApiKey(plainKey), true);
  assert.equal(auth.verifyApiKey('sk_live_wrong'), false);
  assert.equal(fs.readFileSync(process.env.AUTH_KEYS_FILE, 'utf8').includes(plainKey), false);

  auth.ensurePanelUser();
  const session = auth.authenticatePanel('admin', process.env.PANEL_PASSWORD);
  assert.ok(session?.token);
  assert.equal(auth.authenticatePanel('admin', 'no-es-la-clave'), null);

  const socketToken = auth.createSocketToken({
    id: 'ses_test',
    userId: 'user_test',
    username: 'admin',
  });
  assert.equal(auth.verifySocketToken(socketToken.token)?.username, 'admin');
  assert.equal(auth.verifySocketToken(session.token), null);
});

test('el historial en disco no queda en claro', () => {
  const sessionId = 'sess1234';
  const legacyFile = path.join(process.env.DATA_DIR, sessionId, 'chats.json');
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
  fs.writeFileSync(legacyFile, JSON.stringify([
    { phone: '5512345678', name: 'Ada', messages: [{ id: 'm1', text: 'hola secreto' }] },
  ]));

  const loaded = storage.loadChats(sessionId);
  assert.equal(loaded.get('5512345678').messages[0].text, 'hola secreto');
  const stored = fs.readFileSync(legacyFile, 'utf8');
  assert.equal(stored.includes('hola secreto'), false);
  assert.equal(JSON.parse(stored).whub, 1);
});

test('CORS abierto no se acepta en producción', () => {
  assert.deepEqual(configModule.resolveAllowedOrigins('*', 'production'), []);
  assert.deepEqual(configModule.resolveAllowedOrigins('http://localhost:3000', 'production'), ['http://localhost:3000']);
});

test('la respuesta pública no incluye llaves de medios', () => {
  const message = helpers.toPublicMessage({
    id: '1',
    text: 'foto',
    mediaKey: 'secret-key',
    mediaUrl: 'https://media.example/file',
    mediaDirectPath: '/v/path',
    mediaThumbnail: 'abc',
  });
  assert.equal(message.mediaKey, undefined);
  assert.equal(message.mediaUrl, undefined);
  assert.equal(message.mediaDirectPath, undefined);
  assert.equal(message.mediaThumbnail, 'abc');
});

test('un credencial de Baileys en claro se puede leer después de cifrarlo', async () => {
  const { useEncryptedAuthState } = await import('../src/utils/encryptedAuthState.js');
  const { initAuthCreds, BufferJSON } = await import('@whiskeysockets/baileys');
  const folder = path.join(tmp, 'baileys-session');
  fs.mkdirSync(folder);
  const creds = initAuthCreds();
  fs.writeFileSync(path.join(folder, 'creds.json'), JSON.stringify(creds, BufferJSON.replacer));

  const first = await useEncryptedAuthState(folder);
  assert.equal(first.state.creds.registrationId, creds.registrationId);
  const stored = fs.readFileSync(path.join(folder, 'creds.json'), 'utf8');
  assert.equal(JSON.parse(stored).whub, 1);
  assert.equal(stored.includes('registrationId'), false);

  const second = await useEncryptedAuthState(folder);
  assert.equal(second.state.creds.registrationId, creds.registrationId);
});

test('un rechazo 401 no borra credenciales ni historial', async () => {
  const { WhatsAppSession } = await import('../src/sessions/WhatsAppSession.js');
  const session = new WhatsAppSession('keep1234', null, {});
  let loggedOut = false;
  let closed = false;
  session.logout = async () => {
    loggedOut = true;
  };
  session.sock = { end() { closed = true; } };
  session._handleConnectionUpdate({
    connection: 'close',
    lastDisconnect: {
      error: {
        isBoom: true,
        message: 'Connection Failure',
        output: { statusCode: 401, payload: {}, headers: {} },
        data: { reason: '401' },
      },
    },
  });
  assert.equal(loggedOut, false);
  assert.equal(closed, true);
  assert.equal(session.status, 'needs_repair');
  assert.equal(session.reconnectTimer, null);
});

test('HTTP exige sesión o API key', async () => {
  auth.ensurePanelUser();
  const session = auth.authenticatePanel('admin', process.env.PANEL_PASSWORD);
  const app = express();
  app.get('/secret', auth.authMiddleware, (req, res) => {
    res.json({ name: req.principal.name });
  });
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const anonymous = await fetch(`http://127.0.0.1:${port}/secret`);
    assert.equal(anonymous.status, 401);
    const authed = await fetch(`http://127.0.0.1:${port}/secret`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    assert.equal(authed.status, 200);
    const body = await authed.json();
    assert.equal(body.name, 'admin');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import fs from 'fs';
import crypto from 'crypto';

import config from './config/config.js';
import { logger, logApiRequest } from './utils/logger.js';
import { ensureBaseDirs } from './utils/storage.js';
import { authMiddleware, rateLimitMiddleware, errorHandler, notFoundHandler } from './middleware/index.js';
import { getSessionManager } from './routes/sessions.js';
import { ensurePanelUser, hasPermission, loadKeys, requireRequestPermission } from './middleware/auth.js';
import { socketAuthMiddleware } from './middleware/socketAuth.js';
import authRouter, { publicAuthRouter } from './routes/auth.js';
import { loadEncryptionKey } from './utils/secrets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

const io = new Server(server, {
  cors: {
    origin: config.cors.origins,
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['polling', 'websocket'],
  allowEIO3: true,
  pingTimeout: config.socket.pingTimeout,
  pingInterval: config.socket.pingInterval
});

ensureBaseDirs();
loadEncryptionKey();
ensurePanelUser();
if (config.cors.origins.length === 0) {
  logger.warn('CORS sin orígenes permitidos. Define CORS_ORIGIN con el origen exacto del panel.');
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(cors({
  origin(origin, callback) {
    if (!origin || config.cors.origins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  methods: config.cors.methods,
  allowedHeaders: config.cors.allowedHeaders,
  credentials: true,
}));
app.use(express.json({ limit: config.app.maxRequestSize }));
app.use(express.urlencoded({ extended: true, limit: config.app.maxRequestSize }));

app.use((req, res, next) => {
  req.startTime = Date.now();
  next();
});

app.get('/api/health', (_req, res) => {
  const sessions = getSessionManager().listSessions();
  const counts = { total: sessions.length, connected: 0, waiting: 0, down: 0 };
  for (const session of sessions) {
    if (session.status === 'connected') counts.connected += 1;
    else if (session.status === 'waiting_qr' || session.status === 'waiting_pairing') counts.waiting += 1;
    else counts.down += 1;
  }
  res.json({
    success: true,
    status: counts.down > 0 ? 'degraded' : 'healthy',
    version: config.app.version,
    uptime: process.uptime(),
    sessions: counts,
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/auth', publicAuthRouter);
app.use('/api', authMiddleware);
app.use('/api', rateLimitMiddleware({
  maxRequests: config.rateLimit.maxRequests,
  windowMs: config.rateLimit.windowMs,
}));

app.use('/api/auth', authRouter);

if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

app.get('/api/status', (req, res) => {
  if (!hasPermission(req.principal, 'sessions:read')) {
    return res.status(403).json({
      success: false,
      error: 'Permiso insuficiente',
      code: 'FORBIDDEN',
    });
  }
  const sessionManager = getSessionManager();
  const sessions = sessionManager.listSessions();
  const keysData = loadKeys();

  res.json({
    success: true,
    data: {
      api: {
        name: config.app.name,
        version: config.app.version,
        environment: config.app.env,
      },
      sessions: {
        count: sessions.length,
        list: sessions.map(s => ({
          sessionId: s.sessionId,
          status: s.status,
        })),
      },
      keys: {
        count: keysData.keys.filter(k => k.active).length,
      },
    },
  });
});

const sessionManager = getSessionManager();
sessionManager.setSocketIO(io);

initSessionRoutes(app, sessionManager);

app.use((req, res, next) => {
  const duration = Date.now() - req.startTime;
  logApiRequest(req, res, duration);
  next();
});

app.use(notFoundHandler);
app.use(errorHandler);

io.on('error', (error) => {
  logger.error({ error: error.message }, 'Socket.io Server Error');
});

io.use(socketAuthMiddleware);

io.on('connection', (socket) => {
  logger.info({ socketId: socket.id, ip: socket.handshake.address }, 'Socket connected');

  socket.on('join_session', (sessionId) => {
    if (!socket.data.user) {
      socket.emit('error', { message: 'No autenticado' });
      return;
    }
    if (sessionManager.sessionExists(sessionId)) {
      socket.join(sessionId);
      socket.sessionId = sessionId;
      logger.info({ socketId: socket.id, sessionId }, 'Joined session room');

      const session = sessionManager.sessions.get(sessionId);
      socket.emit('status', { value: session.status, sessionId });
    } else {
      socket.emit('error', { message: `Sesión ${sessionId} no encontrada` });
    }
  });

  socket.on('leave_session', (sessionId) => {
    const targetSessionId = sessionId || socket.sessionId;
    if (targetSessionId) {
      socket.leave(targetSessionId);
      logger.info({ socketId: socket.id, sessionId: targetSessionId }, 'Left session room');
      if (targetSessionId === socket.sessionId) {
        socket.sessionId = null;
      }
    }
  });

  socket.on('disconnect', () => {
    logger.info({ socketId: socket.id }, 'Socket disconnected');
  });
});

const sessionPattern = /^\/session\/([^\/]+)$/;
io.of(sessionPattern).use(socketAuthMiddleware);

io.of(sessionPattern).on('connection', (socket) => {
  const match = socket.nsp.name.match(sessionPattern);
  const sessionId = match ? match[1] : null;

  if (!sessionId) {
    logger.warn({ nsp: socket.nsp.name }, 'Connection attempt to invalid session namespace');
    socket.disconnect();
    return;
  }

  if (!sessionManager.sessionExists(sessionId)) {
    logger.warn({ sessionId }, 'Session-specific socket attempt for non-existent session');
    socket.emit('error', { message: `Sesión ${sessionId} no encontrada` });
    setTimeout(() => socket.disconnect(), 1000);
    return;
  }

  logger.info({ socketId: socket.id, sessionId }, 'Session-specific socket connected');
  
  // Enviar estado inicial
  try {
    const sessionStatus = sessionManager.getSessionStatus(sessionId);
    socket.emit('status', { value: sessionStatus.status, sessionId });

    if (sessionStatus.pairingCode) {
      socket.emit('pairing_code', {
        code: sessionStatus.pairingCode,
        phone: sessionStatus.phoneNumber,
        sessionId
      });
    }

    if (sessionStatus.hasQR && sessionStatus.status === 'waiting_qr') {
      socket.emit('qr', { value: sessionStatus.qrCode, sessionId });
    }
  } catch (error) {
    logger.error({ sessionId, error: error.message }, 'Error sending initial session status via socket');
  }

  socket.on('disconnect', () => {
    logger.info({ socketId: socket.id, sessionId }, 'Session socket disconnected');
  });
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  await sessionManager.shutdown();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully...');
  await sessionManager.shutdown();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

function initSessionRoutes(app, sessionManager) {
  const sessionsRouter = express.Router();
  sessionsRouter.use(requireRequestPermission);

  const uploadStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = config.app.uploadsDir;
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = crypto.randomBytes(8).toString('hex');
      const baseName = path.basename(file.originalname || 'archivo')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(0, 80) || 'archivo';
      cb(null, `${uniqueSuffix}-${baseName}`);
    },
  });
  const upload = multer({ storage: uploadStorage, limits: { fileSize: 50 * 1024 * 1024 } });

  sessionsRouter.get('/', (req, res) => {
    const sessions = sessionManager.listSessions();
    res.json({ success: true, data: sessions, count: sessions.length });
  });

  sessionsRouter.post('/', async (req, res) => {
    const { phoneNumber, options } = req.body || {};
    try {
      const result = await sessionManager.createSession(phoneNumber, options || {});
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      logger.error(`Error creating session: ${error.message}`);
      res.status(400).json({ success: false, error: error.message });
    }
  });

  sessionsRouter.get('/:id', (req, res) => {
    const { id } = req.params;
    if (!sessionManager.sessionExists(id)) {
      return res.status(404).json({ success: false, error: `Sesión ${id} no encontrada` });
    }
    const status = sessionManager.getSessionStatus(id);
    res.json({ success: true, data: status });
  });

  sessionsRouter.delete('/:id', async (req, res) => {
    const { id } = req.params;
    if (!sessionManager.sessionExists(id)) {
      return res.status(404).json({ success: false, error: `Sesión ${id} no encontrada` });
    }
    try {
      const result = await sessionManager.deleteSession(id);
      res.json({ success: true, data: result });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  sessionsRouter.get('/:id/status', (req, res) => {
    const { id } = req.params;
    if (!sessionManager.sessionExists(id)) {
      return res.status(404).json({ success: false, error: `Sesión ${id} no encontrada` });
    }
    const status = sessionManager.getSessionStatus(id);
    res.json({ success: true, data: status });
  });

  sessionsRouter.post('/:id/pairing', async (req, res) => {
    const { id } = req.params;
    const { phone } = req.body || {};

    if (!sessionManager.sessionExists(id)) {
      return res.status(404).json({ success: false, error: `Sesión ${id} no encontrada` });
    }
    if (!phone) {
      return res.status(400).json({ success: false, error: 'Número de teléfono requerido' });
    }

    try {
      const code = await sessionManager.requestPairingCode(id, phone);
      res.json({ success: true, data: { code, phone } });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  sessionsRouter.post('/:id/logout', async (req, res) => {
    const { id } = req.params;
    if (!sessionManager.sessionExists(id)) {
      return res.status(404).json({ success: false, error: `Sesión ${id} no encontrada` });
    }
    try {
      const result = await sessionManager.logoutSession(id);
      res.json({ success: true, data: result });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  sessionsRouter.post('/:id/send', async (req, res) => {
    const { id } = req.params;
    const { phone, message } = req.body || {};

    if (!sessionManager.sessionExists(id)) {
      return res.status(404).json({ success: false, error: `Sesión ${id} no encontrada` });
    }
    if (!phone || !message) {
      return res.status(400).json({ success: false, error: 'Número y mensaje son requeridos' });
    }

    try {
      const result = await sessionManager.sendMessage(id, phone, message);
      res.json({ success: true, data: result });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  sessionsRouter.get('/:id/chats', (req, res) => {
    const { id } = req.params;
    if (!sessionManager.sessionExists(id)) {
      return res.status(404).json({ success: false, error: `Sesión ${id} no encontrada` });
    }
    const chats = sessionManager.getChats(id);
    res.json({ success: true, data: chats, count: chats.length });
  });

  sessionsRouter.get('/:id/chats/:phone', (req, res) => {
    const { id, phone } = req.params;
    if (!sessionManager.sessionExists(id)) {
      return res.status(404).json({ success: false, error: `Sesión ${id} no encontrada` });
    }
    const chat = sessionManager.getChat(id, phone);
    if (!chat) {
      return res.status(404).json({ success: false, error: `Chat ${phone} no encontrado` });
    }
    res.json({ success: true, data: chat });
  });

  sessionsRouter.get('/:id/download/:messageId', async (req, res) => {
    const { id, messageId } = req.params;
    if (!sessionManager.sessionExists(id)) {
      return res.status(404).json({ success: false, error: `Sesión ${id} no encontrada` });
    }
    try {
      const media = await sessionManager.downloadMedia(id, messageId);
      const safeFileName = String(media.fileName || 'archivo').replace(/[\r\n"]/g, '');
      res.setHeader('Content-Type', media.mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}"`);
      res.send(media.buffer);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  sessionsRouter.get('/:id/chats/:phone/messages', (req, res) => {
    const { id, phone } = req.params;
    if (!sessionManager.sessionExists(id)) {
      return res.status(404).json({ success: false, error: `Sesión ${id} no encontrada` });
    }
    const messages = sessionManager.getChatMessages(id, phone);
    res.json({ success: true, data: messages, count: messages.length });
  });

  sessionsRouter.post('/:id/send-with-files', upload.array('files', 10), async (req, res) => {
    const { id } = req.params;
    const { phone, message } = req.body || {};
    const files = req.files || [];

    if (!sessionManager.sessionExists(id)) {
      return res.status(404).json({ success: false, error: `Sesión ${id} no encontrada` });
    }
    if (!phone) {
      return res.status(400).json({ success: false, error: 'Número de teléfono requerido' });
    }
    if (files.length === 0 && !message) {
      return res.status(400).json({ success: false, error: 'Se requiere al menos un archivo o mensaje' });
    }

    try {
      const result = await sessionManager.sendMessageWithFiles(id, phone, message || '', files);
      res.json({ success: true, data: result });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    } finally {
      for (const file of files) {
        try {
          if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        } catch (e) {
          logger.warn(`Error cleaning file: ${e.message}`);
        }
      }
    }
  });

  app.use('/api/sessions', sessionsRouter);
}

const PORT = config.app.port;
const HOST = config.app.host;

server.listen(PORT, HOST, () => {
  logger.info(`

  ***   MV WhatsApp Hub API Server    ***
  Version:    ${config.app.version.padEnd(32)}
  Env:       ${config.app.env.padEnd(32)}
  URL:       http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}
  API keys:  ${String(loadKeys().keys.filter((entry) => entry.active).length).padEnd(32)}

  `);
});

export { app, server, io };
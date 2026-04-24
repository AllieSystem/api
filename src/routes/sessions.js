import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { SessionManager } from '../sessions/index.js';
import { asyncHandler, createError } from '../middleware/index.js';
import { logger } from '../utils/logger.js';
import config from '../config/config.js';

const router = Router();
const sessionManager = new SessionManager();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = config.app.uploadsDir;
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = crypto.randomBytes(8).toString('hex');
    cb(null, uniqueSuffix + '-' + file.originalname);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
});

export function getSessionManager() {
  return sessionManager;
}

export function initSessionRoutes(app) {
  app.use('/sessions', router);
}

router.get('/', asyncHandler(async (req, res) => {
  const sessions = sessionManager.listSessions();
  res.json({
    success: true,
    data: sessions,
    count: sessions.length,
  });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { phoneNumber, options } = req.body || {};

  logger.info({ phoneNumber, options }, 'Creating session');
  try {
    const result = await sessionManager.createSession(phoneNumber, options || {});
    logger.info({ sessionId: result.sessionId }, 'Session created successfully');
    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error(`Error creating session: ${error.message}`);
    throw createError(error.message);
  }
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!sessionManager.sessionExists(id)) {
    throw createError(`Sesión ${id} no encontrada`, 404);
  }

  const status = sessionManager.getSessionStatus(id);
  res.json({
    success: true,
    data: status,
  });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!sessionManager.sessionExists(id)) {
    throw createError(`Sesión ${id} no encontrada`, 404);
  }

  const result = await sessionManager.deleteSession(id);
  res.json({
    success: true,
    data: result,
  });
}));

router.get('/:id/status', asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!sessionManager.sessionExists(id)) {
    throw createError(`Sesión ${id} no encontrada`, 404);
  }

  const status = sessionManager.getSessionStatus(id);
  res.json({
    success: true,
    data: status,
  });
}));

router.post('/:id/pairing', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { phone } = req.body || {};

  if (!sessionManager.sessionExists(id)) {
    throw createError(`Sesión ${id} no encontrada`, 404);
  }

  if (!phone) {
    throw createError('Número de teléfono requerido');
  }

  const code = await sessionManager.requestPairingCode(id, phone);
  res.json({
    success: true,
    data: { code, phone },
  });
}));

router.post('/:id/logout', asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!sessionManager.sessionExists(id)) {
    throw createError(`Sesión ${id} no encontrada`, 404);
  }

  const result = await sessionManager.logoutSession(id);
  res.json({
    success: true,
    data: result,
  });
}));

router.post('/:id/send', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { phone, message } = req.body || {};

  if (!sessionManager.sessionExists(id)) {
    throw createError(`Sesión ${id} no encontrada`, 404);
  }

  if (!phone || !message) {
    throw createError('Número y mensaje son requeridos');
  }

  const result = await sessionManager.sendMessage(id, phone, message);
  res.json({
    success: true,
    data: result,
  });
}));

router.post('/:id/send-with-files', upload.array('files', 10), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { phone, message } = req.body || {};
  const files = req.files || [];

  if (!sessionManager.sessionExists(id)) {
    throw createError(`Sesión ${id} no encontrada`, 404);
  }

  if (!phone) {
    throw createError('Número de teléfono requerido');
  }

  if (files.length === 0 && !message) {
    throw createError('Se requiere al menos un archivo o mensaje');
  }

  const result = await sessionManager.sendMessageWithFiles(id, phone, message || '', files);
  res.json({
    success: true,
    data: result,
  });

  for (const file of files) {
    try {
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
    } catch (e) {
      logger.warn(`Error cleaning file: ${e.message}`);
    }
  }
}));

router.get('/:id/check/:phone', asyncHandler(async (req, res) => {
  const { id, phone } = req.params;

  if (!sessionManager.sessionExists(id)) {
    throw createError(`Sesión ${id} no encontrada`, 404);
  }

  const result = await sessionManager.checkNumber(id, phone);
  res.json({
    success: true,
    data: result,
  });
}));

router.get('/:id/chats', asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!sessionManager.sessionExists(id)) {
    throw createError(`Sesión ${id} no encontrada`, 404);
  }

  const chats = sessionManager.getChats(id);
  res.json({
    success: true,
    data: chats,
    count: chats.length,
  });
}));

router.get('/:id/chats/:phone', asyncHandler(async (req, res) => {
  const { id, phone } = req.params;

  if (!sessionManager.sessionExists(id)) {
    throw createError(`Sesión ${id} no encontrada`, 404);
  }

  const chat = sessionManager.getChat(id, phone);
  if (!chat) {
    throw createError(`Chat ${phone} no encontrado`, 404);
  }

  res.json({
    success: true,
    data: chat,
  });
}));

router.get('/:id/chats/:phone/messages', asyncHandler(async (req, res) => {
  const { id, phone } = req.params;

  if (!sessionManager.sessionExists(id)) {
    throw createError(`Sesión ${id} no encontrada`, 404);
  }

  const messages = sessionManager.getChatMessages(id, phone);
  res.json({
    success: true,
    data: messages,
    count: messages.length,
  });
}));

router.get('/:id/download/:messageId', asyncHandler(async (req, res) => {
  const { id, messageId } = req.params;

  if (!sessionManager.sessionExists(id)) {
    throw createError(`Sesión ${id} no encontrada`, 404);
  }

  const media = await sessionManager.downloadMedia(id, messageId);

  const safeFileName = media.fileName.replace(/"/g, '""');
  res.setHeader('Content-Type', media.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}"`);
  res.send(media.buffer);
}));

export default router;
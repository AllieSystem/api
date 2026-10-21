import { WhatsAppSession } from './WhatsAppSession.js';
import { createAuthFolder, createDataFolder, deleteSessionFolders, saveChats, loadChats } from '../utils/storage.js';
import { generateSessionId, createApiResponse, toPublicMessage } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import config from '../config/config.js';
import fs from 'fs';
import path from 'path';

export class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.io = null;
    this.sessionsMetaFile = path.join(config.data.dir, 'sessions_meta.json');
    this._restoreSessionsOnStartup().finally(() => {
      this._watchLines().catch((error) => {
        logger.warn(`No se pudo revisar las líneas: ${error.message}`);
      });
    });
    this._watchdog = setInterval(() => {
      this._watchLines().catch((error) => {
        logger.warn(`No se pudo revisar las líneas: ${error.message}`);
      });
    }, 60_000);
    this._watchdog.unref?.();
  }

  setSocketIO(io) {
    this.io = io;
    for (const session of this.sessions.values()) {
      session.setSocketIO(io);
    }
  }

  async _restoreSessionsOnStartup() {
    try {
      if (!fs.existsSync(this.sessionsMetaFile)) return;

      const raw = fs.readFileSync(this.sessionsMetaFile, 'utf-8');
      const meta = JSON.parse(raw);
      const sessionIds = meta.sessions || [];

      logger.info(`Restaurando ${sessionIds.length} sesión(es) guardada(s)...`);

      for (const sessionId of sessionIds) {
        try {
          if (this.sessions.has(sessionId)) continue;
          const session = new WhatsAppSession(sessionId, null, {});
          await session.connect();
          this.sessions.set(sessionId, session);
          logger.info(`Sesión ${sessionId} restaurada correctamente`);
        } catch (err) {
          logger.warn(`No se pudo restaurar la sesión ${sessionId}: ${err.message}`);
        }
      }
    } catch (error) {
      logger.error(`Error en _restoreSessionsOnStartup: ${error.message}`);
    }
  }

  async createSession(phoneNumber = null, options = {}) {
    let sessionId = options.sessionId || generateSessionId();
    sessionId = sessionId.substring(0, 8);

    if (this.sessions.has(sessionId)) {
      throw new Error(`La sesión ${sessionId} ya existe`);
    }

    logger.info(`Creating new session: ${sessionId}, phone: ${phoneNumber}`);

    const session = new WhatsAppSession(sessionId, phoneNumber, {
      ...options,
      freshAuth: Boolean(phoneNumber),
    });
    
    if (this.io) {
      session.setSocketIO(this.io);
    }

    await session.connect();
    this.sessions.set(sessionId, session);

    this._saveSessionsMeta();

    return {
      sessionId,
      phoneNumber,
      status: session.status,
      createdAt: new Date().toISOString(),
    };
  }

  async getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Sesión ${sessionId} no encontrada`);
    }
    return session;
  }

  sessionExists(sessionId) {
    return this.sessions.has(sessionId);
  }

  async deleteSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Sesión ${sessionId} no encontrada`);
    }

    await session.logout();
    this.sessions.delete(sessionId);

    this._saveSessionsMeta();

    logger.info(`Session ${sessionId} deleted`);
    return { success: true, message: `Sesión ${sessionId} eliminada` };
  }

  listSessions() {
    return Array.from(this.sessions.values()).map(session => ({
      sessionId: session.sessionId,
      phoneNumber: session.phoneNumber,
      status: session.status,
      connectedAt: session.connectedAt,
      botPhoneNormalized: session.botPhoneNormalized,
      reconnectAttempt: session.reconnectAttempt || 0,
      nextReconnectAt: session.nextReconnectAt || null,
      lastDisconnect: session.lastDisconnect || null,
    }));
  }

  getSessionStatus(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Sesión ${sessionId} no encontrada`);
    }
    return session.getStatus();
  }

  async requestPairingCode(sessionId, phone) {
    const session = await this.getSession(sessionId);
    return await session.requestPairingCode(phone);
  }

  async sendMessage(sessionId, phone, message) {
    const session = await this.getSession(sessionId);
    return await session.sendMessage(phone, message);
  }

  async sendMessageWithFiles(sessionId, phone, message, files) {
    const session = await this.getSession(sessionId);
    return await session.sendMessageWithFiles(phone, message, files);
  }

  async checkNumber(sessionId, phone) {
    const session = await this.getSession(sessionId);
    return await session.checkNumber(phone);
  }

  getChats(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Sesión ${sessionId} no encontrada`);
    }
    return session.getChats();
  }

  getChat(sessionId, phone) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Sesión ${sessionId} no encontrada`);
    }
    const chat = session.getChat(phone);
    if (!chat) return null;
    return {
      phone: chat.phone,
      name: chat.name,
      timestamp: chat.timestamp,
      lastMessage: toPublicMessage(chat.lastMessage),
      messageCount: chat.messages?.length || 0,
      messages: (chat.messages || []).map(toPublicMessage),
    };
  }

  getChatMessages(sessionId, phone) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Sesión ${sessionId} no encontrada`);
    }
    return session.getChatMessages(phone).map(toPublicMessage);
  }

  async downloadMedia(sessionId, messageId) {
    const session = await this.getSession(sessionId);
    return await session.downloadMedia(messageId);
  }

  async logoutSession(sessionId) {
    const session = await this.getSession(sessionId);
    await session.logout();
    this.sessions.delete(sessionId);
    this._saveSessionsMeta();
    return { success: true, message: 'Sesión cerrada' };
  }

  _lineNeedsAlert(session) {
    return session.status === 'needs_repair'
      || session.status === 'failed'
      || (session.status === 'reconnecting' && session.reconnectAttempt >= 5);
  }

  async _watchLines() {
    const tasks = [];
    for (const session of this.sessions.values()) {
      if (!this._lineNeedsAlert(session)) {
        session._alertSignature = '';
        continue;
      }
      const signature = `${session.status}:${session.reconnectAttempt}:${session.lastDisconnect?.statusCode || ''}`;
      if (session._alertSignature === signature) continue;
      session._alertSignature = signature;
      logger.error({
        sessionId: session.sessionId,
        status: session.status,
        attempt: session.reconnectAttempt,
        lastDisconnect: session.lastDisconnect,
      }, 'La línea de WhatsApp no está activa');
      tasks.push(this._notifyDown(session));
    }
    await Promise.all(tasks);
  }

  async _notifyDown(session) {
    const url = process.env.ALERT_WEBHOOK_URL;
    if (!url) return;
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: session.sessionId,
          status: session.status,
          attempt: session.reconnectAttempt || 0,
          at: new Date().toISOString(),
        }),
      });
    } catch (error) {
      logger.warn(`No se pudo enviar la alerta: ${error.message}`);
    }
  }

  async shutdown() {
    if (this._watchdog) {
      clearInterval(this._watchdog);
      this._watchdog = null;
    }
    logger.info('Shutting down all sessions...');
    const closePromises = [];
    
    for (const [sessionId, session] of this.sessions.entries()) {
      closePromises.push(
        session.disconnect().catch(err => {
          logger.error(`Error closing session ${sessionId}: ${err.message}`);
        })
      );
    }

    await Promise.all(closePromises);
    this.sessions.clear();
    logger.info('All sessions closed');
  }

  _saveSessionsMeta() {
    const sessionsMeta = {
      version: '1.0',
      lastUpdate: new Date().toISOString(),
      sessions: Array.from(this.sessions.keys()),
    };

    try {
      const dataDir = path.dirname(this.sessionsMetaFile);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.writeFileSync(this.sessionsMetaFile, JSON.stringify(sessionsMeta, null, 2));
    } catch (error) {
      logger.error(`Error saving sessions meta: ${error.message}`);
    }
  }
}

export default SessionManager;
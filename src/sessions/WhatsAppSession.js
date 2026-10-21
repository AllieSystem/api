import fs from 'fs';
import path from 'path';
import { makeWASocket, fetchLatestBaileysVersion, downloadMediaMessage, extensionForMediaMessage, extractMessageContent, proto } from '@whiskeysockets/baileys';
import { useEncryptedAuthState } from '../utils/encryptedAuthState.js';
import { classifyClose, reconnectDelayMs } from './connectionPolicy.js';
import pino from 'pino';
import NodeCache from 'node-cache';
import WebSocket from 'ws';
import config from '../config/config.js';
import { createAuthFolder, createDataFolder, loadChats, saveChats, deleteSessionFolders, getAuthFolder } from '../utils/storage.js';
import { normalizePhoneKey, extractPhoneFromJid, formatTimestamp, normalizePhone, toPublicMessage } from '../utils/helpers.js';
import { digits, findConversation, groupConversations, toChatSummary, upsertChatMessage } from '../utils/conversations.js';
import { mediaKeyToBuffer, normalizeFileLength, normalizeMediaKey, thumbnailToBase64 } from '../utils/media.js';
import { buildOutgoingContent } from '../utils/outgoingMedia.js';
import { logger as mainLogger, createSessionLogger } from '../utils/logger.js';

const msgRetryCounterCache = new NodeCache();

export class WhatsAppSession {
  constructor(sessionId, phoneNumber = null, options = {}) {
    this.sessionId = sessionId;
    this.phoneNumber = phoneNumber;
    this.sock = null;
    this.status = 'disconnected';
    this.qrCode = null;
    this.pairingCode = null;
    this.pairingPhone = phoneNumber;
    this.chats = new Map();
    this.jidToPhone = new Map();
    this.messageStore = new Map();
    this.io = null;
    this.logger = createSessionLogger(sessionId);
    this.botPhoneNormalized = phoneNumber ? normalizePhoneKey(phoneNumber) : null;
    this.options = options;
    this.saveInterval = null;
    this.connectedAt = null;
    this.reconnectAttempt = 0;
    this.nextReconnectAt = null;
    this.lastDisconnect = null;
    this.socketGeneration = 0;
    this._closeHandledGeneration = -1;
    this.reconnectTimer = null;
    this._connectPromise = null;
    this._authResetDone = false;
    this._dirty = false;
    this._saveChain = Promise.resolve();
  }

  setSocketIO(io) {
    this.io = io;
    this._emitToSession('status', this.status);
  }

  _emitToSession(event, data) {
    if (this.io) {
      // Ensure data is an object and contains sessionId
      let payload = data;
      if (typeof data !== 'object' || data === null) {
        payload = { value: data, sessionId: this.sessionId };
      } else if (!data.sessionId) {
        payload = { ...data, sessionId: this.sessionId };
      }

      this.io.to(this.sessionId).emit(event, payload);
      
      const sessionNsp = this.io.of(`/session/${this.sessionId}`);
      if (sessionNsp) {
        sessionNsp.emit(event, payload);
      }
    }
  }

  isBotPhone(phone) {
    return this.botPhoneNormalized && normalizePhoneKey(phone) === this.botPhoneNormalized;
  }

  async connect() {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._connectBody();
    try {
      return await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }

  async _connectBody() {
    createAuthFolder(this.sessionId);
    createDataFolder(this.sessionId);

    if (this._dirty) this.flushChats();
    if (!this.chats || this.chats.size === 0) {
      this.chats = loadChats(this.sessionId) || new Map();
      this.consolidateChats();
    }

    const authDir = getAuthFolder(this.sessionId);

    if (this.options.freshAuth && !this._authResetDone) {
      this._authResetDone = true;
      const fs = await import('fs');
      if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
        this.logger.info('Carpeta de auth reiniciada para un emparejamiento nuevo');
      }
    }

    const { state, saveCreds } = await useEncryptedAuthState(authDir);
    let version;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
      this.logger.info({ version, isLatest: latest.isLatest }, 'Using fetched Baileys version');
    } catch (e) {
      version = [2, 3000, 1015901307]; // Fallback
      this.logger.warn({ version, error: e.message }, 'Failed to fetch latest Baileys version, using fallback');
    }

    this.socketGeneration += 1;
    const generation = this.socketGeneration;
    this._retireSocket();

    this.sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      connectTimeoutMs: 60000,
      keepaliveIntervalMs: 30000,
      markOnlineOnConnect: true,
      msgRetryCounterCache,
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      syncFullHistory: false,
      shouldSyncHistoryMessage: (message) => message?.syncType === proto.HistorySync.HistorySyncType.ON_DEMAND,
      fireInitQueries: true,
      emitOwnEvents: true,
      getMessage: async (key) => this.messageStore.get(key.id)?.message,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      if (generation !== this.socketGeneration) return;
      this._handleConnectionUpdate(update);
    });

    this.sock.ev.on('messages.upsert', ({ messages, type }) => {
      this._handleMessages(messages);
    });

    this.sock.ev.on('messaging-history.set', ({ chats: newChats, messages: newMessages }) => {
      this._handleHistorySync(newChats, newMessages);
    });

    this.sock.ev.on('message-receipt.update', (updates) => {
      this._handleReceiptUpdates(updates);
    });

    this.startAutoSave();

    if (this.phoneNumber && !state.creds.registered) {
      this.logger.info({ phoneNumber: this.phoneNumber, registered: state.creds.registered }, 'Requesting pairing code automatically');
      setTimeout(async () => {
        try {
          if (!this.sock || !this.sock.ws || this.sock.ws.readyState !== WebSocket.OPEN) {
            this.logger.warn('Socket not ready, retrying in 5s');
            await new Promise(r => setTimeout(r, 5000));
          }
          if (this.status !== 'connected' && this.status !== 'waiting_qr') {
            this.logger.info('Has QR, skipping pairing code request');
            return;
          }
          await this.requestPairingCode(this.phoneNumber);
        } catch (e) {
          this.logger.error(`Auto pairing failed: ${e.message}`);
        }
      }, 8000);
    }

    this.logger.info('WhatsApp session initialized');
    return this;
  }

  _retireSocket() {
    const previous = this.sock;
    this.sock = null;
    if (!previous) return;
    try {
      previous.ev?.removeAllListeners('connection.update');
      previous.ev?.removeAllListeners('creds.update');
      previous.ev?.removeAllListeners('messages.upsert');
      previous.ev?.removeAllListeners('messaging-history.set');
      previous.ev?.removeAllListeners('message-receipt.update');
    } catch (error) {
      this.logger.warn(`No se pudieron quitar listeners: ${error.message}`);
    }
    try {
      previous.end(undefined);
    } catch (error) {
      this.logger.warn(`No se pudo cerrar el socket anterior: ${error.message}`);
    }
  }

  _clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  _scheduleReconnect(delay) {
    this._clearReconnectTimer();
    const generation = this.socketGeneration;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (generation !== this.socketGeneration) return;
      if (this.status === 'needs_repair' || this.status === 'connected') return;
      this.connect().catch((error) => {
        this.logger.error(`Reconexión falló: ${error.message}`);
        if (this.status === 'needs_repair') return;
        this.reconnectAttempt += 1;
        const nextDelay = reconnectDelayMs(this.reconnectAttempt);
        this.nextReconnectAt = new Date(Date.now() + nextDelay).toISOString();
        this.status = 'reconnecting';
        this._scheduleReconnect(nextDelay);
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  _handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr, pairingCode } = update;
    this.logger.debug({
      connection,
      hasQr: Boolean(qr),
      hasPairingCode: Boolean(pairingCode),
    }, 'Connection update received');

    if (pairingCode) {
      this.pairingCode = pairingCode;
      this.status = 'waiting_pairing';
      this._emitToSession('pairing_code', { code: pairingCode, phone: this.pairingPhone });
      this._emitToSession('status', this.status);
      this.logger.info('Pairing code received from connection update');
    }

    if (qr) {
      this.qrCode = qr;
      this.status = 'waiting_qr';
      this._emitToSession('qr', qr);
      this._emitToSession('status', this.status);
      this.logger.info('QR code received');
    }

    if (connection === 'close') {
      if (this._closeHandledGeneration === this.socketGeneration) return;
      this._closeHandledGeneration = this.socketGeneration;

      const source = lastDisconnect?.error;
      const statusCode = source?.output?.statusCode || source?.data?.statusCode;
      const reason = [source?.data?.reason, source?.message].filter(Boolean).join(' ');
      const decision = classifyClose({ statusCode, reason });
      this.lastDisconnect = {
        statusCode: statusCode || null,
        reason: String(reason).slice(0, 180),
        at: new Date().toISOString(),
      };
      this._retireSocket();

      if (decision.action === 'stop') {
        this._clearReconnectTimer();
        this.status = decision.status;
        this.nextReconnectAt = null;
        this.logger.warn({ statusCode, reason }, 'La sesión se detuvo y las credenciales se conservan');
        this._emitToSession('status', this.status);
        return;
      }

      this.reconnectAttempt += 1;
      this.status = 'reconnecting';
      const delay = decision.delayMs ?? reconnectDelayMs(this.reconnectAttempt);
      this.nextReconnectAt = new Date(Date.now() + delay).toISOString();
      this.logger.warn({ statusCode, reason, attempt: this.reconnectAttempt, delay }, 'Reconectando la línea');
      this._emitToSession('status', this.status);
      this._scheduleReconnect(delay);
    } else if (connection === 'open') {
      this._clearReconnectTimer();
      this.reconnectAttempt = 0;
      this.nextReconnectAt = null;
      this.qrCode = null;
      this.pairingCode = null;
      this.status = 'connected';
      this.connectedAt = new Date();
      
      const userJid = this.sock?.user?.id;
      if (userJid) {
        const fullPhone = extractPhoneFromJid(userJid);
        this.botPhoneNormalized = normalizePhoneKey(fullPhone);
        this.logger.info({ botPhone: this.botPhoneNormalized }, 'Logged in as');
        if (!this.phoneNumber || this.phoneNumber === 'Sin número') {
          this.phoneNumber = normalizePhone(fullPhone);
        }
      }

      this._emitToSession('ready', {
        sessionId: this.sessionId,
        phoneNumber: this.phoneNumber,
      });
      this._emitToSession('status', this.status);
      this.logger.info('WhatsApp connected successfully');
    }
  }

  _handleMessages(messages) {
    let changed = false;
    const addedIds = [];
    for (const msg of messages) {
      if (!msg.message) {
        if (msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT) {
          continue;
        }
        continue;
      }

      this.messageStore.set(msg.key.id, msg);
      if (this.messageStore.size > 5000) {
        const firstKey = this.messageStore.keys().next().value;
        this.messageStore.delete(firstKey);
      }

      const jid = msg.key.remoteJid;
      const jidClean = extractPhoneFromJid(jid);

      let senderPhone = null;
      if (msg.key.senderPn) {
        senderPhone = extractPhoneFromJid(msg.key.senderPn);
      }

      const msgObj = msg.message;
      const parsedMsg = this._parseMessage(msgObj);

      const lid = typeof jid === 'string' && jid.endsWith('@lid') ? jid : null;
      const senderDigits = digits(senderPhone);
      const lidTail = lid ? digits(lid.split('@')[0]).slice(-10) : '';
      let chatKey = senderDigits && senderDigits !== lidTail ? senderDigits : '';
      if (!chatKey && lid) {
        for (const [key, existing] of this.chats) {
          if ((existing.messages || []).some((item) => item.jid === lid)) {
            chatKey = key;
            break;
          }
        }
      }
      if (!chatKey) chatKey = lid || digits(jidClean);

      if (!this.chats.has(chatKey)) {
        this.chats.set(chatKey, {
          phone: chatKey,
          name: chatKey,
          messages: [],
          lastMessage: null,
          timestamp: Date.now(),
        });
      }

      const chat = this.chats.get(chatKey);
      const msgData = {
        id: msg.key.id,
        text: parsedMsg.text,
        timestamp: formatTimestamp(msg.messageTimestamp),
        waTimestamp: Number(msg.messageTimestamp) || undefined,
        isOutgoing: msg.key.fromMe,
        jid: jid,
        senderPhone: senderPhone,
        mediaType: parsedMsg.mediaType,
        mediaThumbnail: parsedMsg.mediaThumbnail,
        mediaMimeType: parsedMsg.mediaMimeType,
        mediaFileName: parsedMsg.mediaFileName,
        mediaUrl: parsedMsg.mediaUrl,
        mediaKey: parsedMsg.mediaKey,
        mediaDirectPath: parsedMsg.mediaDirectPath,
        mediaFileLength: parsedMsg.mediaFileLength,
        quotedMsg: parsedMsg.quotedMsg,
      };

      if (!upsertChatMessage(chat, msgData)) continue;

      if (msg.key.fromMe) {
        this.jidToPhone.set(chatKey, jidClean);
      } else if (senderPhone) {
        this.jidToPhone.set(senderPhone, jidClean);
      }

      this.logger.info({ phone: chatKey, content: Boolean(msgData.text || msgData.mediaType) }, 'Message stored');
      addedIds.push(msgData.id);
      changed = true;
    }
    if (changed) {
      this.consolidateChats();
      this.persistChats();
      for (const id of addedIds) {
        const stored = Array.from(this.chats.values()).find((chat) => chat.messages.some((item) => item.id === id));
        const fresh = stored?.messages.find((item) => item.id === id);
        if (!stored || !fresh) continue;
        this._emitToSession('new_message', {
          phone: stored.phone,
          message: toPublicMessage(fresh),
          chat: {
            phone: stored.phone,
            name: stored.name,
            messageCount: stored.messages.length,
          },
        });
      }
    }
  }

  _parseMessage(msgObj) {
    msgObj = extractMessageContent(msgObj) || msgObj;
    let text = '';
    let mediaType = null;
    let mediaThumbnail = null;
    let mediaMimeType = null;
    let mediaFileName = null;
    let mediaUrl = null;
    let mediaKey = null;
    let mediaDirectPath = null;
    let mediaFileLength = null;
    let quotedMsg = null;

    if (msgObj.conversation) {
      text = msgObj.conversation;
    } else if (msgObj.extendedTextMessage) {
      text = msgObj.extendedTextMessage.text;
      const contextInfo = msgObj.extendedTextMessage.contextInfo;
      if (contextInfo?.quotedMessage) {
        quotedMsg = this._parseQuotedMessage(contextInfo);
      }
    } else if (msgObj.imageMessage) {
      text = msgObj.imageMessage.caption || '[Imagen]';
      mediaType = 'image';
      mediaMimeType = msgObj.imageMessage.mimetype;
      mediaUrl = msgObj.imageMessage.url;
      mediaKey = normalizeMediaKey(msgObj.imageMessage.mediaKey);
      mediaDirectPath = msgObj.imageMessage.directPath;
      mediaFileLength = normalizeFileLength(msgObj.imageMessage.fileLength);
      mediaThumbnail = thumbnailToBase64(msgObj.imageMessage.jpegThumbnail);
      const ext = mediaMimeType?.split('/')[1] || 'jpg';
      mediaFileName = `image-${Date.now()}.${ext}`;
    } else if (msgObj.videoMessage) {
      text = msgObj.videoMessage.caption || '[Video]';
      mediaType = 'video';
      mediaMimeType = msgObj.videoMessage.mimetype;
      mediaUrl = msgObj.videoMessage.url;
      mediaKey = normalizeMediaKey(msgObj.videoMessage.mediaKey);
      mediaDirectPath = msgObj.videoMessage.directPath;
      mediaFileLength = normalizeFileLength(msgObj.videoMessage.fileLength);
      mediaThumbnail = thumbnailToBase64(msgObj.videoMessage.jpegThumbnail);
      const ext = mediaMimeType?.split('/')[1] || 'mp4';
      mediaFileName = `video-${Date.now()}.${ext}`;
    } else if (msgObj.documentMessage || msgObj.documentWithCaptionMessage?.message?.documentMessage) {
      const document = msgObj.documentMessage || msgObj.documentWithCaptionMessage.message.documentMessage;
      text = document.caption || document.fileName || '[Documento]';
      mediaType = 'document';
      mediaMimeType = document.mimetype;
      mediaFileName = document.fileName;
      mediaUrl = document.url;
      mediaKey = normalizeMediaKey(document.mediaKey);
      mediaDirectPath = document.directPath;
      mediaFileLength = normalizeFileLength(document.fileLength);
      mediaThumbnail = thumbnailToBase64(document.jpegThumbnail);
      const ext = mediaMimeType?.split('/')[1] || 'bin';
      mediaFileName = mediaFileName || `document-${Date.now()}.${ext}`;
    } else if (msgObj.audioMessage) {
      text = '[Audio]';
      mediaType = 'audio';
      mediaMimeType = msgObj.audioMessage.mimetype;
      mediaUrl = msgObj.audioMessage.url;
      mediaKey = normalizeMediaKey(msgObj.audioMessage.mediaKey);
      mediaDirectPath = msgObj.audioMessage.directPath;
      mediaFileLength = normalizeFileLength(msgObj.audioMessage.fileLength);
      const ext = mediaMimeType?.split(';')[0]?.split('/')[1] || 'ogg';
      mediaFileName = `audio-${Date.now()}.${ext}`;
    } else if (msgObj.stickerMessage) {
      text = '[Sticker]';
      mediaType = 'sticker';
      mediaMimeType = msgObj.stickerMessage.mimetype || 'image/webp';
      mediaUrl = msgObj.stickerMessage.url;
      mediaKey = normalizeMediaKey(msgObj.stickerMessage.mediaKey);
      mediaDirectPath = msgObj.stickerMessage.directPath;
      mediaFileLength = normalizeFileLength(msgObj.stickerMessage.fileLength);
      mediaFileName = 'sticker.webp';
    } else if (msgObj.contactMessage) {
      text = msgObj.contactMessage.displayName || '[Contacto]';
    } else if (msgObj.locationMessage || msgObj.liveLocationMessage) {
      text = msgObj.liveLocationMessage ? '[Ubicación en vivo]' : '[Ubicación]';
    } else if (msgObj.pollCreationMessage || msgObj.pollCreationMessageV3) {
      const poll = msgObj.pollCreationMessage || msgObj.pollCreationMessageV3;
      text = poll.name || '[Encuesta]';
    } else if (msgObj.reactionMessage?.text) {
      text = msgObj.reactionMessage.text;
    }

    return { text, mediaType, mediaThumbnail, mediaMimeType, mediaFileName, mediaUrl, mediaKey, mediaDirectPath, mediaFileLength, quotedMsg };
  }

  _parseQuotedMessage(contextInfo) {
    const quoted = contextInfo.quotedMessage;
    let quotedText = '';
    if (quoted.conversation) quotedText = quoted.conversation;
    else if (quoted.extendedTextMessage) quotedText = quoted.extendedTextMessage.text;
    else if (quoted.imageMessage) quotedText = quoted.imageMessage.caption || '[Imagen]';
    else if (quoted.videoMessage) quotedText = quoted.videoMessage.caption || '[Video]';
    else if (quoted.documentMessage) quotedText = quoted.documentMessage.caption || quoted.documentMessage.fileName || '[Documento]';
    else if (quoted.audioMessage) quotedText = '[Audio]';
    else if (quoted.stickerMessage) quotedText = '[Sticker]';

    return {
      id: contextInfo.stanzaId,
      text: quotedText,
      sender: contextInfo.participant ? extractPhoneFromJid(contextInfo.participant) : 'Alguien',
    };
  }

  _handleHistorySync(newChats, newMessages) {
    if (!newChats && !newMessages) return;
    let changed = false;

    for (const chat of newChats || []) {
      const jid = chat.id?._serialized || chat.id;
      if (!jid) continue;

      const rawPhone = extractPhoneFromJid(jid);
      const phone = normalizePhoneKey(rawPhone);
      if (!phone || this.isBotPhone(phone)) continue;

      if (!this.chats.has(phone)) {
        this.chats.set(phone, {
          phone,
          name: chat.displayName || chat.name || phone,
          messages: [],
          lastMessage: null,
          timestamp: chat.lastMessageRecv ? chat.lastMessageRecv * 1000 : Date.now(),
        });
        changed = true;
      }
    }

    if (newMessages) {
      for (const msg of newMessages) {
        const jid = msg.key?.remoteJid;
        if (!jid || !msg.message) continue;

        const rawPhone = extractPhoneFromJid(jid);
        const phone = normalizePhoneKey(rawPhone);
        if (!phone || this.isBotPhone(phone)) continue;

        const msgObj = msg.message;
        const parsedMsg = this._parseMessage(msgObj);

        if (!this.chats.has(phone)) {
          this.chats.set(phone, { phone, name: phone, messages: [], lastMessage: null, timestamp: Date.now() });
          changed = true;
        }

        const chat = this.chats.get(phone);
        const msgData = {
          id: msg.key.id,
          text: parsedMsg.text,
          timestamp: formatTimestamp(msg.messageTimestamp),
          waTimestamp: Number(msg.messageTimestamp) || undefined,
          isOutgoing: msg.key.fromMe,
          jid: jid,
          senderPhone: msg.key.senderPn ? extractPhoneFromJid(msg.key.senderPn) : null,
          mediaType: parsedMsg.mediaType,
          mediaThumbnail: parsedMsg.mediaThumbnail,
          mediaMimeType: parsedMsg.mediaMimeType,
          mediaFileName: parsedMsg.mediaFileName,
          mediaUrl: parsedMsg.mediaUrl,
          mediaKey: parsedMsg.mediaKey,
          mediaDirectPath: parsedMsg.mediaDirectPath,
          mediaFileLength: parsedMsg.mediaFileLength,
          quotedMsg: parsedMsg.quotedMsg,
        };

        if (upsertChatMessage(chat, msgData)) changed = true;
      }
    }

    if (changed) {
      this.consolidateChats();
      this.persistChats();
    }
    this._emitToSession('chats_loaded', { count: this.chats.size });
    this.logger.info(`History sync: ${this.chats.size} chats`);
  }

  _handleReceiptUpdates(updates) {
    for (const { key, receipt } of updates || []) {
      const jid = key?.remoteJid;
      const phone = extractPhoneFromJid(jid);
      this._emitToSession('message_status', { phone, receipt: receipt?.status });
    }
  }

  persistChats() {
    this._dirty = true;
    this._saveChain = this._saveChain
      .catch(() => {})
      .then(() => this._writeChats())
      .catch((error) => {
        this.logger.error(`Error guardando chats: ${error.message}`);
      });
  }

  async _writeChats() {
    if (!this._dirty) return;
    this._dirty = false;
    const saved = saveChats(this.sessionId, this.chats);
    if (!saved) {
      this._dirty = true;
      throw new Error('No se pudo guardar el historial');
    }
  }

  flushChats() {
    if (!this._dirty) return;
    this._dirty = false;
    const saved = saveChats(this.sessionId, this.chats);
    if (!saved) {
      this._dirty = true;
      this.logger.error('Error guardando chats');
    }
  }

  startAutoSave() {
    if (this.saveInterval) return;
    this.saveInterval = setInterval(() => {
      if (this._dirty) this.flushChats();
    }, 60000);
    this.saveInterval.unref?.();
  }

  stopAutoSave() {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
  }

  async requestPairingCode(phone) {
    if (!this.sock) throw new Error('Socket no inicializado');

    const cleanPhone = phone.replace(/\D/g, '');
    this.pairingPhone = cleanPhone;
    this.logger.info(`Requesting pairing code for ${cleanPhone}`);

    try {
      // Wait for socket to be ready if it's not
      if (!this.sock || !this.sock.ws || this.sock.ws.readyState !== WebSocket.OPEN) {
        this.logger.info('Socket not ready for pairing, waiting up to 10s...');
        let attempts = 0;
        while (attempts < 20 && (!this.sock || !this.sock.ws || this.sock.ws.readyState !== WebSocket.OPEN)) {
          await new Promise(resolve => setTimeout(resolve, 500));
          attempts++;
        }
      }

      if (!this.sock || !this.sock.ws || this.sock.ws.readyState !== WebSocket.OPEN) {
        throw new Error('No se pudo establecer conexión con WhatsApp para solicitar el código');
      }

      this.logger.info('Socket ready, requesting pairing code');
      const code = await this.sock.requestPairingCode(cleanPhone);
      this.logger.info('Pairing code received');
      this.pairingCode = code;
      this.status = 'waiting_pairing';
      this._emitToSession('pairing_code', { code, phone: cleanPhone });
      this._emitToSession('status', this.status);
      return code;
    } catch (error) {
      this.logger.error({ error, stack: error.stack }, `Pairing code error: ${error.message}`);
      throw error;
    }
  }

  async sendMessage(phone, message) {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp no está conectado');
    }

    const cleanPhone = phone.replace(/\D/g, '');
    const jid = await this._phoneToJid(cleanPhone);

    const sent = await this.sock.sendMessage(jid, { text: message });
    if (sent) this.messageStore.set(sent.key.id, sent);

    this.logger.info(`Message sent to ${phone}`);
    return { success: true, messageId: sent?.key?.id, phone: cleanPhone };
  }

  async sendMessageWithFiles(phone, message, files) {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp no está conectado');
    }

    const cleanPhone = phone.replace(/\D/g, '');
    const jid = await this._phoneToJid(cleanPhone);

    if (!files?.length) {
      throw new Error('No hay archivos para enviar');
    }

    const messageIds = [];
    let caption = String(message || '').trim();

    for (const file of files) {
      const built = buildOutgoingContent({
        buffer: fs.readFileSync(file.path),
        mimetype: file.mimetype,
        fileName: path.basename(file.originalname || 'archivo'),
      }, caption);
      caption = '';

      if (built.leadingText) {
        const textSent = await this.sock.sendMessage(jid, { text: built.leadingText });
        if (textSent?.key?.id) {
          this.messageStore.set(textSent.key.id, textSent);
          messageIds.push(textSent.key.id);
        }
      }

      const sent = await this.sock.sendMessage(jid, built.content);
      if (sent?.key?.id) {
        this.messageStore.set(sent.key.id, sent);
        messageIds.push(sent.key.id);
      }
    }

    this.logger.info(`Message with file sent to ${phone}`);
    return { success: true, messageId: messageIds[0] || null, messageIds, phone: cleanPhone };
  }

  async _phoneToJid(phone) {
    let cleanPhone = phone.replace(/[^0-9]/g, '');
    let jid = cleanPhone + '@s.whatsapp.net';

    if (this.sock) {
      try {
        let result = await this.sock.onWhatsApp(jid);
        if (result && result.length > 0 && result[0]) {
          return result[0].jid;
        }

        if (cleanPhone.startsWith('52') && cleanPhone.length === 12) {
          let jidWith1 = '521' + cleanPhone.substring(2) + '@s.whatsapp.net';
          let resultWith1 = await this.sock.onWhatsApp(jidWith1);
          if (resultWith1 && resultWith1.length > 0 && resultWith1[0]) {
            return resultWith1[0].jid;
          }
        }

        if (cleanPhone.startsWith('521') && cleanPhone.length === 13) {
          let jidWithout1 = '52' + cleanPhone.substring(3) + '@s.whatsapp.net';
          let resultWithout1 = await this.sock.onWhatsApp(jidWithout1);
          if (resultWithout1 && resultWithout1.length > 0 && resultWithout1[0]) {
            return resultWithout1[0].jid;
          }
        }
      } catch (error) {
        this.logger.debug(`Error verifying JID: ${error.message}`);
      }
    }

    if (cleanPhone.startsWith('52') && cleanPhone.length === 12) {
      const areaCode = cleanPhone.substring(2, 4);
      const mobileCodes = ['55', '33', '81', '22', '44', '47', '56', '58', '59', '61', '62', '64', '65', '66', '67', '71', '72', '73', '74', '75', '76', '77', '78', '79', '82', '83', '84', '86', '87', '88', '89', '91', '92', '93', '94', '95', '96', '97', '98', '99'];
      if (mobileCodes.includes(areaCode)) {
        cleanPhone = '521' + cleanPhone.substring(2);
      }
    }

    return cleanPhone + '@s.whatsapp.net';
  }

  async checkNumber(phone) {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp no está conectado');
    }

    const cleanPhone = phone.replace(/\D/g, '');
    const jid = await this._phoneToJid(cleanPhone);

    const result = await this.sock.onWhatsApp(jid);
    if (result && result.length > 0 && result[0]) {
      return { exists: true, jid: result[0].jid, phone: cleanPhone };
    }
    return { exists: false, phone: cleanPhone };
  }

  consolidateChats() {
    const grouped = groupConversations(this.chats);
    const next = new Map(grouped.map((chat) => [chat.phone, chat]));
    let changed = next.size !== this.chats.size;
    if (!changed) {
      for (const [key, chat] of next) {
        const previous = this.chats.get(key);
        if (!previous || previous.phone !== chat.phone || previous.messages.length !== chat.messages.length) {
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      this.chats = next;
      this._dirty = true;
      this.persistChats();
    }
    return Array.from(this.chats.values());
  }

  getChats() {
    return this.consolidateChats()
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .map((chat) => {
        const summary = toChatSummary(chat);
        return {
          ...summary,
          lastMessage: toPublicMessage(summary.lastMessage),
        };
      });
  }

  getChat(phone) {
    this.consolidateChats();
    return findConversation(this.chats, phone);
  }

  getChatMessages(phone) {
    const chat = this.getChat(phone);
    if (!chat) return [];
    return chat.messages;
  }

  async downloadMedia(messageId) {
    let message = null;
    for (const [, chat] of this.chats.entries()) {
      const found = chat.messages.find(m => m.id === messageId);
      if (found) {
        message = found;
        break;
      }
    }

    if (!message || !message.mediaType) {
      throw new Error('Mensaje no encontrado o sin medios');
    }

    const mediaMessageTypes = {
      'image': 'imageMessage',
      'video': 'videoMessage',
      'audio': 'audioMessage',
      'document': 'documentMessage',
      'sticker': 'stickerMessage',
    };

    const msgKeyType = mediaMessageTypes[message.mediaType];
    const mediaKey = mediaKeyToBuffer(message.mediaKey);
    if (!mediaKey) {
      throw new Error('El archivo no tiene llave de descarga');
    }
    const mockMessage = {
      key: {
        id: message.id,
        remoteJid: message.jid,
        fromMe: Boolean(message.isOutgoing),
      },
      message: {
        [msgKeyType]: {
          url: message.mediaUrl,
          mediaKey,
          directPath: message.mediaDirectPath,
          mimetype: message.mediaMimeType,
          fileLength: normalizeFileLength(message.mediaFileLength),
          fileName: message.mediaFileName,
        },
      },
    };

    try {
      const buffer = await downloadMediaMessage(mockMessage, 'buffer', {}, {
        logger: this.logger,
        reuploadRequest: (msg) => this.sock?.updateMediaMessage(msg),
      });
      const ext = extensionForMediaMessage(mockMessage.message);
      const fileName = message.mediaFileName || `media-${message.id}.${ext}`;
      return { buffer, fileName, mimeType: message.mediaMimeType };
    } catch (error) {
      this.logger.error(`Media download error: ${error.message}`);
      throw error;
    }
  }

  getStatus() {
    return {
      sessionId: this.sessionId,
      phoneNumber: this.phoneNumber,
      status: this.status,
      connectedAt: this.connectedAt,
      hasQR: this.status === 'waiting_qr' && !!this.qrCode,
      qrCode: this.status === 'waiting_qr' ? this.qrCode : null,
      hasPairing: this.status === 'waiting_pairing' && !!this.pairingCode,
      pairingCode: this.status === 'waiting_pairing' ? this.pairingCode : null,
      reconnectAttempt: this.reconnectAttempt,
      nextReconnectAt: this.nextReconnectAt,
      lastDisconnect: this.lastDisconnect,
    };
  }

  async logout() {
    this.socketGeneration += 1;
    this._clearReconnectTimer();
    this.stopAutoSave();
    const sock = this.sock;
    this.sock = null;
    if (sock) {
      try {
        await sock.logout();
      } catch (e) {
        this.logger.warn(`Logout error: ${e.message}`);
      }
    }

    deleteSessionFolders(this.sessionId);
    this._dirty = false;
    this.status = 'disconnected';
    this.qrCode = null;
    this.pairingCode = null;
    this._emitToSession('disconnected');
    this._emitToSession('status', this.status);

    this.logger.info('Session logged out');
  }

  async disconnect() {
    this.socketGeneration += 1;
    this._clearReconnectTimer();
    this.stopAutoSave();
    this._retireSocket();
    try {
      await this._saveChain;
    } catch (error) {
      this.logger.warn(`Guardado pendiente falló: ${error.message}`);
    }
    this.flushChats();
    this.status = 'disconnected';
    this.logger.info('Session disconnected');
  }
}
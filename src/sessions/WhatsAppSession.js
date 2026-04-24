import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage, extensionForMediaMessage, Browsers } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import NodeCache from 'node-cache';
import WebSocket from 'ws';
import config from '../config/config.js';
import { createAuthFolder, createDataFolder, loadChats, saveChats, deleteSessionFolders, getAuthFolder } from '../utils/storage.js';
import { normalizePhoneKey, extractPhoneFromJid, formatTimestamp, normalizePhone } from '../utils/helpers.js';
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
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 3;
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
    createAuthFolder(this.sessionId);
    createDataFolder(this.sessionId);

    this.chats = loadChats(this.sessionId) || new Map();

    const authDir = getAuthFolder(this.sessionId);

    if (this.phoneNumber) {
      const fs = await import('fs');
      if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
        this.logger.info('Cleared auth folder for pairing code flow');
      }
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    
    let version;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
      this.logger.info({ version, isLatest: latest.isLatest }, 'Using fetched Baileys version');
    } catch (e) {
      version = [2, 3000, 1015901307]; // Fallback
      this.logger.warn({ version, error: e.message }, 'Failed to fetch latest Baileys version, using fallback');
    }

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
      fireInitQueries: true,
      emitOwnEvents: true,
      getMessage: async (key) => {
        const msg = this.messageStore.get(key.id);
        if (msg) return msg.message;
        return { conversation: 'Mensaje reenviado automáticamente' };
      },
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
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

  _handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr, pairingCode } = update;
    this.logger.debug({ update }, 'Connection update received');

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
      const boomError = new Boom(lastDisconnect?.error);
      const reason = boomError?.data?.DISCONNECT_REASON || lastDisconnect?.error?.message || 'Unknown reason';
      const statusCode = boomError?.output?.statusCode || lastDisconnect?.error?.output?.statusCode;

      this.logger.warn({ reason, statusCode, error: lastDisconnect?.error }, 'Connection closed');

      if (statusCode === 405) {
        this.connectionAttempts++;
        if (this.connectionAttempts >= this.maxConnectionAttempts) {
          this.logger.error('Max connection attempts reached, giving up');
          this.status = 'failed';
          this._emitToSession('status', this.status);
          return;
        }
        this.logger.info({ attempt: this.connectionAttempts }, 'Connection 405, reconnecting...');
        setTimeout(() => this.connect(), 3000);
      } else if (this.pairingCode && (statusCode === 515 || reason?.includes('restart required'))) {
        this.logger.info('Waiting for pairing code to be used, not reconnecting automatically');
      } else if (statusCode === 515 || reason?.includes('restart required')) {
        this.logger.info('Restart required after pairing, reconnecting...');
        setTimeout(() => this.connect(), 2000);
      } else if (statusCode === 401 || reason === 'BadSession' || reason === 'invalid_mechanisms') {
        this.logger.warn('Session invalid, restarting...');
        this.logout();
        setTimeout(() => this.connect(), 2000);
      } else {
        this.status = 'disconnected';
        this._emitToSession('disconnected');
        this._emitToSession('status', this.status);
      }
    } else if (connection === 'open') {
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
    for (const msg of messages) {
      if (!msg.message) continue;

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

      let chatKey = normalizePhoneKey(jidClean);

      if (!msg.key.fromMe && senderPhone) {
        const normalizedSender = senderPhone.replace(/\D/g, '');
        for (const [phone, mappedJid] of this.jidToPhone.entries()) {
          if (phone === normalizedSender || mappedJid === normalizedSender) {
            chatKey = phone;
            break;
          }
        }
        if (chatKey === normalizePhoneKey(jidClean)) {
          chatKey = normalizePhoneKey(senderPhone);
        }
      }

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
      const existingMsg = chat.messages.find(m => m.id === msg.key.id);
      if (existingMsg) continue;

      const msgData = {
        id: msg.key.id,
        text: parsedMsg.text,
        timestamp: formatTimestamp(msg.messageTimestamp),
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

      chat.messages.push(msgData);
      chat.lastMessage = msgData;
      chat.timestamp = Date.now();

      if (msg.key.fromMe) {
        this.jidToPhone.set(chatKey, jidClean);
      } else if (senderPhone) {
        this.jidToPhone.set(senderPhone, jidClean);
      }

      this._emitToSession('new_message', { phone: chatKey, message: msgData, chat });
      this.logger.debug(`Message from ${chatKey}: ${parsedMsg.text?.substring(0, 30)}`);
    }
  }

  _parseMessage(msgObj) {
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
      mediaKey = msgObj.imageMessage.mediaKey;
      mediaDirectPath = msgObj.imageMessage.directPath;
      mediaFileLength = msgObj.imageMessage.fileLength;
      if (msgObj.imageMessage.jpegThumbnail) {
        mediaThumbnail = Buffer.from(msgObj.imageMessage.jpegThumbnail).toString('base64');
      }
      const ext = mediaMimeType?.split('/')[1] || 'jpg';
      mediaFileName = `image-${Date.now()}.${ext}`;
    } else if (msgObj.videoMessage) {
      text = msgObj.videoMessage.caption || '[Video]';
      mediaType = 'video';
      mediaMimeType = msgObj.videoMessage.mimetype;
      mediaUrl = msgObj.videoMessage.url;
      mediaKey = msgObj.videoMessage.mediaKey;
      mediaDirectPath = msgObj.videoMessage.directPath;
      mediaFileLength = msgObj.videoMessage.fileLength;
      if (msgObj.videoMessage.jpegThumbnail) {
        mediaThumbnail = Buffer.from(msgObj.videoMessage.jpegThumbnail).toString('base64');
      }
      const ext = mediaMimeType?.split('/')[1] || 'mp4';
      mediaFileName = `video-${Date.now()}.${ext}`;
    } else if (msgObj.documentMessage) {
      text = msgObj.documentMessage.caption || msgObj.documentMessage.fileName || '[Documento]';
      mediaType = 'document';
      mediaMimeType = msgObj.documentMessage.mimetype;
      mediaFileName = msgObj.documentMessage.fileName;
      mediaUrl = msgObj.documentMessage.url;
      mediaKey = msgObj.documentMessage.mediaKey;
      mediaDirectPath = msgObj.documentMessage.directPath;
      mediaFileLength = msgObj.documentMessage.fileLength;
      const ext = mediaMimeType?.split('/')[1] || 'bin';
      mediaFileName = mediaFileName || `document-${Date.now()}.${ext}`;
    } else if (msgObj.audioMessage) {
      text = '[Audio]';
      mediaType = 'audio';
      mediaMimeType = msgObj.audioMessage.mimetype;
      mediaUrl = msgObj.audioMessage.url;
      mediaKey = msgObj.audioMessage.mediaKey;
      mediaDirectPath = msgObj.audioMessage.directPath;
      mediaFileLength = msgObj.audioMessage.fileLength;
      let ext = mediaMimeType?.split(';')[0]?.split('/')[1] || 'ogg';
      mediaFileName = `audio-${Date.now()}.${ext}`;
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
    if (!newChats) return;

    for (const chat of newChats) {
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
        }

        const chat = this.chats.get(phone);
        const existingMsg = chat.messages.find(m => m.id === msg.key.id);
        if (existingMsg) continue;

        const msgData = {
          id: msg.key.id,
          text: parsedMsg.text,
          timestamp: formatTimestamp(msg.messageTimestamp),
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

        chat.messages.push(msgData);
        chat.lastMessage = msgData;
      }
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

  startAutoSave() {
    this.saveInterval = setInterval(() => {
      if (this.chats.size > 0) {
        saveChats(this.sessionId, this.chats);
        this.logger.debug('Chats auto-saved');
      }
    }, 30000);
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
      this.logger.info(`Pairing code received: ${code}`);
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

    let messageContent = {};
    const file = files[0];
    const mimeType = file.mimetype;

    if (mimeType.startsWith('image/')) {
      messageContent = { image: { url: file.path }, caption: message };
    } else if (mimeType.startsWith('video/')) {
      messageContent = { video: { url: file.path }, caption: message };
    } else if (mimeType.startsWith('audio/')) {
      messageContent = { audio: { url: file.path } };
    } else {
      messageContent = { document: { url: file.path }, fileName: file.originalname, caption: message };
    }

    const sent = await this.sock.sendMessage(jid, messageContent);
    if (sent) this.messageStore.set(sent.key.id, sent);

    this.logger.info(`Message with file sent to ${phone}`);
    return { success: true, messageId: sent?.key?.id, phone: cleanPhone };
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

  getChats() {
    return Array.from(this.chats.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .map(chat => ({
        phone: chat.phone,
        name: chat.name,
        lastMessage: chat.lastMessage,
        messageCount: chat.messages.length,
      }));
  }

  getChat(phone) {
    const normalizedPhone = phone.replace(/\D/g, '');
    for (const [key, chat] of this.chats.entries()) {
      if (normalizePhoneKey(key) === normalizePhoneKey(normalizedPhone)) {
        return chat;
      }
    }
    return null;
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
    const mockMessage = {
      key: { id: message.id },
      message: {
        [msgKeyType]: {
          url: message.mediaUrl,
          mediaKey: message.mediaKey,
          directPath: message.mediaDirectPath,
          mimetype: message.mediaMimeType,
          fileLength: message.mediaFileLength,
          fileName: message.mediaFileName,
        },
      },
    };

    try {
      const buffer = await downloadMediaMessage(mockMessage, 'buffer', {});
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
      hasQR: !!this.qrCode,
      qrCode: this.qrCode,
      hasPairing: !!this.pairingCode,
      pairingCode: this.pairingCode || null,
    };
  }

  async logout() {
    this.stopAutoSave();

    if (this.sock) {
      try {
        await this.sock.logout();
      } catch (e) {
        this.logger.warn(`Logout error: ${e.message}`);
      }
      this.sock = null;
    }

    deleteSessionFolders(this.sessionId);
    this.status = 'disconnected';
    this.qrCode = null;
    this.pairingCode = null;
    this._emitToSession('disconnected');
    this._emitToSession('status', this.status);

    this.logger.info('Session logged out');
  }

  async disconnect() {
    this.stopAutoSave();
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    this.status = 'disconnected';
    this.logger.info('Session disconnected');
  }
}
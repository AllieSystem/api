import { v4 as uuidv4 } from 'uuid';

export function generateSessionId() {
  return uuidv4();
}

export function normalizePhone(phone) {
  return phone?.replace(/\D/g, '') || phone;
}

export function normalizePhoneKey(phone) {
  const digits = phone?.replace(/\D/g, '') || '';
  return digits.slice(-10);
}

export function isValidPhone(phone) {
  const digits = phone?.replace(/\D/g, '') || '';
  return digits.length >= 8 && digits.length <= 15;
}

export function formatPhoneForApi(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('52') && digits.length === 12) {
    return '521' + digits.substring(2);
  }
  return digits;
}

export function phoneToJid(phone) {
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  return cleanPhone + '@s.whatsapp.net';
}

export function extractPhoneFromJid(jid) {
  if (!jid) return null;
  // Handle formats like 5215556614579:18@s.whatsapp.net or 5215556614579@s.whatsapp.net
  const userPart = jid.split('@')[0];
  return userPart.split(':')[0].split('.')[0];
}

export function isBotPhone(phone, botPhone) {
  return normalizePhoneKey(phone) === normalizePhoneKey(botPhone);
}

export function formatTimestamp(timestamp) {
  return timestamp ? (timestamp * 1000 || timestamp) : Date.now();
}

const PRIVATE_MESSAGE_FIELDS = ['mediaKey', 'mediaUrl', 'mediaDirectPath'];

export function toPublicMessage(message) {
  if (!message || typeof message !== 'object') return message;
  const copy = { ...message };
  for (const field of PRIVATE_MESSAGE_FIELDS) {
    delete copy[field];
  }
  return copy;
}

export function createApiResponse(success, data = null, error = null) {
  const response = { success };
  if (data) response.data = data;
  if (error) response.error = error;
  return response;
}

export function paginateResults(items, page = 1, limit = 50) {
  const startIndex = (page - 1) * limit;
  const endIndex = startIndex + limit;
  
  return {
    items: items.slice(startIndex, endIndex),
    pagination: {
      page,
      limit,
      total: items.length,
      totalPages: Math.ceil(items.length / limit),
      hasMore: endIndex < items.length,
    },
  };
}
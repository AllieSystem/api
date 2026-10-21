import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const nodeEnv = process.env.NODE_ENV || 'development';
const port = parseInt(process.env.PORT || '3002', 10);
const authDir = process.env.AUTH_DIR || path.join(__dirname, '../../auth');

export function resolveAllowedOrigins(raw, env = nodeEnv) {
  const value = (raw || '').trim();
  const localOrigins = ['http://localhost:3000', 'http://localhost:3001'];
  if (!value || value === '*') {
    return env === 'production' ? [] : localOrigins;
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

const config = {
  app: {
    name: 'MV WhatsApp Hub API',
    version: '1.0.0',
    env: nodeEnv,
    port,
    host: process.env.HOST || '0.0.0.0',
    apiPrefix: process.env.API_PREFIX || '/api',
    uploadsDir: path.join(__dirname, '../../uploads'),
    logsDir: path.join(__dirname, '../../logs'),
    maxRequestSize: process.env.MAX_REQUEST_SIZE || '50mb',
  },
  secrets: {
    dir: process.env.SECRETS_DIR || path.join(__dirname, '../../secrets'),
  },
  auth: {
    dir: authDir,
    keysFile: process.env.AUTH_KEYS_FILE || path.join(authDir, 'keys.json'),
    usersFile: process.env.AUTH_USERS_FILE || path.join(authDir, 'panel-users.json'),
    sessionsFile: process.env.AUTH_SESSIONS_FILE || path.join(authDir, 'panel-sessions.json'),
    sessionTtlMs: parseInt(process.env.PANEL_SESSION_TTL_MS || String(12 * 60 * 60 * 1000), 10),
    socketTtlMs: parseInt(process.env.SOCKET_TOKEN_TTL_MS || String(30 * 60 * 1000), 10),
  },
  data: {
    dir: process.env.DATA_DIR || path.join(__dirname, '../../data'),
    chatsFile: 'chats.json',
  },
  whatsapp: {
    connectTimeoutMs: parseInt(process.env.WHATSAPP_CONNECT_TIMEOUT_MS || '60000'),
    keepaliveIntervalMs: parseInt(process.env.WHATSAPP_KEEPALIVE_INTERVAL_MS || '30000'),
    maxRetries: parseInt(process.env.WHATSAPP_MAX_RETRIES || '3'),
    retryDelayMs: parseInt(process.env.WHATSAPP_RETRY_DELAY_MS || '5000'),
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
  },
  socket: {
    pingTimeout: parseInt(process.env.SOCKET_PING_TIMEOUT || '60000', 10),
    pingInterval: parseInt(process.env.SOCKET_PING_INTERVAL || '25000', 10),
    publicUrl: process.env.SOCKET_PUBLIC_URL || `http://localhost:${port}`,
  },
  cors: {
    origins: resolveAllowedOrigins(process.env.CORS_ORIGIN, nodeEnv),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  },
};

export default config;
export { config };
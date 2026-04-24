import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = {
  app: {
    name: 'MV WhatsApp Hub API',
    version: '1.0.0',
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '3002'),
    host: process.env.HOST || '0.0.0.0',
    apiPrefix: process.env.API_PREFIX || '/api',
    uploadsDir: path.join(__dirname, '../../uploads'),
    logsDir: path.join(__dirname, '../../logs'),
    maxRequestSize: process.env.MAX_REQUEST_SIZE || '50mb',
  },
  auth: {
    dir: path.join(__dirname, '../../auth'),
    keysFile: path.join(__dirname, '../../auth/keys.json'),
  },
  data: {
    dir: path.join(__dirname, '../../data'),
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
    pingTimeout: parseInt(process.env.SOCKET_PING_TIMEOUT || '60000'),
    pingInterval: parseInt(process.env.SOCKET_PING_INTERVAL || '25000'),
  },
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Session-ID'],
  },
};

export default config;
export { config };
import pino from 'pino';
import path from 'path';
import config from '../config/config.js';
import { ensureDir } from './storage.js';

const logsDir = config.app.logsDir;
ensureDir(logsDir);

const loggerConfig = {
  transport: {
    targets: [
      {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
          levelFirst: true,
        },
        level: 'debug',
      },
      {
        target: 'pino/file',
        options: {
          destination: path.join(logsDir, `allie_whats_${new Date().toISOString().split('T')[0]}.log`),
          mkdir: true,
        },
        level: 'info',
      },
    ],
  },
  level: config.app.env === 'production' ? 'info' : 'debug',
};

const logger = pino(loggerConfig);

export function createSessionLogger(sessionId) {
  return logger.child({ sessionId });
}

export function logApiRequest(req, res, duration) {
  logger.info({
    method: req.method,
    url: req.url,
    status: res.statusCode,
    duration: `${duration}ms`,
    ip: req.ip,
    apiKey: req.apiKey?.name || 'unknown',
  });
}

export default logger;
export { logger };
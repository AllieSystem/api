import { Boom } from '@hapi/boom';
import { logger } from '../utils/logger.js';

export function errorHandler(err, req, res, next) {
  const isProduction = process.env.NODE_ENV === 'production';

  if (err.isBoom) {
    const { statusCode, message, output } = err;
    logger.warn({ err: message, statusCode, path: req.path }, 'Boom error');

    return res.status(statusCode).json({
      success: false,
      error: message,
      code: output.payload.error || 'ERROR',
      ...(output.payload.data ? { data: output.payload.data } : {}),
    });
  }

  if (err.name === 'ValidationError' || err.status === 400) {
    return res.status(400).json({
      success: false,
      error: err.message,
      code: 'VALIDATION_ERROR',
    });
  }

  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({
      success: false,
      error: 'Token CSRF inválido',
      code: 'CSRF_ERROR',
    });
  }

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error: 'Archivo demasiado grande. Máximo 50MB.',
      code: 'FILE_TOO_LARGE',
    });
  }

  logger.error({ err: err.message, stack: err.stack, path: req.path }, 'Unhandled error');

  res.status(500).json({
    success: false,
    error: isProduction ? 'Error interno del servidor' : err.message,
    code: 'INTERNAL_ERROR',
  });
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: `Ruta ${req.method} ${req.path} no encontrada`,
    code: 'NOT_FOUND',
  });
}

export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function createError(message, statusCode = 400, code = 'ERROR') {
  return Boom.badRequest(message, { code });
}

export function createNotFoundError(resource = 'Recurso') {
  return Boom.notFound(`${resource} no encontrado`, { code: 'NOT_FOUND' });
}

export function createForbiddenError(message = 'Acceso denegado') {
  return Boom.forbidden(message, { code: 'FORBIDDEN' });
}

export default errorHandler;
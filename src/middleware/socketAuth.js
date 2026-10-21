import { verifySocketToken } from './auth.js';

export function socketAuthMiddleware(socket, next) {
  const token = socket.handshake.auth?.token;
  const session = typeof token === 'string' ? verifySocketToken(token) : null;
  if (!session) {
    next(new Error('unauthorized'));
    return;
  }
  socket.data.user = {
    id: session.userId,
    name: session.username,
  };
  next();
}

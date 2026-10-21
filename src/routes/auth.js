import { Router } from 'express';
import {
  authenticatePanel,
  createSocketToken,
  loginRateLimit,
  panelLoginAvailable,
  revokeBearerSession,
} from '../middleware/auth.js';
import config from '../config/config.js';

const router = Router();
const publicRouter = Router();

publicRouter.post('/login', loginRateLimit, (req, res) => {
  if (!panelLoginAvailable()) {
    return res.status(503).json({
      success: false,
      error: 'El panel no tiene contraseña configurada',
      code: 'PANEL_NOT_CONFIGURED',
    });
  }

  const username = req.body?.username;
  const password = req.body?.password;
  if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > 200) {
    res.locals.noteLoginFailure?.();
    return res.status(401).json({
      success: false,
      error: 'Usuario o contraseña incorrectos',
      code: 'INVALID_CREDENTIALS',
    });
  }

  const session = authenticatePanel(username, password);
  if (!session) {
    res.locals.noteLoginFailure?.();
    return res.status(401).json({
      success: false,
      error: 'Usuario o contraseña incorrectos',
      code: 'INVALID_CREDENTIALS',
    });
  }

  return res.json({
    success: true,
    data: {
      token: session.token,
      username: session.username,
      expiresAt: session.expiresAt,
      maxAgeSeconds: session.maxAgeSeconds,
    },
  });
});

router.post('/logout', (req, res) => {
  const authorization = req.headers.authorization || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (bearer) revokeBearerSession(bearer);
  res.json({ success: true });
});

router.get('/me', (req, res) => {
  res.json({
    success: true,
    data: {
      username: req.principal?.name || null,
    },
  });
});

router.post('/socket-token', (req, res) => {
  if (!req.panelSession) {
    return res.status(403).json({
      success: false,
      error: 'El token de socket solo se emite para una sesión del panel',
      code: 'FORBIDDEN',
    });
  }
  const socketToken = createSocketToken(req.panelSession);
  return res.json({
    success: true,
    data: {
      token: socketToken.token,
      expiresAt: socketToken.expiresAt,
      socketUrl: config.socket.publicUrl,
    },
  });
});

export { publicRouter as publicAuthRouter };
export default router;

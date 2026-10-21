import fs from 'fs';
import path from 'path';

const NOTE = [
  'Copia de las sesiones de WhatsApp Hub.',
  'Incluye auth/ y data/ cifrados.',
  'No incluye AUTH_ENCRYPTION_KEY. Sin esa llave esta copia no se puede leer.',
  'Guarda la llave en un lugar distinto a esta carpeta.',
  '',
].join('\n');

export function createBackup({ authDir, dataDir, backupRoot, now = new Date() }) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupRoot, stamp);
  fs.mkdirSync(dest, { recursive: true });
  if (authDir && fs.existsSync(authDir)) {
    fs.cpSync(authDir, path.join(dest, 'auth'), { recursive: true });
  }
  if (dataDir && fs.existsSync(dataDir)) {
    fs.cpSync(dataDir, path.join(dest, 'data'), { recursive: true });
  }
  fs.writeFileSync(path.join(dest, 'README.txt'), NOTE);
  return dest;
}

export function restoreBackup(backupDir, { authDir, dataDir }) {
  const authSrc = path.join(backupDir, 'auth');
  const dataSrc = path.join(backupDir, 'data');
  if (fs.existsSync(authSrc)) {
    fs.mkdirSync(authDir, { recursive: true });
    fs.cpSync(authSrc, authDir, { recursive: true });
  }
  if (fs.existsSync(dataSrc)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.cpSync(dataSrc, dataDir, { recursive: true });
  }
}

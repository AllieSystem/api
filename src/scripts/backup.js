import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config/config.js';
import { createBackup } from '../utils/backup.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dest = createBackup({
  authDir: config.auth.dir,
  dataDir: config.data.dir,
  backupRoot: path.join(root, 'backups'),
});

console.log(dest);

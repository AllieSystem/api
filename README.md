# MV WhatsApp Hub API

API REST para gestión de múltiples sesiones de WhatsApp usando Baileys, con panel web, cifrado en reposo y eventos en tiempo real por Socket.IO.

El panel es una aplicación Next.js aparte, en el proyecto hermano `web/`. Esta API no sirve HTML: solo responde JSON y emite eventos de socket.

## Características

- Múltiples sesiones de WhatsApp simultáneas, cada una con su propio historial de chats
- Emparejamiento por código de 8 dígitos o por QR
- Autenticación dual: sesión de panel (usuario y contraseña) y API Key para procesos automáticos
- Permisos por endpoint (`sessions:read`, `sessions:write`, `chats:read`, `chats:write`, `messages:send`)
- Cifrado AES-256-GCM de las credenciales de Baileys y de los historiales de chat
- Reconexión automática con espera exponencial y aviso por webhook cuando una línea cae
- Envío y recepción de mensajes de texto y multimedia (imagen, video, audio, documento, sticker)
- Historial de chats agrupado por teléfono, con soporte de los JID `@lid` de WhatsApp
- Copias de seguridad de los datos cifrados
- Rate limiting por credencial y por IP
- CORS con lista explícita de orígenes y cabeceras de seguridad en todas las respuestas

## Requisitos

- Node.js 18+
- npm

## Instalación

```bash
npm install
```

## Configuración

Copia las variables de entorno de ejemplo y ajústalas:

```bash
cp .env.example .env
```

| Variable | Por defecto | Descripción |
|----------|-------------|-------------|
| `NODE_ENV` | `development` | Entorno. En `production` la llave de cifrado es obligatoria y CORS no admite `*`. |
| `PORT` | `3002` | Puerto HTTP. |
| `HOST` | `0.0.0.0` | Interfaz de escucha. |
| `API_PREFIX` | `/api` | Prefijo de las rutas. |
| `CORS_ORIGIN` | `http://localhost:3000,http://localhost:3001` | Orígenes permitidos separados por comas. En producción, `*` o vacío deja la lista vacía y el arranque avisa por log. |
| `PANEL_USERNAME` | `admin` | Usuario del panel. |
| `PANEL_PASSWORD` | se genera | Contraseña del panel. Si no se define, se genera en `secrets/panel-password.txt`. |
| `PANEL_SESSION_TTL_MS` | `43200000` (12 h) | Duración de la sesión del panel. |
| `SOCKET_TOKEN_TTL_MS` | `1800000` (30 min) | Duración del token de Socket.IO. |
| `AUTH_ENCRYPTION_KEY` | se genera en desarrollo | Llave de cifrado: 64 hex o una frase de al menos 16 caracteres. Obligatoria en producción. |
| `AUTH_DIR` | `./auth` | Carpeta de credenciales de las sesiones y de los datos de autenticación. |
| `AUTH_KEYS_FILE` | `./auth/keys.json` | Catálogo de API keys (solo hashes y permisos). |
| `AUTH_USERS_FILE` | `./auth/panel-users.json` | Usuarios del panel (hash scrypt de la contraseña). |
| `AUTH_SESSIONS_FILE` | `./auth/panel-sessions.json` | Sesiones del panel y tokens de socket (solo hashes). |
| `DATA_DIR` | `./data` | Carpeta de historiales de chat. |
| `SECRETS_DIR` | `./secrets` | Carpeta de secretos locales. |
| `SOCKET_PUBLIC_URL` | `http://localhost:3002` | URL pública que devuelve el token de socket. |
| `ALERT_WEBHOOK_URL` | — | Webhook opcional para avisar cuando una línea queda caída. Solo recibe el id de sesión y su estado. |
| `WHATSAPP_CONNECT_TIMEOUT_MS` | `60000` | Tiempo de espera de la conexión con WhatsApp. |
| `WHATSAPP_KEEPALIVE_INTERVAL_MS` | `30000` | Intervalo del keepalive. |
| `WHATSAPP_MAX_RETRIES` | `3` | Reintentos de conexión. |
| `WHATSAPP_RETRY_DELAY_MS` | `5000` | Espera entre reintentos. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Ventana del rate limit de la API. |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Peticiones permitidas por ventana. |
| `SOCKET_PING_TIMEOUT` | `60000` | Tiempo de espera del ping de Socket.IO. |
| `SOCKET_PING_INTERVAL` | `25000` | Intervalo del ping de Socket.IO. |
| `MAX_REQUEST_SIZE` | `50mb` | Tamaño máximo del cuerpo de una petición. |
| `TRUST_PROXY` | — | `1` para confiar en el proxy de frente y leer `X-Forwarded-For`. |

## Uso

### Desarrollo

```bash
npm run dev
```

### Producción

```bash
npm start
```

El servidor queda disponible en `http://localhost:3002`.

### Pruebas

```bash
npm test
```

Usa el runner de Node (`node --test`), sin dependencias extra. Cubre el cifrado reversible y la migración de archivos en claro, el login del panel y el hash de las API keys, la política de reconexión, la copia de seguridad y su restauración, el agrupamiento de conversaciones con JID `@lid`, la normalización de medios y la respuesta pública sin llaves de medios.

### Copia de seguridad

```bash
npm run backup
```

## Autenticación

Hay dos formas de autenticarse.

**Panel.** `POST /api/auth/login` valida usuario y contraseña y devuelve un token de sesión. El panel lo guarda en la cookie httpOnly `hub_session` y lo reenvía como `Authorization: Bearer <token>`. El login tiene su propio límite: 8 intentos fallidos por IP cada 15 minutos.

```bash
curl -X POST http://localhost:3002/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"tu_contraseña"}'
```

La respuesta trae `token`, `username`, `expiresAt` y `maxAgeSeconds`. El token no se guarda en claro: solo su hash SHA-256 queda en `auth/panel-sessions.json`. `POST /api/auth/logout` revoca la sesión y los tokens de socket que nacieron de ella.

**API Key.** Los procesos automáticos siguen usando el header `X-API-Key`. La llave se guarda solo como hash SHA-256 en `auth/keys.json`; el valor en claro queda en `secrets/api-keys.txt` y nunca se imprime en el log. La primera vez que arranca el servidor se genera una llave con permisos `*`.

```bash
curl -H "X-API-Key: tu_api_key" http://localhost:3002/api/sessions
```

Si `auth/keys.json` todavía guarda llaves en claro, el primer arranque las migra: borra el valor del JSON, deja solo el hash y copia el texto plano a `secrets/api-keys.txt` con permisos `600`. Si esa copia ya existía no se sobrescribe, así que hay que rotar a mano las llaves que ya se publicaron.

`GET /api/health` y `POST /api/auth/login` son los únicos endpoints públicos. El resto exige una credencial válida.

### Tokens de socket

`POST /api/auth/socket-token` emite un token de corta duración (30 minutos por defecto) que solo se puede pedir con una sesión de panel: una API key responde `403 FORBIDDEN`. El token viaja en el handshake del socket, nunca en la query string.

```bash
curl -X POST http://localhost:3002/api/auth/socket-token \
  -H "Authorization: Bearer <token_del_panel>"
```

Devuelve `token`, `expiresAt` y `socketUrl` (el valor de `SOCKET_PUBLIC_URL`).

### Permisos

Cada llave y cada sesión del panel lleva una lista de permisos. `*` concede todo. La llave se traduce a un permiso según la ruta:

| Permiso | Rutas |
|---------|-------|
| `sessions:read` | `GET` de `/api/status` y del resto de rutas de solo lectura |
| `sessions:write` | `POST`, `PUT`, `PATCH` y `DELETE` de sesiones |
| `chats:read` | `GET` de chats y descarga de medios |
| `chats:write` | Escrituras sobre chats |
| `messages:send` | Rutas de envío de mensajes |

La sesión del panel entra siempre con `*`. Cada API key trae sus propios permisos, así que se puede acotar qué hace cada proceso automático.

Una petición sin permiso suficiente responde `403` con el código `FORBIDDEN`.

### Límite de peticiones

El rate limit se aplica por credencial (id de la llave o del usuario) y, si no hay, por IP: 100 peticiones por minuto por defecto. Las respuestas incluyen `X-RateLimit-Limit`, `X-RateLimit-Remaining` y `X-RateLimit-Reset`, y el excedente responde `429` con `RATE_LIMIT_EXCEEDED` y `retryAfter`.

### Códigos de error

| Código | HTTP | Cuándo |
|--------|------|--------|
| `MISSING_CREDENTIALS` | 401 | La petición no trae `X-API-Key` ni `Authorization: Bearer`. |
| `INVALID_API_KEY` | 401 | La llave no existe, está revocada o no corresponde. |
| `INVALID_SESSION` | 401 | El token de panel no existe o ya venció. |
| `INVALID_CREDENTIALS` | 401 | Usuario o contraseña incorrectos en el login. |
| `PANEL_NOT_CONFIGURED` | 503 | No hay ningún usuario de panel dado de alta. |
| `FORBIDDEN` | 403 | Falta el permiso, o el token de socket se pide con una API key. |
| `RATE_LIMIT_EXCEEDED` | 429 | Se pasó el límite de la ventana. |

## API Endpoints

### Autenticación

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| POST | `/api/auth/login` | Inicia sesión en el panel (público) |
| POST | `/api/auth/logout` | Revoca la sesión del panel y sus tokens de socket |
| GET | `/api/auth/me` | Usuario de la credencial actual |
| POST | `/api/auth/socket-token` | Token de corta duración para Socket.IO (solo sesión de panel) |

### Sistema

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/health` | Estado del servidor y conteo de sesiones (público) |
| GET | `/api/status` | Estado general de la API |

`GET /api/health` no exige credencial. Devuelve `status: healthy` o `degraded` (hay alguna línea caída) y el conteo de sesiones repartido en `total`, `connected`, `waiting` y `down`.

### Sesiones

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/sessions` | Listar todas las sesiones |
| POST | `/api/sessions` | Crear nueva sesión |
| GET | `/api/sessions/:id` | Ver estado de sesión |
| DELETE | `/api/sessions/:id` | Eliminar sesión |
| GET | `/api/sessions/:id/status` | Estado de conexión |
| POST | `/api/sessions/:id/pairing` | Solicitar código emparejamiento |
| POST | `/api/sessions/:id/logout` | Cerrar sesión WA |

`POST /api/sessions` acepta `phoneNumber` y `options.sessionId`. Si se manda `phoneNumber`, la carpeta de credenciales de esa sesión se reinicia para forzar un emparejamiento nuevo. El id de sesión se recorta a 8 caracteres, y la lista de sesiones conocidas se guarda en `data/sessions_meta.json` para restaurarlas al arrancar.

El estado de una sesión trae `status`, `connectedAt`, `hasQR`, `qrCode`, `hasPairing`, `pairingCode`, `reconnectAttempt`, `nextReconnectAt` y `lastDisconnect`.

### Mensajes y multimedia

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| POST | `/api/sessions/:id/send` | Enviar mensaje de texto |
| POST | `/api/sessions/:id/send-with-files` | Enviar con archivos (`multipart/form-data`, hasta 10 archivos de 50 MB) |
| GET | `/api/sessions/:id/chats` | Lista de conversaciones |
| GET | `/api/sessions/:id/chats/:phone` | Ver una conversación con sus mensajes |
| GET | `/api/sessions/:id/chats/:phone/messages` | Mensajes de chat |
| GET | `/api/sessions/:id/download/:messageId` | Descargar el archivo de un mensaje |

`send-with-files` manda un archivo por mensaje: el texto del campo `message` sale como primer mensaje de texto y los demás archivos van sin leyenda. La respuesta trae `messageId` (el primero) y `messageIds` (todos).

Las respuestas de mensajes no exponen la llave ni la ruta interna del medio: solo el tipo, el mime, el nombre y una miniatura en base64. Los archivos subidos se borran del disco al terminar el envío, y su nombre se sanea y se le antepone un sufijo aleatorio.

> `GET /api/sessions/:id/check/:phone` está escrito en `src/routes/sessions.js`, pero ese router no está montado en el servidor. Esa ruta responde `404 NOT_FOUND`. La verificación de número vive en `SessionManager.checkNumber`.

## WebSockets

Socket.IO exige un token de corta duración emitido por `POST /api/auth/socket-token`. El token viaja en el handshake (`auth.token`), no en la query string, y se valida igual en el namespace principal y en el de cada sesión.

```javascript
const { data } = await fetch('http://localhost:3002/api/auth/socket-token', {
  method: 'POST',
  headers: { Authorization: `Bearer ${tokenDelPanel}` },
}).then((r) => r.json());

const socket = io(data.socketUrl, {
  auth: { token: data.token },
  transports: ['polling', 'websocket'],
});
```

Hay dos formas de consumir los eventos:

- Namespace por sesión: `io('http://localhost:3002/session/<sessionId>', { auth: { token } })`
- Namespace principal, con `join_session` / `leave_session` para entrar y salir de las salas

Eventos emitidos:

| Evento | Contenido |
|--------|-----------|
| `status` | Estado de la conexión |
| `qr` | Código QR actualizado |
| `pairing_code` | Código de emparejamiento |
| `ready` | WhatsApp conectado |
| `disconnected` | Sesión cerrada |
| `new_message` | Mensaje nuevo con su conversación |
| `message_status` | Acuse de recibo de un mensaje |
| `chats_loaded` | Conteo de chats tras la sincronización |

Todos los eventos incluyen `sessionId`. `new_message` manda `phone`, el mensaje ya saneado y un resumen de la conversación (`phone`, `name`, `messageCount`), no el historial completo.

## Estados de sesión

| Estado | Descripción |
|--------|-------------|
| `disconnected` | Sin conexión |
| `waiting_qr` | Esperando el escaneo del QR |
| `waiting_pairing` | Esperando el código de emparejamiento |
| `connected` | Conectado |
| `reconnecting` | Reconectando tras una caída |
| `needs_repair` | Rechazo terminal: hay que volver a vincular la línea |

## Reconexión y alertas

Cuando WhatsApp cierra la conexión, la sesión no se borra. La política de reconexión espera 2 s y duplica en cada intento hasta un tope de 30 s, con un margen aleatorio del 20 %. Un rechazo con código 401, 403, 411, 440 o 500, o con motivo `BadSession` o `invalid_mechanisms`, detiene la sesión en `needs_repair` y conserva las credenciales y el historial. Un `515 restart required` reinicia la conexión a los 2 s.

Un watchdog revisa las líneas cada 60 s. Cuando una sesión queda en `needs_repair` o acumula 5 intentos de reconexión, se avisa por `ALERT_WEBHOOK_URL` con el id de sesión y su estado, nunca con mensajes. El aviso sale una sola vez por estado: mientras la línea siga igual no se repite.

## Almacenamiento y cifrado

| Ruta | Contenido |
|------|-----------|
| `auth/<sessionId>/` | Credenciales de Baileys (`creds.json`, claves de sesión) cifradas |
| `auth/keys.json` | API keys, solo con su hash SHA-256 y sus permisos |
| `auth/panel-users.json` | Usuarios del panel, con hash scrypt de la contraseña |
| `auth/panel-sessions.json` | Sesiones del panel y tokens de socket, solo con su hash |
| `data/<sessionId>/chats.json` | Historial de la sesión, cifrado |
| `data/sessions_meta.json` | Lista de sesiones conocidas |
| `secrets/auth.key` | Llave de cifrado local, generada en desarrollo |
| `secrets/api-keys.txt` | API keys en claro, para rotarlas fuera del repositorio |
| `secrets/panel-password.txt` | Contraseña del panel generada |
| `uploads/` | Archivos subidos, borrados al terminar el envío |
| `logs/` | Log de la API |
| `backups/` | Copias de seguridad |

El cifrado es AES-256-GCM con una llave derivada de `AUTH_ENCRYPTION_KEY` (scrypt) o de la llave de 32 bytes tal cual si viene en hexadecimal. Cada archivo se escribe de forma atómica y se verifica después de cifrarlo. Los archivos que estaban en claro se cifran solos en el primer arranque. Sin la llave no se pueden abrir las sesiones, así que hay que guardarla fuera del servidor.

Los secretos se escriben con permisos `600` y las contraseñas se guardan con scrypt y sal por usuario. La comparación de hashes usa `timingSafeEqual`.

## Copias de seguridad

`npm run backup` copia `auth/` y `data/` a `backups/<sello-de-tiempo>/` y escribe un `README.txt` de aviso. La copia no incluye la llave de cifrado: sin `AUTH_ENCRYPTION_KEY` el contenido no se puede leer. Para restaurar, copia `auth/` y `data/` de vuelta a sus rutas. El helper `src/utils/backup.js` expone `createBackup` y `restoreBackup` para automatizarlo.

## Seguridad

- CORS con lista explícita de orígenes. En producción, `CORS_ORIGIN=*` o vacío deja la lista vacía y el arranque avisa por log.
- Todas las respuestas llevan `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` y `Cache-Control: no-store`.
- Contraseñas y tokens se guardan solo como hash; las llaves en claro nunca se imprimen en el log.
- Los mensajes no exponen `mediaKey`, `mediaUrl` ni `mediaDirectPath`.
- El nombre de los archivos subidos se sanea y se le antepone un sufijo aleatorio.
- `TRUST_PROXY=1` solo si hay un proxy de frente: sin eso, `X-Forwarded-For` se ignora y el rate limit por IP usa la dirección real.

## Documentación

- `docs/API.md`: referencia de la API con ejemplos
- `openapi.json`: especificación OpenAPI 3.1

## Licencia

MIT

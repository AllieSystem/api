# MV WhatsApp Hub API — Referencia

API REST para gestión de múltiples sesiones de WhatsApp con Baileys. Cada sesión tiene su propio historial de chats, sus credenciales cifradas en reposo y sus eventos de socket.

**Versión:** 1.0.0  
**Licencia:** MIT  
**Última actualización:** Octubre 2026

## Tabla de Contenidos

- [Base URL](#base-url)
- [Autenticación](#autenticación)
  - [Sesión de panel](#sesión-de-panel)
  - [API Key](#api-key)
  - [Token de socket](#token-de-socket)
  - [Permisos](#permisos)
  - [Límite de peticiones](#límite-de-peticiones)
- [Endpoints](#endpoints)
  - [Autenticación](#autenticación-1)
  - [Sistema](#sistema)
  - [Sesiones](#sesiones)
  - [Mensajes](#mensajes)
  - [Chats](#chats)
- [WebSockets](#websockets)
- [Modelos de Datos](#modelos-de-datos)
- [Códigos de Error](#códigos-de-error)
- [Ejemplos](#ejemplos)

---

## Base URL

| Entorno | URL |
|---------|-----|
| Desarrollo | `http://localhost:3002/api` |
| Producción | `https://api.example.com/api` |

El prefijo es configurable con `API_PREFIX`.

---

## Autenticación

Hay dos credenciales, indistintas para el servidor. Se manda **una** o la otra, nunca las dos:

| Credencial | Header | Para qué |
|------------|--------|----------|
| Sesión de panel | `Authorization: Bearer <token>` | El panel web y cualquier cliente con sesión iniciada |
| API Key | `X-API-Key: <llave>` | Procesos automáticos |

Los tokens de sesión y las llaves se guardan **solo como hash**: SHA-256 para los tokens y las llaves, scrypt para las contraseñas. Los valores en claro nunca se imprimen en el log.

### Sesión de panel

`POST /auth/login` valida usuario y contraseña y devuelve un token de sesión con 12 horas de vigencia por defecto (`PANEL_SESSION_TTL_MS`).

El token viaja en `Authorization: Bearer <token>`. El panel web lo guarda en la cookie httpOnly `hub_session` y lo reenvía en cada llamada.

El login tiene su propio límite: **8 intentos fallidos por IP cada 15 minutos**. Al pasarse responde `429 RATE_LIMIT_EXCEEDED`.

`POST /auth/logout` revoca el token recibido y los tokens de socket que nacieron de él. `GET /auth/me` devuelve el usuario de la credencial actual.

### API Key

Las llaves viven en `auth/keys.json` y solo guardan su hash SHA-256. El valor en claro queda en `secrets/api-keys.txt` para poder rotarlas fuera del repositorio.

La primera vez que arranca el servidor se genera una llave con permisos `*`. Si `auth/keys.json` todavía guarda llaves en claro, el primer arranque las migra: borra el valor del JSON, deja solo el hash y copia el texto plano a `secrets/api-keys.txt` con permisos `600`.

### Token de socket

`POST /auth/socket-token` emite un token de corta duración (30 minutos por defecto, `SOCKET_TOKEN_TTL_MS`) para conectarse a Socket.IO. **Solo se puede pedir con una sesión de panel**: una API key responde `403 FORBIDDEN`.

El token viaja en el handshake del socket (`auth.token`), nunca en la query string. Se valida igual en el namespace principal y en el de cada sesión.

### Permisos

Cada llave lleva su propia lista de permisos. La sesión de panel entra siempre con `*`.

| Permiso | Rutas |
|---------|-------|
| `sessions:read` | `GET` de `/status` y del resto de rutas de solo lectura |
| `sessions:write` | `POST`, `PUT`, `PATCH` y `DELETE` de sesiones |
| `chats:read` | `GET` de chats y descarga de medios |
| `chats:write` | Escrituras sobre chats |
| `messages:send` | Rutas de envío de mensajes |

Una petición sin permiso suficiente responde `403 FORBIDDEN`.

### Límite de peticiones

100 peticiones por minuto y por credencial (o por IP si la petición no trae credencial). Todas las respuestas incluyen:

| Header | Significado |
|--------|-------------|
| `X-RateLimit-Limit` | Peticiones permitidas por ventana |
| `X-RateLimit-Remaining` | Peticiones que quedan |
| `X-RateLimit-Reset` | Segundos para que reinicie la ventana |

El excedente responde `429 RATE_LIMIT_EXCEEDED` con `retryAfter` en segundos.

---

## Endpoints

### Autenticación

#### POST /auth/login

Inicia sesión en el panel. Es público. El cuerpo lleva `username` y `password`.

**Respuesta (200):**
```json
{
  "success": true,
  "data": {
    "token": "0d1Xy9...",
    "username": "admin",
    "expiresAt": "2026-10-21T22:00:00.000Z",
    "maxAgeSeconds": 43200
  }
}
```

**Respuesta (401):** `INVALID_CREDENTIALS`.  
**Respuesta (429):** `RATE_LIMIT_EXCEEDED`, tras 8 intentos fallidos en 15 minutos.  
**Respuesta (503):** `PANEL_NOT_CONFIGURED`.

---

#### POST /auth/logout

Revoca el token de panel recibido y los tokens de socket que nacieron de él.

**Respuesta (200):**
```json
{ "success": true }
```

**Respuesta (401):** `INVALID_SESSION`.

---

#### GET /auth/me

Devuelve el usuario de la credencial actual. Con una sesión de panel es el nombre de usuario; con una API key, el nombre de la llave.

**Respuesta (200):**
```json
{
  "success": true,
  "data": { "username": "admin" }
}
```

**Respuesta (401):** `MISSING_CREDENTIALS`, `INVALID_API_KEY` o `INVALID_SESSION`.

---

#### POST /auth/socket-token

Emite un token de corta duración para Socket.IO. Solo se puede pedir con una sesión de panel.

**Respuesta (200):**
```json
{
  "success": true,
  "data": {
    "token": "Hk2Lp9...",
    "expiresAt": "2026-10-21T11:30:00.000Z",
    "socketUrl": "http://localhost:3002"
  }
}
```

**Respuesta (403):** `FORBIDDEN`, si la credencial es una API key.

---

### Sistema

#### GET /health

Público. Verifica el estado del servidor y cuenta las sesiones.

**Respuesta (200):**
```json
{
  "success": true,
  "status": "healthy",
  "version": "1.0.0",
  "uptime": 3600,
  "sessions": {
    "total": 3,
    "connected": 2,
    "waiting": 0,
    "down": 1
  },
  "timestamp": "2026-10-21T10:00:00.000Z"
}
```

`status` es `healthy` o `degraded` (hay alguna línea caída). `waiting` cuenta las sesiones esperando QR o código de emparejamiento.

---

#### GET /status

Estado general de la API. Requiere `sessions:read`.

**Respuesta (200):**
```json
{
  "success": true,
  "data": {
    "api": {
      "name": "MV WhatsApp Hub API",
      "version": "1.0.0",
      "environment": "development"
    },
    "sessions": {
      "count": 3,
      "list": [
        { "sessionId": "abc12345", "status": "connected" }
      ]
    },
    "keys": {
      "count": 1
    }
  }
}
```

**Respuesta (403):** falta el permiso `sessions:read`.

---

### Sesiones

#### GET /sessions

Lista todas las sesiones. Requiere `sessions:read`.

**Respuesta (200):**
```json
{
  "success": true,
  "data": [
    {
      "sessionId": "abc12345",
      "phoneNumber": "525556614579",
      "status": "connected",
      "connectedAt": "2026-10-21T09:30:00.000Z",
      "botPhoneNormalized": "525556614579",
      "reconnectAttempt": 0,
      "nextReconnectAt": null,
      "lastDisconnect": null
    }
  ],
  "count": 1
}
```

---

#### POST /sessions

Crea una sesión nueva. Requiere `sessions:write`.

**Parámetros (body, opcional):**
```json
{
  "phoneNumber": "525556614579",
  "options": {
    "sessionId": "mi_sesion_1"
  }
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| phoneNumber | string | Número de teléfono para emparejamiento. Si viene, la carpeta de credenciales se reinicia para forzar un emparejamiento nuevo. |
| options.sessionId | string | ID personalizado. Se recorta a 8 caracteres. |

Las sesiones conocidas se guardan en `data/sessions_meta.json` y se restauran al arrancar el servidor.

**Respuesta (201):**
```json
{
  "success": true,
  "data": {
    "sessionId": "abc12345",
    "phoneNumber": "525556614579",
    "status": "waiting_qr",
    "createdAt": "2026-10-21T10:00:00.000Z"
  }
}
```

**Respuesta (400):** la sesión ya existe o no se pudo crear.

---

#### GET /sessions/{sessionId}

Estado de una sesión. Requiere `sessions:read`.

**Parámetros de ruta:**
| Nombre | Tipo | Requerido | Descripción |
|--------|------|-----------|-------------|
| sessionId | string | Sí | ID de la sesión |

**Respuesta (200):**
```json
{
  "success": true,
  "data": {
    "sessionId": "abc12345",
    "phoneNumber": "525556614579",
    "status": "waiting_pairing",
    "connectedAt": null,
    "hasQR": false,
    "qrCode": null,
    "hasPairing": true,
    "pairingCode": "ABCD1234",
    "reconnectAttempt": 0,
    "nextReconnectAt": null,
    "lastDisconnect": null
  }
}
```

`qrCode` y `pairingCode` solo se devuelven mientras la sesión está en `waiting_qr` o `waiting_pairing` respectivamente. En cualquier otro estado van en `null`.

**Respuesta (404):** sesión no encontrada.

---

#### DELETE /sessions/{sessionId}

Elimina una sesión. Requiere `sessions:write`. Cierra la línea en WhatsApp y borra sus carpetas de credenciales e historial.

**Respuesta (200):**
```json
{
  "success": true,
  "data": {
    "message": "Sesión abc12345 eliminada"
  }
}
```

**Respuesta (404):** sesión no encontrada.

---

#### GET /sessions/{sessionId}/status

Estado detallado de conexión. Requiere `sessions:read`. Devuelve lo mismo que `GET /sessions/{sessionId}`.

---

#### POST /sessions/{sessionId}/pairing

Solicita el código de emparejamiento de 8 dígitos. Requiere `sessions:write`.

**Parámetros de body (requerido):**
```json
{
  "phone": "525556614579"
}
```

**Respuesta (200):**
```json
{
  "success": true,
  "data": {
    "code": "ABCD1234",
    "phone": "525556614579"
  }
}
```

**Respuesta (400):** falta el número de teléfono.  
**Respuesta (404):** sesión no encontrada.

---

#### POST /sessions/{sessionId}/logout

Cierra la sesión de WhatsApp. Requiere `sessions:write`. Desvincula la línea y borra sus carpetas de credenciales e historial.

**Respuesta (200):**
```json
{
  "success": true,
  "data": {
    "message": "Sesión cerrada"
  }
}
```

**Respuesta (404):** sesión no encontrada.

---

### Mensajes

#### POST /sessions/{sessionId}/send

Envía un mensaje de texto. Requiere `messages:send`.

**Parámetros de body (requerido):**
```json
{
  "phone": "525556614579",
  "message": "Hola desde la API"
}
```

**Respuesta (200):**
```json
{
  "success": true,
  "data": {
    "messageId": "3EB0A1B2C3",
    "phone": "525556614579"
  }
}
```

**Respuesta (400):** faltan el número o el mensaje.  
**Respuesta (404):** sesión no encontrada.

---

#### POST /sessions/{sessionId}/send-with-files

Envía archivos. Requiere `messages:send`.

**Parámetros de body (multipart/form-data):**
| Campo | Tipo | Descripción |
|-------|------|-------------|
| phone | string | Número de destino (requerido) |
| message | string | Leyenda del primer archivo |
| files | file[] | Hasta 10 archivos de 50 MB cada uno |

Se manda **un archivo por mensaje**: el texto de `message` sale como primer mensaje de texto y los demás archivos van sin leyenda. Los archivos subidos se borran del disco al terminar el envío y su nombre se sanea antes de guardarse.

**Respuesta (200):**
```json
{
  "success": true,
  "data": {
    "messageId": "3EB0A1B2C3",
    "messageIds": ["3EB0A1B2C3", "3EB0A1B2C4"],
    "phone": "525556614579"
  }
}
```

`messageId` es el primero; `messageIds` trae todos.

**Respuesta (400):** falta el número, o no hay archivo ni mensaje.  
**Respuesta (413):** un archivo pasa de 50 MB (`FILE_TOO_LARGE`).  
**Respuesta (404):** sesión no encontrada.

---

#### GET /sessions/{sessionId}/download/{messageId}

Descarga el archivo de un mensaje. Requiere `chats:read`. El archivo se baja de WhatsApp en el momento.

**Respuesta (200):**
- Content-Type: el mime del archivo
- Content-Disposition: `attachment; filename="..."`
- Body: contenido binario

**Respuesta (404):** sesión no encontrada.  
**Respuesta (500):** el mensaje no tiene archivo o no se pudo descargar.

---

> **Nota.** `GET /sessions/{sessionId}/check/{phone}` está escrito en `src/routes/sessions.js`, pero ese router no está montado en el servidor, así que responde `404 NOT_FOUND`. La verificación de número vive en `SessionManager.checkNumber`.

---

### Chats

#### GET /sessions/{sessionId}/chats

Lista de conversaciones. Requiere `chats:read`. Las conversaciones se agrupan por teléfono, aunque WhatsApp las entregue con JID `@lid`.

**Respuesta (200):**
```json
{
  "success": true,
  "data": [
    {
      "phone": "525556614579",
      "name": "Ada",
      "lastMessage": {
        "id": "3EB0A1B2C3",
        "text": "¿Nos vemos mañana?",
        "timestamp": 1761249600000,
        "isOutgoing": false
      },
      "messageCount": 42
    }
  ],
  "count": 1
}
```

---

#### GET /sessions/{sessionId}/chats/{phone}

Una conversación con sus mensajes. Requiere `chats:read`.

**Parámetros de ruta:**
| Nombre | Tipo | Requerido | Descripción |
|--------|------|-----------|-------------|
| sessionId | string | Sí | ID de la sesión |
| phone | string | Sí | Teléfono, o los últimos dígitos de un JID `@lid` |

**Respuesta (200):**
```json
{
  "success": true,
  "data": {
    "phone": "525556614579",
    "name": "Ada",
    "timestamp": 1761249600000,
    "lastMessage": { "id": "3EB0A1B2C3", "text": "¿Nos vemos mañana?" },
    "messageCount": 2,
    "messages": [
      { "id": "3EB0A1B2C2", "text": "Hola", "timestamp": 1761249540000, "isOutgoing": true },
      { "id": "3EB0A1B2C3", "text": "¿Nos vemos mañana?", "timestamp": 1761249600000, "isOutgoing": false }
    ]
  }
}
```

**Respuesta (404):** sesión o chat no encontrado.

---

#### GET /sessions/{sessionId}/chats/{phone}/messages

Mensajes de un chat. Requiere `chats:read`.

**Respuesta (200):**
```json
{
  "success": true,
  "data": [
    { "id": "3EB0A1B2C2", "text": "Hola", "timestamp": 1761249540000, "isOutgoing": true }
  ],
  "count": 1
}
```

**Respuesta (404):** sesión no encontrada.

---

## WebSockets

Socket.IO exige un token emitido por `POST /auth/socket-token`. El token viaja en el handshake (`auth.token`), no en la query string.

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

- **Namespace por sesión:** `io('http://localhost:3002/session/<sessionId>', { auth: { token } })`
- **Namespace principal:** `join_session` / `leave_session` para entrar y salir de las salas

```javascript
socket.emit('join_session', 'abc12345');
socket.emit('leave_session', 'abc12345');
```

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

---

## Modelos de Datos

### Session

```json
{
  "sessionId": "abc12345",
  "phoneNumber": "525556614579 | null",
  "status": "disconnected | waiting_qr | waiting_pairing | connected | reconnecting | needs_repair",
  "connectedAt": "datetime | null",
  "botPhoneNormalized": "string | null",
  "reconnectAttempt": 0,
  "nextReconnectAt": "datetime | null",
  "lastDisconnect": {
    "statusCode": 401,
    "reason": "401 Connection Failure",
    "at": "datetime"
  }
}
```

### Chat

```json
{
  "phone": "525556614579",
  "name": "Ada",
  "timestamp": 1761249600000,
  "lastMessage": "Message | null",
  "messageCount": 42,
  "messages": "Message[]"
}
```

### Message

```json
{
  "id": "3EB0A1B2C3",
  "text": "Hola",
  "timestamp": 1761249600000,
  "waTimestamp": 1761249600,
  "isOutgoing": false,
  "jid": "525556614579@s.whatsapp.net",
  "senderPhone": "525556614579 | null",
  "mediaType": "image | video | audio | document | sticker | null",
  "mediaMimeType": "image/jpeg | null",
  "mediaThumbnail": "base64 | null",
  "mediaFileName": "image-1761249600000.jpg | null",
  "mediaFileLength": 284512 | null",
  "quotedMsg": {
    "id": "3EB0A1B2C1",
    "text": "mensaje citado",
    "sender": "525556614579"
  }
}
```

La API nunca expone `mediaKey`, `mediaUrl` ni `mediaDirectPath`. Para bajar el archivo, usa `GET /sessions/{sessionId}/download/{messageId}`.

---

## Códigos de Error

| Código | HTTP | Descripción |
|--------|------|-------------|
| `MISSING_CREDENTIALS` | 401 | La petición no trae `X-API-Key` ni `Authorization: Bearer` |
| `INVALID_API_KEY` | 401 | La llave no existe, está revocada o no corresponde |
| `INVALID_SESSION` | 401 | El token de panel no existe o ya venció |
| `INVALID_CREDENTIALS` | 401 | Usuario o contraseña incorrectos en el login |
| `PANEL_NOT_CONFIGURED` | 503 | No hay ningún usuario de panel dado de alta |
| `FORBIDDEN` | 403 | Falta el permiso, o el token de socket se pide con una API key |
| `RATE_LIMIT_EXCEEDED` | 429 | Se pasó el límite de la ventana |
| `VALIDATION_ERROR` | 400 | Los datos del body no son válidos |
| `FILE_TOO_LARGE` | 413 | Un archivo pasa de 50 MB |
| `CSRF_ERROR` | 403 | Token CSRF inválido |
| `NOT_FOUND` | 404 | La ruta o el recurso no existe |
| `INTERNAL_ERROR` | 500 | Error del servidor |

**Formato de error:**
```json
{
  "success": false,
  "error": "Permiso insuficiente",
  "code": "FORBIDDEN"
}
```

Las respuestas `429` añaden `retryAfter` con los segundos que faltan para que reinicie la ventana.

---

## Ejemplos

### cURL

**Iniciar sesión en el panel:**
```bash
curl -X POST http://localhost:3002/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"tu_contraseña"}'
```

**Pedir un token de socket:**
```bash
curl -X POST http://localhost:3002/api/auth/socket-token \
  -H "Authorization: Bearer <token_del_panel>"
```

**Listar sesiones:**
```bash
curl -X GET http://localhost:3002/api/sessions \
  -H "X-API-Key: tu_api_key"
```

**Crear sesión:**
```bash
curl -X POST http://localhost:3002/api/sessions \
  -H "X-API-Key: tu_api_key" \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "525556614579"}'
```

**Enviar mensaje:**
```bash
curl -X POST http://localhost:3002/api/sessions/abc12345/send \
  -H "X-API-Key: tu_api_key" \
  -H "Content-Type: application/json" \
  -d '{"phone": "525556614579", "message": "Hola!"}'
```

**Enviar un archivo:**
```bash
curl -X POST http://localhost:3002/api/sessions/abc12345/send-with-files \
  -H "X-API-Key: tu_api_key" \
  -F "phone=525556614579" \
  -F "message=Aquí va la foto" \
  -F "files=@/ruta/foto.jpg"
```

**Descargar el archivo de un mensaje:**
```bash
curl -X GET http://localhost:3002/api/sessions/abc12345/download/3EB0A1B2C3 \
  -H "X-API-Key: tu_api_key" \
  -o foto.jpg
```

### JavaScript

```javascript
const API_KEY = 'tu_api_key';
const BASE_URL = 'http://localhost:3002/api';

const response = await fetch(`${BASE_URL}/sessions`, {
  headers: { 'X-API-Key': API_KEY }
});
const data = await response.json();
console.log(data);
```

### Python

```python
import requests

API_KEY = 'tu_api_key'
BASE_URL = 'http://localhost:3002/api'

headers = {'X-API-Key': API_KEY}
response = requests.get(f'{BASE_URL}/sessions', headers=headers)
print(response.json())
```

---

## Estados de Sesión

| Estado | Descripción |
|--------|-------------|
| `disconnected` | Sin conexión |
| `waiting_qr` | Esperando el escaneo del QR |
| `waiting_pairing` | Esperando el código de emparejamiento |
| `connected` | Conectado |
| `reconnecting` | Reconectando tras una caída |
| `needs_repair` | Rechazo terminal: hay que volver a vincular la línea |

Cuando WhatsApp cierra la conexión, la sesión no se borra. La reconexión espera 2 s y duplica en cada intento hasta un tope de 30 s, con un margen aleatorio del 20 %. Un rechazo con código 401, 403, 411, 440 o 500, o con motivo `BadSession` o `invalid_mechanisms`, detiene la sesión en `needs_repair` y conserva las credenciales y el historial.

Un watchdog revisa las líneas cada 60 s. Cuando una sesión queda en `needs_repair` o acumula 5 intentos de reconexión, se avisa por `ALERT_WEBHOOK_URL` con el id de sesión y su estado, nunca con mensajes.

---

## Licencia

MIT License - Ver [LICENSE](https://opensource.org/licenses/MIT)

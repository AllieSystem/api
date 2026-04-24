# Allie_Whats_API

API REST para gestión de múltiples sesiones de WhatsApp usando Baileys.

## Características

- Gestión de múltiples sesiones de WhatsApp simultáneas
- Autenticación mediante API Key
- Envío y recepción de mensajes en tiempo real
- Soporte para archivos multimedia
- API REST documentada con OpenAPI 3.1/init
- WebSockets para eventos en tiempo real

## Requisitos

- Node.js 18+
- npm o yarn

## Instalación

```bash
npm install
```

## Configuración

La API Keys se genera automáticamente en `auth/keys.json`. También puedes copiar `.env.example` a `.env`:

```bash
cp .env.example .env
```

## Uso

### Desarrollo

```bash
npm run dev
```

### Producción

```bash
npm start
```

El servidor estará disponible en `http://localhost:3000`

## Autenticación

Todas las rutas de la API requieren el header `X-API-Key`:

```bash
curl -H "X-API-Key: tu_api_key" http://localhost:3000/api/sessions
```

La API Key se genera automáticamente al iniciar el servidor. También puedes usar el endpoint `/api/status` sin autenticación para verificar.

## API Endpoints

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

### Mensajes

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| POST | `/api/sessions/:id/send` | Enviar mensaje |
| POST | `/api/sessions/:id/send-with-files` | Enviar con archivos |
| GET | `/api/sessions/:id/chats` | Lista de conversaciones |
| GET | `/api/sessions/:id/chats/:phone/messages` | Mensajes de chat |
| GET | `/api/sessions/:id/check/:phone` | Verificar WhatsApp |

### Sistema

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/health` | Estado del servidor |
| GET | `/api/status` | Estado general de la API |

## WebSockets

Conecta mediante Socket.io:

```javascript
const socket = io('http://localhost:3000/session/sessionId');
```

Eventos:
- `status` - Estado de conexión
- `qr` - Código QR actualizado
- `pairing_code` - Código de emparejamiento
- `ready` - WhatsApp conectado
- `disconnected` - Desconectado
- `new_message` - Nuevo mensaje

## Documentación OpenAPI

Disponible en `openapi.json` o en `/api/docs` con Swagger UI (si está configurado).

## Licencia

MIT
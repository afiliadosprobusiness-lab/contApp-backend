# Contrato de integracion actual - contapp

Documento descriptivo (no prescriptivo) del comportamiento observado en codigo.

## Proposito

Describir el contrato real compartido por estos repos:

- `contApp-peru` (frontend + endpoints serverless locales)
- `contapp-pe-backend` (backend principal: chat IA + PayPal)
- `contapp-pe-sunat-worker` (worker SUNAT)

El objetivo es documentar el comportamiento vigente sin imponer cambios de arquitectura.

## Modelos de datos compartidos

Colecciones/subcolecciones Firestore observadas:

### `users/{uid}`

Campos observados:

- `uid`, `email`, `displayName`, `photoURL`, `phone`
- `plan` (`FREE|PRO|PLUS` en frontend; backend de pagos usa `PRO|PLUS`)
- `role` (`USER|ADMIN`)
- `status` (`TRIAL|ACTIVE|SUSPENDED`)
- `trialEndsAt`
- `paypalSubscriptionId`, `paypalPlanId`, `pendingPlan`
- `createdAt`, `updatedAt`

### `users/{uid}/businesses/{businessId}`

Campos observados:

- `ruc`
- `name`
- `type`
- `status` (`ACTIVE|INACTIVE`)
- `sunatSecondaryUser`
- `createdAt`, `updatedAt`

### `users/{uid}/businesses/{businessId}/comprobantes/{comprobanteId}`

Campos observados:

- `type` (`VENTA|COMPRA`)
- `serie`, `numero`
- `fecha` (Timestamp)
- `cliente` (ventas)
- `proveedor` (compras)
- `monto`, `igv`
- `source` (observado `SUNAT` cuando viene del worker)
- `raw` (linea origen de archivo SUNAT)
- `createdAt`, `updatedAt`

Origen de datos en runtime:

- Carga manual desde frontend (addDoc)
- Sincronizacion automatica SUNAT desde worker

### `users/{uid}/sunat_sync/{businessId}`

Campos observados:

- `status` (`RUNNING|OK|ERROR`)
- `lastPeriod` (`year`, `month`)
- `lastResult` (`ventas`, `compras`)
- `lastRunAt`
- `lastError`
- `updatedAt`

### `users/{uid}/sunat_credentials/{businessId}`

Campos observados:

- `encrypted`: objeto cifrado `{ iv, tag, data }`
- `createdAt`, `updatedAt`

### `sunat_ruc_cache/{ruc}`

Campos observados:

- `ruc`, `name`, `type`, `status`, `condition`, `ubigeo`, `address`, `source`
- `updatedAt`

Asuncion:

- Existe referencia en reglas a `subscriptions/{subscriptionId}`, pero en este codigo no se observaron escrituras/lecturas activas a esa coleccion.

## Endpoints del backend

## Backend principal (`contapp-pe-backend`)

### `GET /health`

- `200`: `{ ok: true }`

### `POST /chat` (Bearer Firebase requerido)

Body:

- `messages` (array, requerido)
- `model` (opcional, default `gpt-4o-mini`)

Respuestas:

- `200`: `{ reply: string }`
- `400`: `{ error: "Missing OPENAI_API_KEY" }`
- `400`: `{ error: "Missing messages" }`
- `401`: `{ error: "Missing auth token" | "Invalid token" }`
- Error OpenAI: mismo status de OpenAI con `{ error }`
- `500`: `{ error: "Server error" | detalle }`

### `POST /paypal/create-subscription` (Bearer Firebase requerido)

Body:

- `planCode` (`PRO|PLUS`)

Respuestas:

- `200`: `{ approvalUrl, subscriptionId }`
- `400`: `{ error: "Invalid plan" }`
- Error PayPal: mismo status remoto con `{ error }`
- `500`: `{ error: "No approval link" | "Server error" }`

### `POST /paypal/webhook`

Respuestas:

- `400`: `{ error: "Webhook not verified" }`
- `200`: `{ ok: true, ignored: true }` si no encuentra usuario destino
- `200`: `{ ok: true }` cuando actualiza usuario
- `500`: `{ error: "Webhook error" | detalle }`

## Worker SUNAT (`contapp-pe-sunat-worker`)

### `GET /health`

- `200`: `{ ok: true }`

### `POST /sunat/credentials` (Bearer Firebase requerido)

Body requerido:

- `businessId`
- `ruc`
- `solUser`
- `solPassword`

Respuestas:

- `200`: `{ ok: true }`
- `400`: `{ error: "Missing fields" }`
- `401`: `{ error: "Missing auth token" | "Invalid token" }`
- `500`: `{ error: "Could not store credentials" }`

### `POST /sunat/ruc` (Bearer Firebase requerido)

Body:

- `ruc`

Respuestas:

- `200`: `{ ok: true, data }`
- `400`: `{ error: "Missing ruc" }`
- `400`: `{ error: "RUC invalido" }`
- `401`: auth error
- `404`: `{ error: "RUC no encontrado en padron SUNAT." }` (cuando `SUNAT_MOCK=false`)
- `500`: `{ error: "No se pudo consultar el RUC" | detalle }`

### `POST /sunat/sync` (Bearer Firebase requerido)

Body requerido:

- `businessId`
- `year`
- `month`

Respuestas:

- `200`: `{ ok: true, result }` (`result` incluye conteos `ventas` y `compras`)
- `400`: `{ error: "Missing fields" }`
- `400`: `{ error: "Missing credentials" }`
- `401`: auth error
- `500`: `{ error: "Sync failed" | detalle }`

### `GET /sunat/status?businessId=...` (Bearer Firebase requerido)

Respuestas:

- `200`: `{ status: "IDLE" }` si no existe documento
- `200`: `{ status: <objeto de estado> }` si existe
- `400`: `{ error: "Missing businessId" }`
- `401`: auth error

## Endpoints serverless en frontend (`contApp-peru/api/*`)

Codigo observado:

- `POST /api/chat`
- `POST /api/paypal/create-subscription`
- `POST /api/paypal/webhook`

Comportamiento:

- Implementan logica equivalente al backend principal para chat y PayPal.
- `postWithAuth` del frontend usa:
  - `${VITE_BACKEND_URL}${path}` cuando `VITE_BACKEND_URL` existe
  - fallback `/api${path}` cuando no existe

Asuncion:

- En despliegue actual, la ruta efectiva puede ir directo a Cloud Run o a endpoints serverless locales segun `VITE_BACKEND_URL` configurado.

## Formato de errores

Formatos observados:

- JSON simple: `{ error: "..." }`
- Exitos de procesos suelen usar:
  - `{ ok: true, ... }` (worker/paypal webhook)
  - `{ reply: "..." }` (chat)
  - `{ approvalUrl, subscriptionId }` (create-subscription)
- En frontend, wrappers (`postWithAuth`, `postJson`) convierten `!response.ok` en `throw Error(data.error || mensaje generico)`.

## Reglas de compatibilidad hacia atras

Comportamientos actuales que el frontend y dashboard consumen:

- `POST /chat` debe seguir devolviendo `reply` string
- `POST /paypal/create-subscription` debe mantener `approvalUrl` + `subscriptionId`
- `POST /paypal/webhook` mantiene updates sobre `users/{uid}` (`plan`, `status`, `pendingPlan`, ids PayPal)
- Endpoints SUNAT deben conservar:
  - guardado cifrado en `sunat_credentials`
  - estado en `sunat_sync`
  - escritura de comprobantes en `users/{uid}/businesses/{businessId}/comprobantes`
- `GET /sunat/status` mantiene contrato dual actual:
  - `status: "IDLE"` (string) o
  - `status: { ... }` (objeto)
- Firestore realtime del frontend depende de los nombres actuales de campos en `users`, `businesses`, `comprobantes` y `sunat_sync`.

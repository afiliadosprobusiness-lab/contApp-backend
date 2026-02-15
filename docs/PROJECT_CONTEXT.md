# ContApp Pe (Backend Principal) — Project Context

## Objetivo de negocio
Backend principal para ContApp: centraliza lógica sensible y secretos. Maneja chat IA (OpenAI) y suscripciones PayPal (creación y webhooks) para activar planes de usuarios.

## Tech Stack
- Runtime: Node.js (>= 20) en Cloud Run
- Framework: Express
- Auth/DB: Firebase Admin SDK (Auth + Firestore)
- IA: OpenAI SDK (solo backend)
- Pagos: PayPal API + webhooks
- Deploy: Google Cloud Run

## Arquitectura (decisiones clave)
- Servicio stateless:
  - Persistencia en Firestore.
  - Autorización basada en Firebase ID Token.
- Seguridad:
  - `OPENAI_API_KEY` y credenciales PayPal viven solo en Cloud Run.
  - El frontend nunca debe hablar directo con OpenAI ni almacenar secrets.
- CORS explícito:
  - `CORS_ORIGIN` lista orígenes permitidos (CSV).

## Endpoints (alto nivel)
- `GET /health`
- `POST /chat` (requiere auth Firebase)
- `POST /paypal/create-subscription` (requiere auth Firebase)
- `POST /paypal/webhook` (webhook PayPal)
- `POST /billing/invoices` (requiere auth Firebase)
- `GET /billing/invoices` (requiere auth Firebase)
- `GET /billing/invoices/:invoiceId/payments` (requiere auth Firebase)
- `POST /billing/invoices/:invoiceId/payments` (requiere auth Firebase)
- `POST /billing/invoices/:invoiceId/mark-paid` (requiere auth Firebase)
- `POST /billing/invoices/:invoiceId/emit-cpe` (requiere auth Firebase; relay a worker SUNAT)

## Convenciones de código
- ESM (`type: module`).
- Validar inputs en el borde (si no hay zod aquí, mantener checks manuales consistentes).
- Errores: status HTTP correcto y sin filtrar información sensible.

## Variables de entorno (resumen)
- `FIREBASE_SERVICE_ACCOUNT`
- `OPENAI_API_KEY`
- `PAYPAL_ENV`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`
- `PAYPAL_PLAN_ID_PRO`, `PAYPAL_PLAN_ID_PLUS`
- `CORS_ORIGIN`, `APP_BASE_URL`
- `SUNAT_WORKER_URL`
- `REQUEST_TIMEOUT_MS`

## Actualizacion 2026-02-15

### Billing API
- Se incorpora modulo `billing` para emitir documentos y gestionar cobranzas.
- La emision persiste en:
  - `users/{uid}/businesses/{businessId}/invoices/{invoiceId}`
  - `users/{uid}/businesses/{businessId}/comprobantes/{comprobanteId}` (compatibilidad dashboard legacy)
- La cobranza parcial/total persiste en:
  - `users/{uid}/businesses/{businessId}/invoices/{invoiceId}/payments/{paymentId}`

### Reglas de negocio en backend
- Unicidad de comprobante por `documentType + serie + numero` dentro del negocio (id deterministico por hash).
- `FACTURA` solo acepta `customerDocumentType = RUC`.
- `dueDate` no puede ser menor a `issueDate`.
- Abonos no pueden exceder el saldo.
- Actualizacion transaccional de `paidAmount`, `balance`, `paymentStatus` en cada pago.

## Actualizacion 2026-02-15 (fase CPE)

### Relay CPE hacia worker SUNAT
- El backend incorpora `POST /billing/invoices/:invoiceId/emit-cpe`.
- El endpoint valida autenticacion y existencia de factura, luego reenvia la solicitud a `POST {SUNAT_WORKER_URL}/sunat/cpe/emit`.
- Se reusa el mismo Firebase ID Token del usuario para mantener trazabilidad/seguridad en worker.

### Campos CPE expuestos por Billing API
- `GET /billing/invoices` ahora retorna tambien:
  - `cpeStatus`
  - `cpeProvider`
  - `cpeTicket`
  - `cpeCode`, `cpeDescription`
  - `cpeError`
  - `cpeLastAttemptAt`, `cpeAcceptedAt`

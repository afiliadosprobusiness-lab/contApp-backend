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


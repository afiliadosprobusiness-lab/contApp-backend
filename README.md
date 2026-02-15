# ContApp Pe - Backend

Backend principal para ContApp (PayPal + OpenAI), pensado para Cloud Run.

## Requisitos
- Node 20+
- Google Cloud Run (recomendado)
- Firebase Admin SDK

## Variables de entorno
- `CORS_ORIGIN`: dominios permitidos (separados por coma).
- `APP_BASE_URL`: URL del frontend para callbacks (ej: `https://contapp-pe.vercel.app`).
- `FIREBASE_SERVICE_ACCOUNT`: JSON del service account (string en una sola linea).
- `OPENAI_API_KEY`: API key de OpenAI.
- `PAYPAL_ENV`: `live` o `sandbox`.
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_WEBHOOK_ID`
- `PAYPAL_PLAN_ID_PRO`
- `PAYPAL_PLAN_ID_PLUS`
- `SUNAT_WORKER_URL`: URL base del worker SUNAT para relay CPE.
- `REQUEST_TIMEOUT_MS`: timeout de requests salientes (default: 30000).

## Endpoints
- `POST /chat` (requiere auth Firebase)
- `POST /paypal/create-subscription` (requiere auth Firebase)
- `POST /paypal/webhook` (Webhook de PayPal)
- `POST /billing/invoices` (requiere auth Firebase)
- `GET /billing/invoices` (requiere auth Firebase)
- `GET /billing/invoices/:invoiceId/payments` (requiere auth Firebase)
- `POST /billing/invoices/:invoiceId/payments` (requiere auth Firebase)
- `POST /billing/invoices/:invoiceId/mark-paid` (requiere auth Firebase)
- `POST /billing/invoices/:invoiceId/emit-cpe` (requiere auth Firebase, relay a worker SUNAT)
- `GET /health`

## Deploy (Cloud Run)
1. Construir imagen: `gcloud builds submit --tag gcr.io/PROJECT_ID/contapp-pe-backend`
2. Desplegar: `gcloud run deploy contapp-pe-backend --image gcr.io/PROJECT_ID/contapp-pe-backend --region us-central1 --allow-unauthenticated`
3. Configurar variables de entorno en Cloud Run

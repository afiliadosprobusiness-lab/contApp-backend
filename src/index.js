import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { firebaseAdmin, firestore } from "./firebase.js";
import { getPaypalBaseUrl, getPaypalToken, verifyPaypalWebhook } from "./paypal.js";

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;
const actionTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 30000);

const normalizeBaseUrl = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
};

const parseOrigins = () => {
  const raw = process.env.CORS_ORIGIN || "";
  const list = raw.split(",").map((item) => item.trim()).filter(Boolean);
  return list.length ? list : true;
};

app.use(cors({ origin: parseOrigins() }));
app.use(express.json({ limit: "1mb" }));

const requireAuth = async (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing auth token" });
  }

  try {
    const decoded = await firebaseAdmin.auth().verifyIdToken(token);
    req.user = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid token" });
  }
};

const planFromId = (planId) => {
  if (!planId) return null;
  if (planId === process.env.PAYPAL_PLAN_ID_PRO) return "PRO";
  if (planId === process.env.PAYPAL_PLAN_ID_PLUS) return "PLUS";
  return null;
};

const getPlanId = (planCode) => {
  if (planCode === "PRO") return process.env.PAYPAL_PLAN_ID_PRO;
  if (planCode === "PLUS") return process.env.PAYPAL_PLAN_ID_PLUS;
  return null;
};

const getBaseUrl = (req) => {
  return process.env.APP_BASE_URL || req.headers.origin || `https://${req.headers.host}`;
};

const getSunatWorkerUrl = () => {
  const url = normalizeBaseUrl(process.env.SUNAT_WORKER_URL);
  if (!url) {
    throw asApiError(500, "Missing SUNAT_WORKER_URL");
  }
  return url;
};

const BILLING_DOC_TYPES = new Set(["FACTURA", "BOLETA"]);
const BILLING_CUSTOMER_DOC_TYPES = new Set(["RUC", "DNI", "OTRO"]);
const BILLING_PAYMENT_STATUSES = new Set(["PENDIENTE", "PARCIAL", "PAGADO", "VENCIDO"]);
const DECIMAL_EPSILON = 0.000001;

const asApiError = (status, message) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const round2 = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const parseDecimal = (value) => {
  const normalized = String(value ?? "").trim().replace(",", ".");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
};

const parseTaxRate = (value) => {
  const parsed = parseDecimal(value);
  if (parsed === null || parsed < 0) return null;
  if (parsed > 100) return null;
  return parsed > 1 ? parsed / 100 : parsed;
};

const parseDateInput = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
};

const toIsoOrNull = (value) => {
  if (!value) return null;
  if (typeof value?.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const buildInvoiceId = (documentType, serie, numero) =>
  crypto.createHash("sha1").update(`${documentType}|${serie}|${numero}`).digest("hex");

const normalizePaymentStatus = (status, balance, dueDate) => {
  if (balance <= DECIMAL_EPSILON) return "PAGADO";
  if (status === "PARCIAL") return "PARCIAL";
  if (dueDate) {
    const due = new Date(dueDate);
    due.setHours(23, 59, 59, 999);
    if (due.getTime() < Date.now()) return "VENCIDO";
  }
  if (status && BILLING_PAYMENT_STATUSES.has(status)) return status;
  return "PENDIENTE";
};

const mapInvoiceDoc = (id, raw) => {
  const total = round2(raw?.total || 0);
  const paidAmount = round2(raw?.paidAmount || 0);
  const balance = round2(raw?.balance ?? total - paidAmount);
  const issueDateIso = toIsoOrNull(raw?.issueDate);
  const dueDateIso = toIsoOrNull(raw?.dueDate);

  return {
    id,
    documentType: raw?.documentType || "BOLETA",
    serie: raw?.serie || "",
    numero: raw?.numero || "",
    customerName: raw?.customerName || "",
    customerDocumentType: raw?.customerDocumentType || "OTRO",
    customerDocumentNumber: raw?.customerDocumentNumber || "",
    issueDate: issueDateIso,
    dueDate: dueDateIso,
    subtotal: round2(raw?.subtotal || 0),
    igv: round2(raw?.igv || 0),
    total,
    paidAmount,
    balance,
    paymentStatus: normalizePaymentStatus(raw?.paymentStatus, balance, dueDateIso),
    status: raw?.status || "EMITIDO",
    source: raw?.source || "BACKEND",
    items: Array.isArray(raw?.items) ? raw.items : [],
    cpeStatus: raw?.cpeStatus || null,
    cpeProvider: raw?.cpeProvider || null,
    cpeTicket: raw?.cpeTicket || null,
    cpeCode: raw?.cpeCode ?? null,
    cpeDescription: raw?.cpeDescription ?? null,
    cpeError: raw?.cpeError || null,
    cpeLastAttemptAt: toIsoOrNull(raw?.cpeLastAttemptAt),
    cpeAcceptedAt: toIsoOrNull(raw?.cpeAcceptedAt),
    cpeBetaStatus: raw?.cpeBetaStatus || null,
    cpeBetaProvider: raw?.cpeBetaProvider || null,
    cpeBetaTicket: raw?.cpeBetaTicket || null,
    cpeBetaCode: raw?.cpeBetaCode ?? null,
    cpeBetaDescription: raw?.cpeBetaDescription ?? null,
    cpeBetaError: raw?.cpeBetaError || null,
    cpeBetaLastAttemptAt: toIsoOrNull(raw?.cpeBetaLastAttemptAt),
    cpeBetaAcceptedAt: toIsoOrNull(raw?.cpeBetaAcceptedAt),
    createdAt: toIsoOrNull(raw?.createdAt),
    updatedAt: toIsoOrNull(raw?.updatedAt),
  };
};

const mapPaymentDoc = (id, raw) => ({
  id,
  amount: round2(raw?.amount || 0),
  paymentDate: toIsoOrNull(raw?.paymentDate),
  note: raw?.note || "",
  createdAt: toIsoOrNull(raw?.createdAt),
  createdBy: raw?.createdBy || "",
});

const parseInvoicePayload = (body = {}) => {
  const businessId = String(body.businessId || "").trim();
  if (!businessId) {
    throw asApiError(400, "Missing businessId");
  }

  const documentType = String(body.documentType || "").trim().toUpperCase();
  if (!BILLING_DOC_TYPES.has(documentType)) {
    throw asApiError(400, "Invalid documentType");
  }

  const serie = String(body.serie || "").trim().toUpperCase();
  const numero = String(body.numero || "").trim().toUpperCase();
  if (!serie || !numero) {
    throw asApiError(400, "Missing serie or numero");
  }

  const customerName = String(body.customerName || "").trim();
  const customerDocumentType = String(body.customerDocumentType || "OTRO").trim().toUpperCase();
  const customerDocumentNumber = String(body.customerDocumentNumber || "").trim();
  if (!customerName || !customerDocumentNumber) {
    throw asApiError(400, "Missing customer fields");
  }
  if (!BILLING_CUSTOMER_DOC_TYPES.has(customerDocumentType)) {
    throw asApiError(400, "Invalid customerDocumentType");
  }
  if (documentType === "FACTURA" && customerDocumentType !== "RUC") {
    throw asApiError(400, "Factura requires customerDocumentType RUC");
  }

  const issueDate = parseDateInput(body.issueDate);
  if (!issueDate) {
    throw asApiError(400, "Invalid issueDate");
  }

  const dueDate = parseDateInput(body.dueDate);
  if (body.dueDate && !dueDate) {
    throw asApiError(400, "Invalid dueDate");
  }
  if (dueDate && dueDate.getTime() < issueDate.getTime()) {
    throw asApiError(400, "dueDate cannot be before issueDate");
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw asApiError(400, "Missing items");
  }

  const items = body.items.map((item) => {
    const description = String(item?.description || "").trim();
    const quantity = parseDecimal(item?.quantity);
    const unitPrice = parseDecimal(item?.unitPrice);
    const taxRate = parseTaxRate(item?.taxRate);
    if (!description || quantity === null || unitPrice === null || taxRate === null) {
      throw asApiError(400, "Invalid item fields");
    }
    if (quantity <= 0 || unitPrice < 0) {
      throw asApiError(400, "Invalid item values");
    }

    const subtotal = round2(quantity * unitPrice);
    const igv = round2(subtotal * taxRate);
    return {
      description,
      quantity: round2(quantity),
      unitPrice: round2(unitPrice),
      taxRate: round2(taxRate),
      subtotal,
      igv,
      total: round2(subtotal + igv),
    };
  });

  const subtotal = round2(items.reduce((acc, item) => acc + item.subtotal, 0));
  const igv = round2(items.reduce((acc, item) => acc + item.igv, 0));
  const total = round2(items.reduce((acc, item) => acc + item.total, 0));

  return {
    businessId,
    documentType,
    serie,
    numero,
    customerName,
    customerDocumentType,
    customerDocumentNumber,
    issueDate,
    dueDate,
    items,
    subtotal,
    igv,
    total,
  };
};

const parsePaymentPayload = (body = {}) => {
  const businessId = String(body.businessId || "").trim();
  if (!businessId) throw asApiError(400, "Missing businessId");

  const amount = parseDecimal(body.amount);
  if (amount === null || amount <= 0) {
    throw asApiError(400, "Invalid amount");
  }

  const paymentDate = parseDateInput(body.paymentDate);
  if (body.paymentDate && !paymentDate) {
    throw asApiError(400, "Invalid paymentDate");
  }

  return {
    businessId,
    amount: round2(amount),
    paymentDate,
    note: String(body.note || "").trim(),
  };
};

const parseBusinessQuery = (req) => {
  const businessId = String(req.query.businessId || "").trim();
  if (!businessId) throw asApiError(400, "Missing businessId");
  return businessId;
};

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/chat", requireAuth, async (req, res) => {
  const { messages, model } = req.body || {};
  const key = process.env.OPENAI_API_KEY;

  if (!key) {
    return res.status(400).json({ error: "Missing OPENAI_API_KEY" });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Missing messages" });
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: model || "gpt-4o-mini",
        messages,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(actionTimeout),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || "OpenAI error",
      });
    }

    const reply = data?.choices?.[0]?.message?.content || "";
    return res.status(200).json({ reply: reply.trim() });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Server error" });
  }
});

app.post("/paypal/create-subscription", requireAuth, async (req, res) => {
  try {
    const { planCode } = req.body || {};
    const planId = getPlanId(planCode);
    if (!planCode || !planId) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    const baseUrl = getBaseUrl(req);
    const returnUrl = `${baseUrl}/dashboard/plan?paypal=success`;
    const cancelUrl = `${baseUrl}/dashboard/plan?paypal=cancel`;

    const accessToken = await getPaypalToken();
    const response = await fetch(`${getPaypalBaseUrl()}/v1/billing/subscriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        plan_id: planId,
        custom_id: `${req.user.uid}:${planCode}`,
        application_context: {
          brand_name: "ContApp Peru",
          locale: "es-PE",
          user_action: "SUBSCRIBE_NOW",
          return_url: returnUrl,
          cancel_url: cancelUrl,
        },
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data?.message || "PayPal error" });
    }

    const approval = data?.links?.find((link) => link.rel === "approve");
    if (!approval?.href) {
      return res.status(500).json({ error: "No approval link" });
    }

    const userRef = firestore.collection("users").doc(req.user.uid);
    await userRef.set(
      {
        paypalSubscriptionId: data.id,
        paypalPlanId: planId,
        pendingPlan: planCode,
        updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.status(200).json({ approvalUrl: approval.href, subscriptionId: data.id });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Server error" });
  }
});

app.post("/paypal/webhook", async (req, res) => {
  try {
    const event = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const ok = await verifyPaypalWebhook(req.headers, event);
    if (!ok) {
      return res.status(400).json({ error: "Webhook not verified" });
    }

    const type = event?.event_type || "";
    const resource = event?.resource || {};
    const subscriptionId = resource?.id;
    const planId = resource?.plan_id;
    const planCode = planFromId(planId);
    const customId = resource?.custom_id || "";
    const [customUid, customPlan] = customId.split(":");
    const uid = customUid || customId || null;

    let userRef = null;
    if (uid) {
      userRef = firestore.collection("users").doc(uid);
    } else if (subscriptionId) {
      const snap = await firestore
        .collection("users")
        .where("paypalSubscriptionId", "==", subscriptionId)
        .limit(1)
        .get();
      if (!snap.empty) {
        userRef = snap.docs[0].ref;
      }
    }

    if (!userRef) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const updates = {
      paypalSubscriptionId: subscriptionId || null,
      paypalPlanId: planId || null,
      updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    };

    if (type === "BILLING.SUBSCRIPTION.ACTIVATED") {
      updates.status = "ACTIVE";
      updates.plan = planCode || customPlan || "PRO";
      updates.pendingPlan = firebaseAdmin.firestore.FieldValue.delete();
    }

    if (
      type === "BILLING.SUBSCRIPTION.CANCELLED" ||
      type === "BILLING.SUBSCRIPTION.SUSPENDED" ||
      type === "BILLING.SUBSCRIPTION.EXPIRED" ||
      type === "BILLING.SUBSCRIPTION.PAYMENT.FAILED"
    ) {
      updates.status = "SUSPENDED";
      updates.pendingPlan = firebaseAdmin.firestore.FieldValue.delete();
    }

    if (type === "BILLING.SUBSCRIPTION.UPDATED") {
      if (resource?.status === "ACTIVE") {
        updates.status = "ACTIVE";
        updates.plan = planCode || customPlan || "PRO";
        updates.pendingPlan = firebaseAdmin.firestore.FieldValue.delete();
      }
    }

    await userRef.set(updates, { merge: true });
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Webhook error" });
  }
});

app.post("/billing/invoices", requireAuth, async (req, res) => {
  try {
    const payload = parseInvoicePayload(req.body || {});
    const uid = req.user.uid;
    const invoiceId = buildInvoiceId(payload.documentType, payload.serie, payload.numero);

    const businessRef = firestore.collection("users").doc(uid).collection("businesses").doc(payload.businessId);
    const invoiceRef = businessRef.collection("invoices").doc(invoiceId);
    const comprobanteRef = businessRef.collection("comprobantes").doc();

    await firestore.runTransaction(async (transaction) => {
      const [businessSnap, invoiceSnap] = await Promise.all([
        transaction.get(businessRef),
        transaction.get(invoiceRef),
      ]);

      if (!businessSnap.exists) {
        throw asApiError(404, "Business not found");
      }

      if (invoiceSnap.exists) {
        throw asApiError(409, "Invoice already exists");
      }

      transaction.set(invoiceRef, {
        documentType: payload.documentType,
        serie: payload.serie,
        numero: payload.numero,
        customerName: payload.customerName,
        customerDocumentType: payload.customerDocumentType,
        customerDocumentNumber: payload.customerDocumentNumber,
        issueDate: firebaseAdmin.firestore.Timestamp.fromDate(payload.issueDate),
        dueDate: payload.dueDate ? firebaseAdmin.firestore.Timestamp.fromDate(payload.dueDate) : null,
        currency: "PEN",
        subtotal: payload.subtotal,
        igv: payload.igv,
        total: payload.total,
        paidAmount: 0,
        balance: payload.total,
        paymentStatus: "PENDIENTE",
        status: "EMITIDO",
        source: "BACKEND",
        items: payload.items,
        createdBy: uid,
        createdAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      });

      // Preserve compatibility with existing dashboards based on comprobantes.
      transaction.set(comprobanteRef, {
        type: "VENTA",
        serie: payload.serie,
        numero: payload.numero,
        fecha: firebaseAdmin.firestore.Timestamp.fromDate(payload.issueDate),
        cliente: payload.customerName,
        monto: payload.total,
        igv: payload.igv,
        source: "FACTURACION_BACKEND",
        invoiceId,
        createdAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return res.status(201).json({
      ok: true,
      invoice: {
        id: invoiceId,
        documentType: payload.documentType,
        serie: payload.serie,
        numero: payload.numero,
        customerName: payload.customerName,
        customerDocumentType: payload.customerDocumentType,
        customerDocumentNumber: payload.customerDocumentNumber,
        issueDate: payload.issueDate.toISOString(),
        dueDate: payload.dueDate ? payload.dueDate.toISOString() : null,
        subtotal: payload.subtotal,
        igv: payload.igv,
        total: payload.total,
        paidAmount: 0,
        balance: payload.total,
        paymentStatus: "PENDIENTE",
        status: "EMITIDO",
        cpeStatus: null,
        cpeProvider: null,
        cpeTicket: null,
        cpeCode: null,
        cpeDescription: null,
        cpeError: null,
        cpeLastAttemptAt: null,
        cpeAcceptedAt: null,
        cpeBetaStatus: null,
        cpeBetaProvider: null,
        cpeBetaTicket: null,
        cpeBetaCode: null,
        cpeBetaDescription: null,
        cpeBetaError: null,
        cpeBetaLastAttemptAt: null,
        cpeBetaAcceptedAt: null,
      },
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    const message = status >= 500 ? "Server error" : error?.message || "Billing error";
    return res.status(status).json({ error: message });
  }
});

app.get("/billing/invoices", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const businessId = parseBusinessQuery(req);
    const documentType = String(req.query.documentType || "").trim().toUpperCase();
    const paymentStatus = String(req.query.paymentStatus || "").trim().toUpperCase();
    const requestedLimit = Number(req.query.limit || 100);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(300, Math.max(1, Math.floor(requestedLimit)))
      : 100;

    if (documentType && !BILLING_DOC_TYPES.has(documentType)) {
      throw asApiError(400, "Invalid documentType");
    }
    if (paymentStatus && !BILLING_PAYMENT_STATUSES.has(paymentStatus)) {
      throw asApiError(400, "Invalid paymentStatus");
    }

    const businessRef = firestore.collection("users").doc(uid).collection("businesses").doc(businessId);
    const businessSnap = await businessRef.get();
    if (!businessSnap.exists) {
      throw asApiError(404, "Business not found");
    }

    const fetchLimit = limit * 3;
    const snap = await businessRef.collection("invoices").orderBy("issueDate", "desc").limit(fetchLimit).get();
    const invoices = snap.docs
      .map((docSnap) => mapInvoiceDoc(docSnap.id, docSnap.data()))
      .filter((invoice) => (documentType ? invoice.documentType === documentType : true))
      .filter((invoice) => (paymentStatus ? invoice.paymentStatus === paymentStatus : true))
      .slice(0, limit);

    return res.status(200).json({ ok: true, invoices });
  } catch (error) {
    const status = Number(error?.status) || 500;
    const message = status >= 500 ? "Server error" : error?.message || "Billing error";
    return res.status(status).json({ error: message });
  }
});

app.get("/billing/invoices/:invoiceId/payments", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const businessId = parseBusinessQuery(req);
    const invoiceId = String(req.params.invoiceId || "").trim();
    if (!invoiceId) throw asApiError(400, "Missing invoiceId");

    const invoiceRef = firestore
      .collection("users")
      .doc(uid)
      .collection("businesses")
      .doc(businessId)
      .collection("invoices")
      .doc(invoiceId);

    const invoiceSnap = await invoiceRef.get();
    if (!invoiceSnap.exists) {
      throw asApiError(404, "Invoice not found");
    }

    const paymentsSnap = await invoiceRef.collection("payments").orderBy("paymentDate", "desc").limit(500).get();
    const payments = paymentsSnap.docs.map((docSnap) => mapPaymentDoc(docSnap.id, docSnap.data()));

    return res.status(200).json({ ok: true, payments });
  } catch (error) {
    const status = Number(error?.status) || 500;
    const message = status >= 500 ? "Server error" : error?.message || "Billing error";
    return res.status(status).json({ error: message });
  }
});

app.post("/billing/invoices/:invoiceId/payments", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const invoiceId = String(req.params.invoiceId || "").trim();
    if (!invoiceId) throw asApiError(400, "Missing invoiceId");
    const payload = parsePaymentPayload(req.body || {});

    const invoiceRef = firestore
      .collection("users")
      .doc(uid)
      .collection("businesses")
      .doc(payload.businessId)
      .collection("invoices")
      .doc(invoiceId);

    const result = await firestore.runTransaction(async (transaction) => {
      const invoiceSnap = await transaction.get(invoiceRef);
      if (!invoiceSnap.exists) {
        throw asApiError(404, "Invoice not found");
      }

      const raw = invoiceSnap.data() || {};
      const total = round2(raw.total || 0);
      const paidAmount = round2(raw.paidAmount || 0);
      const balance = round2(raw.balance ?? total - paidAmount);

      if (payload.amount > balance + DECIMAL_EPSILON) {
        throw asApiError(400, "Amount exceeds balance");
      }

      const nextPaidAmount = round2(paidAmount + payload.amount);
      const nextBalance = round2(Math.max(0, total - nextPaidAmount));
      const nextStatus = nextBalance <= DECIMAL_EPSILON ? "PAGADO" : "PARCIAL";
      const paymentRef = invoiceRef.collection("payments").doc();

      transaction.set(paymentRef, {
        amount: payload.amount,
        paymentDate: payload.paymentDate
          ? firebaseAdmin.firestore.Timestamp.fromDate(payload.paymentDate)
          : firebaseAdmin.firestore.Timestamp.now(),
        note: payload.note,
        createdBy: uid,
        createdAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      });

      transaction.update(invoiceRef, {
        paidAmount: nextPaidAmount,
        balance: nextBalance,
        paymentStatus: nextStatus,
        updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        paymentId: paymentRef.id,
        paidAmount: nextPaidAmount,
        balance: nextBalance,
        paymentStatus: nextStatus,
      };
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    const status = Number(error?.status) || 500;
    const message = status >= 500 ? "Server error" : error?.message || "Billing error";
    return res.status(status).json({ error: message });
  }
});

app.post("/billing/invoices/:invoiceId/mark-paid", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const invoiceId = String(req.params.invoiceId || "").trim();
    if (!invoiceId) throw asApiError(400, "Missing invoiceId");

    const businessId = String(req.body?.businessId || "").trim();
    if (!businessId) throw asApiError(400, "Missing businessId");
    const note = String(req.body?.note || "").trim() || "Pago total";

    const paymentDate = parseDateInput(req.body?.paymentDate);
    if (req.body?.paymentDate && !paymentDate) {
      throw asApiError(400, "Invalid paymentDate");
    }

    const invoiceRef = firestore
      .collection("users")
      .doc(uid)
      .collection("businesses")
      .doc(businessId)
      .collection("invoices")
      .doc(invoiceId);

    const result = await firestore.runTransaction(async (transaction) => {
      const invoiceSnap = await transaction.get(invoiceRef);
      if (!invoiceSnap.exists) {
        throw asApiError(404, "Invoice not found");
      }

      const raw = invoiceSnap.data() || {};
      const total = round2(raw.total || 0);
      const paidAmount = round2(raw.paidAmount || 0);
      const balance = round2(raw.balance ?? total - paidAmount);

      if (balance <= DECIMAL_EPSILON) {
        transaction.update(invoiceRef, {
          paidAmount: total,
          balance: 0,
          paymentStatus: "PAGADO",
          updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
        });
        return {
          paymentId: null,
          paidAmount: total,
          balance: 0,
          paymentStatus: "PAGADO",
        };
      }

      const paymentRef = invoiceRef.collection("payments").doc();
      const nextPaidAmount = round2(total);

      transaction.set(paymentRef, {
        amount: balance,
        paymentDate: paymentDate
          ? firebaseAdmin.firestore.Timestamp.fromDate(paymentDate)
          : firebaseAdmin.firestore.Timestamp.now(),
        note,
        createdBy: uid,
        createdAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      });

      transaction.update(invoiceRef, {
        paidAmount: nextPaidAmount,
        balance: 0,
        paymentStatus: "PAGADO",
        updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        paymentId: paymentRef.id,
        paidAmount: nextPaidAmount,
        balance: 0,
        paymentStatus: "PAGADO",
      };
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    const status = Number(error?.status) || 500;
    const message = status >= 500 ? "Server error" : error?.message || "Billing error";
    return res.status(status).json({ error: message });
  }
});

app.post("/billing/invoices/:invoiceId/emit-cpe", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const invoiceId = String(req.params.invoiceId || "").trim();
    if (!invoiceId) throw asApiError(400, "Missing invoiceId");

    const businessId = String(req.body?.businessId || "").trim();
    if (!businessId) throw asApiError(400, "Missing businessId");

    const authHeader = String(req.headers.authorization || "").trim();
    if (!authHeader) throw asApiError(401, "Missing auth token");

    const invoiceRef = firestore
      .collection("users")
      .doc(uid)
      .collection("businesses")
      .doc(businessId)
      .collection("invoices")
      .doc(invoiceId);

    const invoiceSnap = await invoiceRef.get();
    if (!invoiceSnap.exists) {
      throw asApiError(404, "Invoice not found");
    }

    // Backward compatible: this endpoint validates in BETA.
    const response = await fetch(`${getSunatWorkerUrl()}/sunat/cpe/emit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify({ businessId, invoiceId, env: "BETA" }),
      signal: AbortSignal.timeout(actionTimeout),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw asApiError(response.status, data?.error || "CPE emit failed");
    }

    const updatedInvoiceSnap = await invoiceRef.get();
    const invoice = mapInvoiceDoc(updatedInvoiceSnap.id, updatedInvoiceSnap.data() || {});
    return res.status(200).json({ ok: true, result: data?.result || null, invoice });
  } catch (error) {
    const status = Number(error?.status) || 500;
    const message = status >= 500 ? "Server error" : error?.message || "Billing error";
    return res.status(status).json({ error: message });
  }
});

app.post("/billing/invoices/:invoiceId/emit-cpe-prod", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const invoiceId = String(req.params.invoiceId || "").trim();
    if (!invoiceId) throw asApiError(400, "Missing invoiceId");

    const businessId = String(req.body?.businessId || "").trim();
    if (!businessId) throw asApiError(400, "Missing businessId");

    const authHeader = String(req.headers.authorization || "").trim();
    if (!authHeader) throw asApiError(401, "Missing auth token");

    const invoiceRef = firestore
      .collection("users")
      .doc(uid)
      .collection("businesses")
      .doc(businessId)
      .collection("invoices")
      .doc(invoiceId);

    const invoiceSnap = await invoiceRef.get();
    if (!invoiceSnap.exists) {
      throw asApiError(404, "Invoice not found");
    }

    const response = await fetch(`${getSunatWorkerUrl()}/sunat/cpe/emit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify({ businessId, invoiceId, env: "PROD" }),
      signal: AbortSignal.timeout(actionTimeout),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw asApiError(response.status, data?.error || "CPE emit failed");
    }

    const updatedInvoiceSnap = await invoiceRef.get();
    const invoice = mapInvoiceDoc(updatedInvoiceSnap.id, updatedInvoiceSnap.data() || {});
    return res.status(200).json({ ok: true, result: data?.result || null, invoice });
  } catch (error) {
    const status = Number(error?.status) || 500;
    const message = status >= 500 ? "Server error" : error?.message || "Billing error";
    return res.status(status).json({ error: message });
  }
});

app.listen(port, () => {
  console.log(`Backend running on port ${port}`);
});

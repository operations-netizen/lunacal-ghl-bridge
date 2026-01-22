import express from "express";
import "dotenv/config";
import crypto from "crypto";

const app = express();

// ============ MIDDLEWARE ============
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ limit: "2mb", extended: true }));

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ============ CONFIG ============
const {
  LUNACAL_WEBHOOK_SECRET = "",
  GHL_PRIVATE_TOKEN,
  GHL_LOCATION_ID,
  GHL_CALENDAR_ID,
  GHL_API_VERSION = "2021-07-28",
} = process.env;

const PORT = Number(process.env.PORT) || 8080;

// ============ HELPERS ============
function safeJson(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function normalizeSecret(v) {
  if (v == null) return "";
  const raw = Array.isArray(v) ? v[0] : v;
  return String(raw).trim();
}

function safeEqual(a, b) {
  try {
    const aa = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (aa.length !== bb.length) return false;
    return crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

function getIncomingSecret(req) {
  try {
    return normalizeSecret(
      req.query?.secret ||
        req.headers["x-lunacal-secret"] ||
        req.headers["x-webhook-secret"] ||
        req.headers["x-hook-secret"] ||
        req.headers["x-secret"] ||
        req.headers["webhook-secret"] ||
        req.body?.secret ||
        req.body?.webhookSecret
    );
  } catch {
    return "";
  }
}

function extractAttendee(payload) {
  try {
    const attendee = Array.isArray(payload?.attendees) ? payload.attendees[0] : null;

    const name =
      attendee?.name ||
      payload?.responses?.name?.value ||
      payload?.invitee?.name ||
      payload?.name ||
      "Unknown";

    const email =
      attendee?.email ||
      payload?.responses?.email?.value ||
      payload?.invitee?.email ||
      payload?.email ||
      null;

    const phone =
      attendee?.phone ||
      payload?.responses?.phone?.value ||
      payload?.invitee?.phone ||
      payload?.phone ||
      null;

    return { name, email, phone };
  } catch (err) {
    console.error("Error extracting attendee:", err.message);
    return { name: "Unknown", email: null, phone: null };
  }
}

function normalizeTime(v) {
  try {
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function shouldCreateAppointment(triggerEvent) {
  try {
    const normalized = String(triggerEvent || "").toUpperCase();
    return (
      normalized.includes("CREATED") ||
      normalized.includes("BOOKED") ||
      normalized.includes("RESCHEDULED")
    );
  } catch {
    return false;
  }
}

// ============ GHL API ============
async function ghlRequest(path, { method = "GET", body } = {}) {
  try {
    if (typeof fetch !== "function") {
      throw new Error("fetch() not available");
    }

    const url = `https://services.leadconnectorhq.com${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${GHL_PRIVATE_TOKEN}`,
        Version: GHL_API_VERSION,
      },
      body: body ? JSON.stringify(body ) : undefined,
    });

    const text = await res.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const err = new Error(`GHL API error ${res.status}`);
      err.status = res.status;
      err.response = data;
      throw err;
    }

    return data;
  } catch (err) {
    console.error(`GHL Request Error: ${err.message}`);
    throw err;
  }
}

async function upsertContact({ name, email, phone }) {
  try {
    if (!GHL_PRIVATE_TOKEN || !GHL_LOCATION_ID) {
      throw new Error("Missing GHL credentials");
    }

    const body = {
      locationId: GHL_LOCATION_ID,
      name: String(name || "Unknown"),
      email: String(email || ""),
      ...(phone ? { phone: String(phone) } : {}),
    };

    const resp = await ghlRequest("/contacts/upsert", { method: "POST", body });
    const contactId = resp?.contact?.id || resp?.contactId || resp?.id || null;

    if (!contactId) {
      throw new Error("No contactId in response");
    }

    return contactId;
  } catch (err) {
    console.error(`Upsert Contact Error: ${err.message}`);
    throw err;
  }
}

async function createAppointment({ contactId, startTime, endTime, title }) {
  try {
    if (!GHL_PRIVATE_TOKEN || !GHL_LOCATION_ID || !GHL_CALENDAR_ID) {
      throw new Error("Missing GHL credentials");
    }

    const body = {
      locationId: GHL_LOCATION_ID,
      calendarId: GHL_CALENDAR_ID,
      contactId: String(contactId),
      title: String(title || "LunaCal Booking"),
      startTime: String(startTime),
      endTime: String(endTime),
    };

    return await ghlRequest("/calendars/events/appointments", { method: "POST", body });
  } catch (err) {
    console.error(`Create Appointment Error: ${err.message}`);
    throw err;
  }
}

// ============ ROUTES ============
app.get("/", (req, res) => {
  try {
    res.status(200).json({ ok: true, message: "lunacal-ghl-bridge running" });
  } catch (err) {
    console.error("GET / error:", err.message);
    res.status(500).json({ ok: false, message: "Error" });
  }
});

app.get("/health", (req, res) => {
  try {
    res.status(200).json({ ok: true, message: "healthy" });
  } catch (err) {
    console.error("GET /health error:", err.message);
    res.status(500).json({ ok: false, message: "Error" });
  }
});

app.post("/webhooks/lunacal", async (req, res) => {
  let responsesSent = false;

  try {
    // Validate credentials
    if (!GHL_PRIVATE_TOKEN || !GHL_LOCATION_ID || !GHL_CALENDAR_ID) {
      responsesSent = true;
      return res.status(500).json({ ok: false, message: "Missing GHL configuration" });
    }

    // Secret validation disabled - LunaCal doesn't send secret in webhook request
    // const expectedSecret = normalizeSecret(LUNACAL_WEBHOOK_SECRET);
    // if (expectedSecret) {
    //   const incomingSecret = getIncomingSecret(req);
    //   if (!safeEqual(incomingSecret, expectedSecret)) {
    //     responsesSent = true;
    //     return res.status(401).json({ ok: false, message: "Invalid secret" });
    //   }
    // }

    // Parse payload safely
    const data = req.body || {};
    const triggerEvent = String(data?.triggerEvent || data?.event || data?.type || "");
    const payload = data?.payload || data;

    const startTimeRaw = payload?.startTime || payload?.start || payload?.booking?.startTime || null;
    const endTimeRaw = payload?.endTime || payload?.end || payload?.booking?.endTime || null;
    const startTime = normalizeTime(startTimeRaw);
    const endTime = normalizeTime(endTimeRaw);
    const title = String(payload?.eventTitle || payload?.title || payload?.booking?.title || "LunaCal Booking");
    const { name, email, phone } = extractAttendee(payload);

    // Check if PING test
    if (triggerEvent.toUpperCase().includes("PING")) {
      responsesSent = true;
      return res.status(200).json({ ok: true, message: "Received PING. No action taken." });
    }

    // Validate required fields
    if (!email || !startTime || !endTime) {
      responsesSent = true;
      return res.status(400).json({
        ok: false,
        message: "Missing required fields",
        debug: { email, startTime, endTime },
      });
    }

    // Check if should create appointment
    if (!shouldCreateAppointment(triggerEvent)) {
      responsesSent = true;
      return res.status(200).json({ ok: true, message: `Received ${triggerEvent}. No action taken.` });
    }

    // Create contact and appointment
    console.log(`Processing booking for ${email}`);
    const contactId = await upsertContact({ name, email, phone });
    const appointment = await createAppointment({ contactId, startTime, endTime, title });

    responsesSent = true;
    return res.status(200).json({
      ok: true,
      message: "Synced to GoHighLevel",
      contactId,
    });
  } catch (err) {
    console.error("Webhook error:", err.message);
    if (!responsesSent) {
      responsesSent = true;
      res.status(err.status || 500).json({
        ok: false,
        message: err.message,
      });
    }
  }
});

// ============ 404 HANDLER ============
app.use((req, res) => {
  res.status(404).json({ ok: false, message: "Not found" });
});

// ============ ERROR HANDLER ============
app.use((err, req, res, next) => {
  console.error("Global error:", err.message);
  res.status(500).json({ ok: false, message: "Internal error" });
});

// ============ SERVER START ============
const server = app.listen(PORT, () => {
  console.log(`✅ Server listening on port: ${PORT}`);
  console.log(`📝 Webhook: POST /webhooks/lunacal`);
  console.log(`📝 Health: GET /health`);
});

server.on("error", (err) => {
  console.error("Server error:", err.message);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err.message);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

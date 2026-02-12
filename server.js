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
  GHL_API_VERSION = "2021-07-28",
  CALENDAR_MAPPING = "",
  CUSTOM_FIELD_MAPPING = "",
} = process.env;

const PORT = Number(process.env.PORT) || 8080;

// Parse Mappings
const calendarMap = new Map();
if (CALENDAR_MAPPING) {
  CALENDAR_MAPPING.split(",").forEach(item => {
    const [email, id] = item.split(":");
    if (email && id) calendarMap.set(email.trim().toLowerCase(), id.trim());
  });
}

const fieldMap = new Map();
if (CUSTOM_FIELD_MAPPING) {
  CUSTOM_FIELD_MAPPING.split(",").forEach(item => {
    const [label, key] = item.split(":");
    if (label && key) fieldMap.set(label.trim(), key.trim());
  });
}

// ============ HELPERS ============
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

function extractAttendee(payload) {
  try {
    const attendee = Array.isArray(payload?.attendees) ? payload.attendees[0] : null;
    const name = attendee?.name || payload?.responses?.name?.value || payload?.invitee?.name || payload?.name || "Unknown";
    const email = attendee?.email || payload?.responses?.email?.value || payload?.invitee?.email || payload?.email || null;
    const phone = attendee?.phone || payload?.responses?.phone?.value || payload?.invitee?.phone || payload?.phone || null;
    return { name, email, phone };
  } catch (err) {
    console.error("Error extracting attendee:", err.message);
    return { name: "Unknown", email: null, phone: null };
  }
}

function extractCustomFields(payload) {
  const fields = {};
  const responses = payload?.responses || {};
  for (const [label, ghlKey] of fieldMap.entries()) {
    for (const key in responses) {
      if (responses[key]?.label === label && responses[key]?.value !== undefined) {
        fields[ghlKey] = responses[key].value;
      }
    }
  }
  return fields;
}

// ============ GHL API ============
async function ghlRequest(path, { method = "GET", body } = {}) {
  const url = `https://services.leadconnectorhq.com${path}`;
  console.log(`[GHL Request] ${method} ${url}`);
  
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${GHL_PRIVATE_TOKEN}`,
      Version: GHL_API_VERSION,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    console.error(`[GHL Error] Status: ${res.status}, Response:`, JSON.stringify(data));
    const err = new Error(`GHL API error ${res.status}`);
    err.status = res.status;
    err.response = data;
    throw err;
  }
  
  console.log(`[GHL Success] Status: ${res.status}`);
  return data;
}

async function upsertContact({ name, email, phone, customFields }) {
  const body = {
    locationId: GHL_LOCATION_ID,
    name: String(name || "Unknown"),
    email: String(email || ""),
    ...(phone ? { phone: String(phone) } : {}),
    customFields: Object.entries(customFields).map(([key, value]) => ({
      id: key,
      value: value
    }))
  };

  console.log(`[Upsert Contact] Data:`, JSON.stringify(body));
  const resp = await ghlRequest("/contacts/upsert", { method: "POST", body });
  const contactId = resp?.contact?.id || resp?.contactId || resp?.id || null;
  console.log(`[Upsert Contact] Result Contact ID: ${contactId}`);
  return contactId;
}

async function createAppointment({ contactId, startTime, endTime, title, calendarId }) {
  const body = {
    locationId: GHL_LOCATION_ID,
    calendarId: calendarId,
    contactId: String(contactId),
    title: String(title || "LunaCal Booking"),
    startTime: String(startTime),
    endTime: String(endTime),
  };

  console.log(`[Create Appointment] Data:`, JSON.stringify(body));
  return await ghlRequest("/calendars/events/appointments", { method: "POST", body });
}

// ============ ROUTES ============
app.post("/webhooks/lunacal", async (req, res) => {
  try {
    console.log("--- New LunaCal Webhook Received ---");
    // console.log("Full Body:", JSON.stringify(req.body, null, 2)); // Uncomment for extreme debugging

    if (!GHL_PRIVATE_TOKEN || !GHL_LOCATION_ID) {
      console.error("[Config Error] Missing GHL_PRIVATE_TOKEN or GHL_LOCATION_ID");
      return res.status(500).json({ ok: false, message: "Missing GHL configuration" });
    }

    const data = req.body || {};
    const triggerEvent = String(data?.triggerEvent || data?.event || data?.type || "");
    const payload = data?.payload || data;

    console.log(`[Event] ${triggerEvent}`);

    if (triggerEvent.toUpperCase().includes("PING")) {
      return res.status(200).json({ ok: true, message: "Received PING." });
    }

    const startTime = normalizeTime(payload?.startTime || payload?.start);
    const endTime = normalizeTime(payload?.endTime || payload?.end);
    const title = String(payload?.eventTitle || payload?.title || "LunaCal Booking");
    const { name, email, phone } = extractAttendee(payload);
    const customFields = extractCustomFields(payload);

    // Identify Calendar ID
    const organizerEmail = payload?.organizer?.email?.toLowerCase();
    console.log(`[Organizer Email] ${organizerEmail}`);
    
    let targetCalendarId = process.env.GHL_CALENDAR_ID; // Default

    if (organizerEmail && calendarMap.has(organizerEmail)) {
      targetCalendarId = calendarMap.get(organizerEmail);
      console.log(`[Calendar Match] Found specific calendar: ${targetCalendarId}`);
    } else {
      console.log(`[Calendar Match] Using default/fallback calendar: ${targetCalendarId}`);
    }

    if (!email || !startTime || !endTime || !targetCalendarId) {
      console.error("[Validation Error] Missing required fields:", { email, startTime, endTime, targetCalendarId });
      return res.status(400).json({ 
        ok: false, 
        message: "Missing required fields", 
        debug: { email, startTime, endTime, targetCalendarId } 
      });
    }

    console.log(`[Sync] Starting sync for ${email}`);
    const contactId = await upsertContact({ name, email, phone, customFields });
    
    if (!contactId) {
      throw new Error("Failed to get contactId from GHL");
    }

    const appointment = await createAppointment({ contactId, startTime, endTime, title, calendarId: targetCalendarId });
    console.log(`[Sync] Appointment created successfully:`, JSON.stringify(appointment));

    return res.status(200).json({ 
      ok: true, 
      message: "Synced to GoHighLevel", 
      contactId, 
      calendarId: targetCalendarId,
      appointmentId: appointment?.id
    });
  } catch (err) {
    console.error("[Webhook Error]", err.message);
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.get("/health", (req, res) => res.status(200).json({ ok: true, message: "healthy" }));

app.listen(PORT, () => {
  console.log(`✅ Server listening on port: ${PORT}`);
  console.log(`CALENDAR_MAPPING set for: ${Array.from(calendarMap.keys()).join(", ")}`);
});

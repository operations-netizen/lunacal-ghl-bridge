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
// Format: email:calendarId:userId
const calendarMap = new Map();
if (CALENDAR_MAPPING) {
  CALENDAR_MAPPING.split(",").forEach(item => {
    const parts = item.split(":");
    const email = parts[0]?.trim().toLowerCase();
    const calId = parts[1]?.trim();
    const userId = parts[2]?.trim();
    if (email && calId) {
      calendarMap.set(email, { calId, userId });
    }
  });
}

const fieldMap = new Map();
if (CUSTOM_FIELD_MAPPING) {
  CUSTOM_FIELD_MAPPING.split(",").forEach(item => {
    const [label, key] = item.split(":");
    if (label && key) fieldMap.set(label.trim().toLowerCase(), key.trim());
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

/**
 * Normalizes drop-down values for GHL compatibility.
 * GHL drop-downs are case-sensitive and space-sensitive.
 * This helper tries to match the input value to a set of known common options.
 */
function normalizeDropdownValue(value) {
  if (!value) return value;
  const val = String(value).trim();
  
  // Mapping for "What's your role"
  const roleOptions = {
    "ceo / founder": "CEO / Founder",
    "ceo/founder": "CEO / Founder",
    "chief marketing officer": "Chief Marketing Officer",
    "seo director": "SEO Director",
    "seo manager": "SEO Manager",
    "marketing manager": "Marketing Manager",
    "other": "Other"
  };

  // Mapping for "What's your current link budget per month"
  const budgetOptions = {
    "less than $5,000": "Less than $5,000",
    "less than $5000": "Less than $5,000",
    "between $5,000 - $10,000": "Between $5,000 - $10,000",
    "between $5000 - $10000": "Between $5,000 - $10,000",
    "more than $10,000": "More than $10,000",
    "more than $10000": "More than $10,000"
  };

  const normalized = val.toLowerCase();
  if (roleOptions[normalized]) return roleOptions[normalized];
  if (budgetOptions[normalized]) return budgetOptions[normalized];

  return val;
}

function extractCustomFields(payload) {
  const fields = {};
  const responses = payload?.responses || {};
  
  console.log("[Debug] Mapping labels to GHL keys:", Array.from(fieldMap.entries()));

  for (const [targetLabel, ghlKey] of fieldMap.entries()) {
    let found = false;
    for (const key in responses) {
      // Clean and normalize labels for fuzzy matching
      const actualLabel = (responses[key]?.label || "").trim().toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');
      const normalizedTarget = targetLabel.trim().toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');

      if (actualLabel === normalizedTarget) {
        const rawValue = responses[key].value;
        const finalValue = normalizeDropdownValue(rawValue);
        fields[ghlKey] = finalValue;
        console.log(`[Debug] Match found! Label: "${targetLabel}" -> GHL Key: "${ghlKey}", Raw: "${rawValue}", Final: "${finalValue}"`);
        found = true;
        break;
      }
    }
    if (!found) {
      console.log(`[Debug] No match found for label: "${targetLabel}"`);
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
    customFields: Object.entries(customFields).map(([key, value]) => {
      if (key.startsWith("contact.")) {
        return { key: key, value: value };
      }
      return { id: key, value: value };
    })
  };

  console.log(`[Upsert Contact] Data:`, JSON.stringify(body));
  const resp = await ghlRequest("/contacts/upsert", { method: "POST", body });
  const contactId = resp?.contact?.id || resp?.contactId || resp?.id || null;
  console.log(`[Upsert Contact] Result Contact ID: ${contactId}`);
  return contactId;
}

async function createAppointment({ contactId, startTime, endTime, title, calendarId, assignedUserId }) {
  const body = {
    locationId: GHL_LOCATION_ID,
    calendarId: calendarId,
    contactId: String(contactId),
    title: String(title || "LunaCal Booking"),
    startTime: String(startTime),
    endTime: String(endTime),
    ignoreFreeSlotValidation: true,
    ...(assignedUserId ? { assignedUserId } : {})
  };

  console.log(`[Create Appointment] Data:`, JSON.stringify(body));
  return await ghlRequest("/calendars/events/appointments", { method: "POST", body });
}

// ============ ROUTES ============
app.post("/webhooks/lunacal", async (req, res) => {
  try {
    console.log("--- New LunaCal Webhook Received ---");

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

    // Identify Calendar and User ID
    let organizerEmail = payload?.organizer?.email?.toLowerCase() || "";
    console.log(`[Organizer Email] ${organizerEmail}`);
    
    // Robust check for suraj.kumar domain
    if (organizerEmail.includes("suraj.kumar@digitalwebsolutions")) {
        organizerEmail = "suraj.kumar@digitalwebsolutions.in";
    }

    let targetCalendarId = process.env.GHL_CALENDAR_ID;
    let targetUserId = null;

    if (organizerEmail && calendarMap.has(organizerEmail)) {
      const mapping = calendarMap.get(organizerEmail);
      targetCalendarId = mapping.calId;
      targetUserId = mapping.userId;
      console.log(`[Match] Found mapping: Calendar=${targetCalendarId}, User=${targetUserId}`);
    } else {
      console.log(`[Match] Using default calendar fallback.`);
    }

    if (!email || !startTime || !endTime || !targetCalendarId) {
      console.error("[Validation Error] Missing required fields");
      return res.status(400).json({ ok: false, message: "Missing required fields" });
    }

    const contactId = await upsertContact({ name, email, phone, customFields });
    const appointment = await createAppointment({ 
      contactId, 
      startTime, 
      endTime, 
      title, 
      calendarId: targetCalendarId,
      assignedUserId: targetUserId
    });

    return res.status(200).json({ 
      ok: true, 
      message: "Synced to GoHighLevel", 
      contactId, 
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
});

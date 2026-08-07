// LEXPRO :: sheet-sync.js
// Every 15 minutes: read the Active Listings tab and upsert the registry.
// The sheet is Tanya's surface; this makes it authoritative for the fields
// she maintains there. App-only fields are never touched.
//
// OWNERSHIP RULE:
//   Sheet wins:    address, seller name/phone/email, occupancy (T),
//                  showing hours (U), active yes/no (L)
//   Registry wins: blackout_windows, showing_notes, internal_notes,
//                  notice_hours, requires_approval, property_facts,
//                  parent_listing_id, and any status the app set to 'paused'
//                  or 'under_contract' (sheet L=No never overrides a more
//                  specific app status; L=No on an 'active' listing -> 'inactive')
//
// Match key: GHL Contact ID (col N) + address_key. Rows without N or a
// parseable address are skipped (Tanya's addressless under-contract rows).
//
// Occupancy safety: sheet says 'vacant' -> occupancy updates BUT
// requires_approval is left alone (only the app's deliberate toggle, with its
// interlock, may enable instant-confirm).
//
// Active Listings columns (A=1..U=21):
//   A First B Last C Address D Phone E Email F ListDate G DOM H Price I Reductions
//   J ShowCount K Summary L Active M LastWeek N ContactID O-S (options) T Occupancy U Hours
//
// ENV: GOOGLE_SERVICE_ACCOUNT_JSON, SUPABASE_URL, SUPABASE_SERVICE_KEY
// netlify.toml: [functions."sheet-sync"]  schedule = "*/15 * * * *"

const crypto = require('crypto');

const SHEET_ID = '1KlfQEU02BcEM9RUTTi64-Eu60UzuaptT_EjE6OAXKOY';
const TAB = 'Active Listings';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

/* ---------- google auth ---------- */

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getGoogleToken() {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(sa.private_key).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${header}.${claims}.${signature}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  if (!res.ok) throw new Error(`google token ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

/* ---------- supabase ---------- */

async function sb(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: prefer || 'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

/* ---------- helpers ---------- */

const DIRECTIONALS = new Set(['n','s','e','w','north','south','east','west','ne','nw','se','sw']);
const SUFFIXES = new Set(['st','street','ave','avenue','rd','road','dr','drive','ln','lane','ct','court',
  'cir','circle','blvd','boulevard','way','pl','place','trl','trail','pkwy','parkway','hwy','highway',
  'ter','terrace','loop','farm']);

function normalizeAddress(raw) {
  if (!raw) return null;
  const cleaned = String(raw).toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = cleaned.split(' ').filter(Boolean);
  if (!tokens.length) return null;
  let idx = tokens.findIndex(t => /^\d+[a-z]?(\/\d+)?$/.test(t));
  if (idx === -1) return null;
  const houseNumber = tokens[idx].split('/')[0].replace(/[a-z]/g, '');
  let streetToken = null;
  for (let i = idx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (DIRECTIONALS.has(t) || SUFFIXES.has(t)) continue;
    if (/^\d+$/.test(t)) continue;
    streetToken = t;
    break;
  }
  if (!streetToken) return null;
  return { houseNumber, streetToken, key: `${houseNumber}|${streetToken}` };
}

function cleanPhone(p) {
  if (!p) return null;
  const digits = String(p).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

// "9-8" | "9:30-7" | "09:00-20:00" -> { start: "09:00", end: "20:00" } (1-7 end = PM)
function parseHours(raw) {
  if (!raw) return null;
  const m = String(raw).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*[-–to]+\s*(\d{1,2})(?::(\d{2}))?$/i);
  if (!m) return null;
  let sh = parseInt(m[1]), sm = m[2] ? parseInt(m[2]) : 0;
  let eh = parseInt(m[3]), em = m[4] ? parseInt(m[4]) : 0;
  if (sh < 1 || sh > 12 || eh < 1 || eh > 23) return null;
  // shorthand like "9-8": if the end isn't after the start, it means PM
  if (eh * 60 + em <= sh * 60 + sm) eh += 12;
  const pad = n => String(n).padStart(2, '0');
  const start = `${pad(sh)}:${pad(sm)}`, end = `${pad(eh)}:${pad(em)}`;
  return start < end ? { start, end } : null;
}

/* ---------- handler ---------- */

exports.handler = async () => {
  const summary = { rows: 0, updated: [], created: [], deactivated: [], skipped: 0 };
  try {
    const token = await getGoogleToken();
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}!A2:U500`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`sheets read ${res.status}: ${await res.text()}`);
    const rows = (await res.json()).values || [];

    const registry = await sb('listings?select=id,address_key,seller_contact_id,status,occupancy,allowed_start,allowed_end,address_full,seller_phone,seller_email,seller_name');
    const byContact = {};
    for (const l of registry) {
      const k = `${l.seller_contact_id}|${l.address_key}`;
      byContact[k] = l;
    }

    for (const r of rows) {
      const [first, last, address, phone, email, , , , , , , active, , contactId, , , , , , occRaw, hoursRaw] =
        [r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12], r[13], r[14], r[15], r[16], r[17], r[18], r[19], r[20]];

      if (!address || !String(address).replace(/[,\s]/g, '')) { summary.skipped++; continue; }
      if (!contactId || !String(contactId).trim()) { summary.skipped++; continue; }
      summary.rows++;

      const norm = normalizeAddress(address);
      if (!norm) { summary.skipped++; continue; }

      const isActive = String(active || '').trim().toLowerCase() === 'yes';
      const occupancy = String(occRaw || '').trim().toLowerCase() === 'vacant' ? 'vacant' :
                        String(occRaw || '').trim().toLowerCase() === 'occupied' ? 'occupied' : null;
      const hours = parseHours(hoursRaw);

      const sellerName = `${first || ''} ${last || ''}`.trim() || null;
      const parts = String(address).split(',').map(s => s.trim());
      const city = parts.length >= 2 ? parts[1] : null;
      let state = null, zip = null;
      if (parts.length >= 3) {
        const m = parts[2].match(/([A-Za-z]{2})\s*(\d{5})?/);
        if (m) { state = (m[1] || '').toUpperCase(); zip = m[2] || null; }
      }

      const key = `${String(contactId).trim()}|${norm.key}`;
      const existing = byContact[key];

      // sheet-owned fields
      const sheetFields = {
        address_full: String(address).trim(),
        address_key: norm.key,
        house_number: norm.houseNumber,
        street_token: norm.streetToken,
        city, state, zip,
        seller_name: sellerName,
        seller_first_name: first || null,
        seller_last_name: last || null,
        seller_phone: cleanPhone(phone),
        seller_email: email || null,
        seller_contact_id: String(contactId).trim()
      };
      if (occupancy) sheetFields.occupancy = occupancy;
      if (hours) { sheetFields.allowed_start = hours.start; sheetFields.allowed_end = hours.end; }

      if (existing) {
        // status: sheet L only toggles active<->inactive; never overrides app's paused/under_contract
        if (!isActive && existing.status === 'active') sheetFields.status = 'inactive';
        if (isActive && existing.status === 'inactive') sheetFields.status = 'active';

        // only PATCH when something actually differs (keep write volume low)
        const differs = Object.entries(sheetFields).some(([k, v]) => {
          const cur = existing[k];
          if (v === null && (cur === null || cur === undefined || cur === '')) return false;
          return String(cur ?? '') !== String(v ?? '');
        });
        if (differs) {
          await sb(`listings?id=eq.${existing.id}`, { method: 'PATCH', body: sheetFields, prefer: 'return=minimal' });
          summary.updated.push(sheetFields.address_full);
        }
      } else if (isActive) {
        await sb('listings', {
          method: 'POST',
          prefer: 'return=minimal',
          body: {
            ...sheetFields,
            status: 'active',
            occupancy: occupancy || 'occupied',
            requires_approval: true,
            allowed_start: hours ? hours.start : '09:00',
            allowed_end: hours ? hours.end : '20:00',
            slot_minutes: 60,
            notice_hours: 0
          }
        });
        summary.created.push(sheetFields.address_full);
      }
    }

    console.log('sheet-sync:', JSON.stringify(summary));
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...summary }) };
  } catch (err) {
    console.error('sheet-sync error:', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message, ...summary }) };
  }
};

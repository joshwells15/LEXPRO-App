// LEXPRO :: sync-listing.js
// Fired by an HTTP module at the END of the Make "LEXPRO: Listing Live" scenario.
// Inserts (or updates) the new listing in the Supabase registry so Donna knows
// about it in real time - no manual load, no polling delay.
//
// Expected POST body (JSON or form-encoded; keys are matched loosely):
//   first_name, last_name, address, phone, email, contact_id, list_price (optional)
//
// Upsert key: ghl_contact_id when present, else address_key.
// New listings get safe defaults: occupied, approval required, 9:00-20:00,
// 60-min slots, 0 notice. Tanya adjusts in the app afterward.
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const DIRECTIONALS = new Set(['n','s','e','w','north','south','east','west','ne','nw','se','sw']);
const SUFFIXES = new Set(['st','street','ave','avenue','rd','road','dr','drive','ln','lane','ct','court',
  'cir','circle','blvd','boulevard','way','pl','place','trl','trail','pkwy','parkway','hwy','highway',
  'ter','terrace','loop','farm']);

function normalizeAddress(raw) {
  if (!raw) return null;
  const cleaned = String(raw).toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = cleaned.split(' ').filter(Boolean);
  if (!tokens.length) return null;
  let idx = tokens.findIndex(t => /^\d+[a-z]?$/.test(t));
  if (idx === -1) return null;
  const houseNumber = tokens[idx].replace(/[a-z]/g, '');
  let streetToken = null;
  for (let i = idx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (DIRECTIONALS.has(t)) continue;
    if (SUFFIXES.has(t)) continue;
    if (t === 'in' || t === 'at' || t === 'on') continue;
    if (/^\d+$/.test(t)) continue;
    streetToken = t;
    break;
  }
  if (!streetToken) return null;
  return { houseNumber, streetToken, key: `${houseNumber}|${streetToken}` };
}

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

// loose key matcher: "First Name", "first_name", "firstName" all land on firstname
function pick(body, ...names) {
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const map = {};
  for (const [k, v] of Object.entries(body)) map[norm(k)] = v;
  for (const n of names) {
    const v = map[norm(n)];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

function cleanPhone(p) {
  if (!p) return null;
  const digits = String(p).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return p.startsWith('+') ? p : null;
}

function resp(code, obj) {
  return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(200, { ok: true, note: 'POST only' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch { body = Object.fromEntries(new URLSearchParams(event.body || '')); }

  try {
    const firstName = pick(body, 'first_name', 'firstname', 'First Name') || '';
    const lastName  = pick(body, 'last_name', 'lastname', 'Last Name') || '';
    const address   = pick(body, 'address', 'listing_address', 'full_address', 'Address');
    const phone     = cleanPhone(pick(body, 'phone', 'seller_phone', 'Phone'));
    const email     = pick(body, 'email', 'seller_email', 'Seller Email', 'Email');
    const contactId = pick(body, 'contact_id', 'ghl_contact_id', 'contactId', 'GHL Contact ID', 'id');

    if (!address) return resp(400, { ok: false, error: 'address required' });

    const norm = normalizeAddress(address);
    if (!norm) return resp(400, { ok: false, error: `could not normalize address: ${address}` });

    // parse city/state/zip from "123 Main St, Republic, MO 65738" if present
    const parts = String(address).split(',').map(s => s.trim());
    const city = parts.length >= 2 ? parts[1] : null;
    let state = null, zip = null;
    if (parts.length >= 3) {
      const m = parts[2].match(/([A-Za-z]{2})\s*(\d{5})?/);
      if (m) { state = (m[1] || '').toUpperCase(); zip = m[2] || null; }
    }

    const sellerName = `${firstName} ${lastName}`.trim() || null;

    const record = {
      address_full: address,
      address_key: norm.key,
      house_number: norm.houseNumber,
      street_token: norm.streetToken,
      city, state, zip,
      seller_name: sellerName,
      seller_first_name: firstName || null,
      seller_last_name: lastName || null,
      seller_phone: phone,
      seller_email: email,
      seller_contact_id: contactId,
      status: 'active'
    };

    // find existing: by contact id first, then by address key
    let existing = null;
    if (contactId) {
      const r = await sb(`listings?seller_contact_id=eq.${encodeURIComponent(contactId)}&address_key=eq.${encodeURIComponent(norm.key)}&select=id`);
      existing = r && r[0];
    }
    if (!existing) {
      const r = await sb(`listings?address_key=eq.${encodeURIComponent(norm.key)}&select=id,status`);
      existing = r && r[0];
    }

    if (existing) {
      // update contact/seller info; do NOT clobber rules Tanya may have set
      const [row] = await sb(`listings?id=eq.${existing.id}`, { method: 'PATCH', body: record });
      console.log(`sync-listing: updated ${row.address_full} (${row.id})`);
      return resp(200, { ok: true, action: 'updated', id: row.id, address: row.address_full });
    }

    // brand new: safe defaults (occupied + approval until Tanya says otherwise)
    const [row] = await sb('listings', {
      method: 'POST',
      body: {
        ...record,
        occupancy: 'occupied',
        requires_approval: true,
        allowed_start: '09:00',
        allowed_end: '20:00',
        slot_minutes: 60,
        notice_hours: 0
      }
    });
    console.log(`sync-listing: created ${row.address_full} (${row.id})`);
    return resp(200, { ok: true, action: 'created', id: row.id, address: row.address_full });

  } catch (err) {
    console.error('sync-listing error:', err);
    return resp(500, { ok: false, error: err.message });
  }
};

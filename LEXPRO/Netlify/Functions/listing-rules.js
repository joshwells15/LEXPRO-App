// LEXPRO :: listing-rules.js
// GET  -> list all listings with their showing rules (for the app's Listings page)
// POST -> update one listing's rules { id, occupancy, requires_approval,
//          allowed_start, allowed_end, showing_notes }
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;


/* ---- app-status -> sheet Active column write-back ---- */
const crypto = require('crypto');
const SHEET_ID = '1KlfQEU02BcEM9RUTTi64-Eu60UzuaptT_EjE6OAXKOY';

function b64url(i){return Buffer.from(i).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}

async function getGoogleToken() {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now()/1000);
  const header = b64url(JSON.stringify({alg:'RS256',typ:'JWT'}));
  const claims = b64url(JSON.stringify({iss:sa.client_email,scope:'https://www.googleapis.com/auth/spreadsheets',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600}));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const sig = signer.sign(sa.private_key).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const res = await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${header}.${claims}.${sig}`});
  if(!res.ok) throw new Error('google token '+res.status);
  return (await res.json()).access_token;
}

// status change -> sheet L column: active->Yes, anything else->No
async function writeSheetActive(sellerContactId, newStatus) {
  try {
    const token = await getGoogleToken();
    const read = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent('Active Listings')}!N2:N500`,
      { headers: { Authorization: `Bearer ${token}` } });
    if (!read.ok) throw new Error('read '+read.status);
    const col = (await read.json()).values || [];
    let rowNumber = -1;
    for (let i = 0; i < col.length; i++) {
      if ((col[i][0] || '').trim() === sellerContactId) { rowNumber = i + 2; break; }
    }
    if (rowNumber === -1) return false;
    const val = newStatus === 'active' ? 'Yes' : 'No';
    const up = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent('Active Listings')}!L${rowNumber}?valueInputOption=USER_ENTERED`,
      { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [[val]] }) });
    if (!up.ok) throw new Error('write '+up.status);
    console.log(`sheet Active set ${val} for ${sellerContactId} (row ${rowNumber})`);
    return true;
  } catch (e) { console.error('writeSheetActive failed (non-fatal):', e.message); return false; }
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

function resp(code, obj) {
  return {
    statusCode: code,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'GET') {
      const rows = await sb(
        'listings?select=id,address_full,seller_name,status,occupancy,' +
        'requires_approval,allowed_start,allowed_end,slot_minutes,notice_hours,' +
        'showing_notes,internal_notes,blackout_windows' +
        '&order=address_full.asc'
      );
      return resp(200, { ok: true, listings: rows });
    }

    if (event.httpMethod === 'POST') {
      let b;
      try { b = JSON.parse(event.body || '{}'); }
      catch { return resp(400, { ok: false, error: 'bad json' }); }

      if (!b.id) return resp(400, { ok: false, error: 'id required' });

      const patch = {};
      if (b.occupancy === 'occupied' || b.occupancy === 'vacant') patch.occupancy = b.occupancy;
      if (typeof b.requires_approval === 'boolean') patch.requires_approval = b.requires_approval;
      if (/^\d{2}:\d{2}$/.test(b.allowed_start || '')) patch.allowed_start = b.allowed_start;
      if (/^\d{2}:\d{2}$/.test(b.allowed_end || '')) patch.allowed_end = b.allowed_end;
      if (typeof b.showing_notes === 'string') patch.showing_notes = b.showing_notes.slice(0, 1000);
      if (typeof b.internal_notes === 'string') patch.internal_notes = b.internal_notes.slice(0, 1000);
      if (['active','paused','under_contract'].includes(b.status)) patch.status = b.status;
      if (Array.isArray(b.blackout_windows)) {
        const clean = b.blackout_windows.filter(w =>
          w && Array.isArray(w.days) && w.days.every(d => d >= 0 && d <= 6) &&
          /^\d{2}:\d{2}$/.test(w.start || '') && /^\d{2}:\d{2}$/.test(w.end || '') &&
          w.start < w.end
        ).slice(0, 10).map(w => ({ days: w.days, start: w.start, end: w.end, label: String(w.label || '').slice(0, 60) }));
        patch.blackout_windows = clean;
      }
      if (Number.isInteger(b.notice_hours) && b.notice_hours >= 0 && b.notice_hours <= 72)
        patch.notice_hours = b.notice_hours;
      else if (typeof b.notice_hours === 'string' && /^\d+$/.test(b.notice_hours))
        patch.notice_hours = Math.min(72, parseInt(b.notice_hours));

      if (!Object.keys(patch).length) return resp(400, { ok: false, error: 'nothing to update' });

      // guardrail: hours must make sense
      if (patch.allowed_start && patch.allowed_end && patch.allowed_start >= patch.allowed_end)
        return resp(400, { ok: false, error: 'start must be before end' });

      const [row] = await sb(`listings?id=eq.${encodeURIComponent(b.id)}`, {
        method: 'PATCH',
        body: patch
      });
      if (!row) return resp(404, { ok: false, error: 'listing not found' });
      if (patch.status && row.seller_contact_id) {
        await writeSheetActive(row.seller_contact_id, patch.status);
      }
      return resp(200, { ok: true, listing: row });
    }

    return resp(405, { ok: false, error: 'GET or POST only' });
  } catch (err) {
    console.error('listing-rules error:', err);
    return resp(500, { ok: false, error: err.message });
  }
};

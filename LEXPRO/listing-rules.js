// LEXPRO :: listing-rules.js
// GET  -> list all listings with their showing rules (for the app's Listings page)
// POST -> update one listing's rules { id, occupancy, requires_approval,
//          allowed_start, allowed_end, showing_notes }
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

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
        'requires_approval,allowed_start,allowed_end,slot_minutes,notice_hours,showing_notes' +
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
      if (Number.isInteger(b.notice_hours) && b.notice_hours >= 0 && b.notice_hours <= 72)
        patch.notice_hours = b.notice_hours;

      if (!Object.keys(patch).length) return resp(400, { ok: false, error: 'nothing to update' });

      // guardrail: hours must make sense
      if (patch.allowed_start && patch.allowed_end && patch.allowed_start >= patch.allowed_end)
        return resp(400, { ok: false, error: 'start must be before end' });

      const [row] = await sb(`listings?id=eq.${encodeURIComponent(b.id)}`, {
        method: 'PATCH',
        body: patch
      });
      if (!row) return resp(404, { ok: false, error: 'listing not found' });
      return resp(200, { ok: true, listing: row });
    }

    return resp(405, { ok: false, error: 'GET or POST only' });
  } catch (err) {
    console.error('listing-rules error:', err);
    return resp(500, { ok: false, error: err.message });
  }
};

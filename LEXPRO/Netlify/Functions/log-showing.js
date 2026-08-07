// LEXPRO :: log-showing.js
// Manual showing entry from the app (phone-booked showings become first-class
// rows). Fetches the listing server-side and forwards the exact same payload
// shape as Donna's confirmations to the Showing Intake webhook - so the sheet
// row, showing count, and confirmation machinery all run identically.
//
// POST { listing_id, agent_name, agent_phone, showing_date "YYYY-MM-DD",
//        showing_time "HH:MM" }
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY, SHOWING_INTAKE_WEBHOOK

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const INTAKE_WEBHOOK = process.env.SHOWING_INTAKE_WEBHOOK;

async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`
    }
  });
  if (!res.ok) throw new Error(`Supabase ${path} -> ${res.status}`);
  return res.json();
}

function resp(code, obj) {
  return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { ok: false, error: 'POST only' });
  let b = {};
  try { b = JSON.parse(event.body || '{}'); } catch { }

  const { listing_id, agent_name, agent_phone, showing_date, showing_time } = b;
  if (!listing_id) return resp(400, { ok: false, error: 'listing_id required' });
  if (!agent_name || !String(agent_name).trim()) return resp(400, { ok: false, error: 'agent name required' });
  if (!agent_phone || String(agent_phone).replace(/\D/g, '').length < 10)
    return resp(400, { ok: false, error: 'a valid agent phone is required (the feedback follow-ups text it)' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(showing_date || '')) return resp(400, { ok: false, error: 'showing_date YYYY-MM-DD required' });
  if (!/^\d{2}:\d{2}$/.test(showing_time || '')) return resp(400, { ok: false, error: 'showing_time HH:MM required' });
  if (!INTAKE_WEBHOOK) return resp(500, { ok: false, error: 'SHOWING_INTAKE_WEBHOOK not configured' });

  try {
    const [listing] = await sb(`listings?id=eq.${encodeURIComponent(listing_id)}&select=*`);
    if (!listing) return resp(404, { ok: false, error: 'listing not found' });

    const digits = String(agent_phone).replace(/\D/g, '');
    const prettyPhone = digits.length === 10
      ? `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`
      : agent_phone;

    const payload = {
      seller_first_name: listing.seller_first_name || '',
      seller_last_name: listing.seller_last_name || '',
      seller_address: listing.address_full,
      seller_phone: listing.seller_phone || '',
      seller_email: listing.seller_email || '',
      seller_contact_id: listing.seller_contact_id || '',
      agent_name: String(agent_name).trim(),
      agent_phone: prettyPhone,
      agent_email: '',
      showing_date,
      showing_time,
      intake_source: 'Manual'
    };

    const r = await fetch(INTAKE_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error(`intake webhook ${r.status}`);

    console.log(`manual showing logged: ${listing.address_full} / ${agent_name} / ${showing_date} ${showing_time}`);
    return resp(200, { ok: true, address: listing.address_full });
  } catch (err) {
    console.error('log-showing error:', err);
    return resp(500, { ok: false, error: err.message });
  }
};

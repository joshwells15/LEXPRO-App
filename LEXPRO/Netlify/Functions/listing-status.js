// LEXPRO :: listing-status.js
// Instant registry status updates from the Make transaction scenarios.
// POST { contact_id, status }  where status: "under_contract" | "closed"
//   - under_contract: listing stays in registry, Donna declines showings with
//     the under-contract message
//   - closed: listing marked closed (registry keeps the record; Donna declines)
// Matches by seller_contact_id. If the seller has multiple listings, the
// optional "address" field narrows by address matching; otherwise all their
// active listings get the status (correct for single-listing sellers).
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
  return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { ok: false, error: 'POST only' });
  let b = {};
  try { b = JSON.parse(event.body || '{}'); } catch { }

  const contactId = (b.contact_id || '').trim();
  const status = (b.status || '').trim();
  if (!contactId) return resp(400, { ok: false, error: 'contact_id required' });
  if (!['under_contract', 'closed'].includes(status))
    return resp(400, { ok: false, error: 'status must be under_contract or closed' });

  try {
    let listings = await sb(
      `listings?seller_contact_id=eq.${encodeURIComponent(contactId)}&status=not.eq.closed&select=id,address_full,status`
    );
    if (!listings.length) return resp(200, { ok: true, updated: 0, note: 'no matching listings' });

    // optional address narrowing for multi-listing sellers
    if (b.address && listings.length > 1) {
      const want = String(b.address).toLowerCase().replace(/\W/g, '');
      const narrowed = listings.filter(l =>
        want.includes(String(l.address_full).toLowerCase().replace(/\W/g, '').slice(0, 12)) ||
        String(l.address_full).toLowerCase().replace(/\W/g, '').includes(want.slice(0, 12)));
      if (narrowed.length) listings = narrowed;
    }

    for (const l of listings) {
      await sb(`listings?id=eq.${l.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { status }
      });
    }

    console.log(`listing-status: ${status} -> ${listings.map(l => l.address_full).join(', ')}`);
    return resp(200, { ok: true, updated: listings.length, addresses: listings.map(l => l.address_full) });
  } catch (err) {
    console.error('listing-status error:', err);
    return resp(500, { ok: false, error: err.message });
  }
};

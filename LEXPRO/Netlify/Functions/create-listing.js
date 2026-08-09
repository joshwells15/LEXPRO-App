// LEXPRO :: create-listing.js
// One-shot listing go-live from the New Listing wizard.
// Order of operations matters:
//   1. UPSERT the Supabase registry row (by address_key) WITH showing rules —
//      so when the GHL workflow fires Make -> sync-listing seconds later,
//      sync-listing finds this row and doesn't create a bare duplicate.
//   2. PUT the GHL contact: address fields, price, live date, side, and
//      seller_transactions = "Listing Live" — the one domino that triggers
//      the existing GHL workflow (seller email + pipeline move + Make webhook
//      that adds the Active Listings sheet row).
//
// POST {
//   contactId, firstName, lastName, phone, email,
//   street, city, state, zip, price, side, liveDate,
//   occupancy ('occupied'|'vacant'), requiresApproval (bool),
//   allowedStart ('09:00'), allowedEnd ('19:00'),
//   noticeHours (int), showingNotes
// }

const SUPABASE_URL = 'https://dqiiekdfmocvizzvmwlc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || 'sb_publishable_TCNeI1Mg36-kXLJKA33h1g_emUHiC-Z';
const GHL_KEY = process.env.GHL_API_KEY || 'pit-b2267e03-7ae0-43d3-9cd0-02fa58f3d730';

const DIRECTIONALS = new Set(['n','s','e','w','ne','nw','se','sw','north','south','east','west']);

function deriveKey(street) {
  const tokens = String(street || '').trim().toLowerCase().split(/\s+/);
  const houseNumber = (tokens[0] || '').replace(/[^0-9a-z]/g, '');
  let streetToken = '';
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i].replace(/[^a-z0-9]/g, '');
    if (!t || DIRECTIONALS.has(t)) continue;
    streetToken = t;
    break;
  }
  return { houseNumber, streetToken, addressKey: `${houseNumber}|${streetToken}` };
}

function resp(code, obj) {
  return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { error: 'POST only' });
  let b = {};
  try { b = JSON.parse(event.body || '{}'); } catch { }

  const {
    contactId, firstName = '', lastName = '', phone = '', email = '',
    street = '', city = '', state = 'MO', zip = '', price = '', side = '', liveDate = '',
    occupancy = 'occupied', requiresApproval = true,
    allowedStart = '09:00', allowedEnd = '19:00',
    noticeHours = 0, showingNotes = ''
  } = b;

  if (!contactId) return resp(400, { error: 'No contact selected.' });
  if (!street.trim() || !city.trim() || !state.trim() || !zip.trim()) {
    return resp(400, { error: 'All address fields are required.' });
  }
  if (!['occupied', 'vacant'].includes(occupancy)) {
    return resp(400, { error: 'Occupancy must be occupied or vacant.' });
  }

  const { houseNumber, streetToken, addressKey } = deriveKey(street);
  const addressFull = `${street.trim()}, ${city.trim()}, ${state.trim().toUpperCase()} ${zip.trim()}`;
  const sellerName = `${firstName} ${lastName}`.trim();

  const sbHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  const registryRow = {
    address_full: addressFull,
    address_key: addressKey,
    house_number: houseNumber,
    street_token: streetToken,
    city: city.trim(),
    state: state.trim().toUpperCase(),
    zip: zip.trim(),
    seller_name: sellerName || null,
    seller_first_name: firstName || null,
    seller_last_name: lastName || null,
    seller_phone: phone || null,
    seller_email: email || null,
    seller_contact_id: contactId,
    occupancy,
    requires_approval: !!requiresApproval,
    allowed_start: allowedStart || '09:00',
    allowed_end: allowedEnd || '19:00',
    notice_hours: parseInt(noticeHours, 10) || 0,
    showing_notes: showingNotes || null,
    status: 'active',
    updated_at: new Date().toISOString()
  };

  try {
    // ── STEP 1: registry upsert (lookup by address_key, then PATCH or POST) ──
    let registryAction = 'created';
    const findRes = await fetch(
      `${SUPABASE_URL}/rest/v1/listings?address_key=eq.${encodeURIComponent(addressKey)}&select=id`,
      { headers: sbHeaders }
    );
    if (!findRes.ok) throw new Error(`registry lookup ${findRes.status}: ${await findRes.text()}`);
    const existing = await findRes.json();

    if (existing.length > 0) {
      registryAction = 'updated';
      const patchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/listings?id=eq.${existing[0].id}`,
        { method: 'PATCH', headers: sbHeaders, body: JSON.stringify(registryRow) }
      );
      if (!patchRes.ok) throw new Error(`registry update ${patchRes.status}: ${await patchRes.text()}`);
    } else {
      const insRes = await fetch(
        `${SUPABASE_URL}/rest/v1/listings`,
        { method: 'POST', headers: sbHeaders, body: JSON.stringify(registryRow) }
      );
      if (!insRes.ok) throw new Error(`registry insert ${insRes.status}: ${await insRes.text()}`);
    }

    // ── STEP 2: GHL domino — identical contract to the old update-listing ──
    const customFields = [
      { key: 'seller__subject_property_street',   field_value: street.trim() },
      { key: 'seller__subject_property_city',     field_value: city.trim() },
      { key: 'seller__subject_property_state',    field_value: state.trim() },
      { key: 'seller__subject_property_zip_code', field_value: zip.trim() },
      { key: 'seller_transactions',               field_value: 'Listing Live' },
    ];
    if (side) customFields.push({ key: 'represented_side', field_value: [side] });
    if (liveDate) customFields.push({ key: 'listing_live', field_value: liveDate });
    if (price) {
      const cleanPrice = String(price).replace(/[^0-9.]/g, '');
      if (cleanPrice) customFields.push({ key: 'listing_price', field_value: cleanPrice });
    }

    const ghlRes = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${GHL_KEY}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ customFields }),
    });
    const ghlData = await ghlRes.json();
    if (!ghlRes.ok) {
      return resp(ghlRes.status, {
        error: (ghlData && ghlData.message) || 'GHL rejected the update.',
        note: `Registry row was ${registryAction} — GHL step failed. Fix and resubmit; the registry upsert is idempotent.`
      });
    }

    return resp(200, { ok: true, registry: registryAction, addressKey });
  } catch (err) {
    console.error('create-listing error:', err);
    return resp(500, { error: err.message });
  }
};

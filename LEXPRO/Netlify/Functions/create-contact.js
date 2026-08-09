// LEXPRO :: create-contact.js
// Creates (or updates, via GHL upsert) a contact — ALWAYS tagged 'lexpro' —
// with optional represented_side routing.
// POST { firstName, lastName, phone, email, side }  (side: 'Seller'|'Buyer'|'Dual Agency'|'')

const GHL_API_KEY = process.env.GHL_API_KEY || 'pit-b2267e03-7ae0-43d3-9cd0-02fa58f3d730';
const LOCATION_ID = 'R5PobkV1CRO23kz95yYB';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  let b;
  try { b = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { firstName = '', lastName = '', phone = '', email = '', side = '' } = b;
  if (!firstName.trim() || !lastName.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'First and last name are required.' }) };
  }
  if (!phone.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Phone is required.' }) };
  }

  const payload = {
    locationId: LOCATION_ID,
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    phone: phone.trim(),
    tags: ['lexpro'],
  };
  if (email.trim()) payload.email = email.trim();
  if (side) payload.customFields = [{ key: 'represented_side', field_value: [side] }];

  try {
    const res = await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('GHL upsert error:', JSON.stringify(data));
      return { statusCode: res.status, body: JSON.stringify({ error: (data && data.message) || 'GHL rejected the contact.' }) };
    }
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, isNew: !!data.new, contactId: data.contact && data.contact.id })
    };
  } catch (err) {
    console.error('create-contact error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

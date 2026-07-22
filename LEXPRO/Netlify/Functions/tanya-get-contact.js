// ============================================================
// tanya-get-contact.js
// Searches GHL contacts by name or phone
// Uses the correct v2 search endpoint
// ============================================================

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { name, phone } = JSON.parse(event.body);
    const GHL_API_KEY = process.env.GHL_API_KEY;
    const GHL_LOCATION = process.env.GHL_LOCATION_ID || 'R5PobkV1CRO23kz95yYB';

    if (!name && !phone) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Name or phone is required' }) };
    }

    let contacts = [];

    // ── Try POST search endpoint first ──────────────────────
    if (name) {
      const res = await fetch(
        `https://services.leadconnectorhq.com/contacts/search`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Version': '2021-07-28',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            locationId: GHL_LOCATION,
            searchAfter: [],
            filters: [],
            sort: [],
            pageLimit: 5,
            query: name
          })
        }
      );
      const data = await res.json();
      contacts = data.contacts || [];
      console.log('POST search result:', JSON.stringify(data).slice(0, 300));
    }

    // ── Fallback: GET with query param ──────────────────────
    if (!contacts.length && name) {
      const res = await fetch(
        `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION}&query=${encodeURIComponent(name)}&limit=5`,
        {
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Version': '2021-07-28'
          }
        }
      );
      const data = await res.json();
      contacts = data.contacts || [];
      console.log('GET query fallback:', JSON.stringify(data).slice(0, 300));
    }

    // ── Fallback: search by phone ────────────────────────────
    if (!contacts.length && phone) {
      const normalized = phone.replace(/\D/g, '');
      const e164 = normalized.startsWith('1') ? `+${normalized}` : `+1${normalized}`;
      const res = await fetch(
        `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION}&query=${encodeURIComponent(e164)}&limit=5`,
        {
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Version': '2021-07-28'
          }
        }
      );
      const data = await res.json();
      contacts = data.contacts || [];
      console.log('Phone fallback:', JSON.stringify(data).slice(0, 300));
    }

    if (!contacts.length) {
      return {
        statusCode: 200,
        body: JSON.stringify({ found: false, contacts: [] })
      };
    }

    const results = contacts.map(c => ({
      id: c.id,
      name: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
      phone: c.phone || null,
      email: c.email || null
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({ found: true, contacts: results })
    };

  } catch (err) {
    console.error('tanya-get-contact error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

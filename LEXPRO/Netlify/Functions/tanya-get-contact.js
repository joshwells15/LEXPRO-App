// ============================================================
// tanya-get-contact.js
// Searches GHL contacts by name or phone
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

    // Try name search first
    if (name) {
      const res = await fetch(
        `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION}&search=${encodeURIComponent(name)}&limit=5`,
        {
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Version': '2021-07-28'
          }
        }
      );
      const data = await res.json();
      contacts = data.contacts || [];
    }

    // If name search returned nothing, try phone
    if (!contacts.length && phone) {
      const normalized = phone.replace(/\D/g, '');
      const e164 = normalized.startsWith('1') ? `+${normalized}` : `+1${normalized}`;
      const res = await fetch(
        `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION}&search=${encodeURIComponent(e164)}&limit=5`,
        {
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Version': '2021-07-28'
          }
        }
      );
      const data = await res.json();
      contacts = data.contacts || [];
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
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
  }
};

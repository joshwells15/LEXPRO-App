// ============================================================
// tanya-get-contact.js
// Searches GHL contacts by name and returns id, phone, email
// ============================================================

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { name } = JSON.parse(event.body);
    const GHL_API_KEY = process.env.GHL_API_KEY;
    const GHL_LOCATION = process.env.GHL_LOCATION_ID || 'R5PobkV1CRO23kz95yYB';

    if (!name) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Name is required' }) };
    }

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
    const contacts = data.contacts || [];

    if (!contacts.length) {
      return {
        statusCode: 200,
        body: JSON.stringify({ found: false, contacts: [] })
      };
    }

    // Return top matches with id, name, phone, email
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

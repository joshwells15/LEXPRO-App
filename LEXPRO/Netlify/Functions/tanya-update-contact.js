// ============================================================
// tanya-update-contact.js
// Updates a GHL contact's fields (email, phone, name, etc.)
// ============================================================

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { contactId, updates } = JSON.parse(event.body);
    const GHL_API_KEY = process.env.GHL_API_KEY;

    if (!contactId || !updates) {
      return { statusCode: 400, body: JSON.stringify({ error: 'contactId and updates are required' }) };
    }

    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updates)
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('GHL update error:', data);
      return { statusCode: 500, body: JSON.stringify({ error: 'GHL update failed', detail: data }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, contact: data.contact })
    };

  } catch (err) {
    console.error('tanya-update-contact error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// ============================================================
// tanya-send-email.js
// Sends a single email to a contact via GHL
// ============================================================

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { contactId, email, subject, message, to } = JSON.parse(event.body);
    const GHL_API_KEY = process.env.GHL_API_KEY;
    const GHL_LOCATION = process.env.GHL_LOCATION_ID || 'R5PobkV1CRO23kz95yYB';

    if (!message || !subject) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Subject and message are required' }) };
    }

    let resolvedContactId = contactId;

    // If no contactId, look up by email
    if (!resolvedContactId && email) {
      const searchRes = await fetch(
        `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION}&email=${encodeURIComponent(email)}`,
        {
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Version': '2021-07-28'
          }
        }
      );
      const searchData = await searchRes.json();
      resolvedContactId = searchData.contacts?.[0]?.id;
    }

    if (!resolvedContactId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Could not resolve contact ID' }) };
    }

    const res = await fetch(`https://services.leadconnectorhq.com/conversations/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-04-15',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'Email',
        contactId: resolvedContactId,
        subject,
        html: `<p>${message.replace(/\n/g, '</p><p>')}</p>`
      })
    });

    const data = await res.json();
    if (!res.ok) {
      console.error('GHL email error:', data);
      return { statusCode: 500, body: JSON.stringify({ error: 'GHL send failed', detail: data }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, messageId: data.messageId, to })
    };

  } catch (err) {
    console.error('tanya-send-email error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
  }
};

// ============================================================
// tanya-send-sms.js
// Sends a single SMS to a contact via GHL
// ============================================================

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { contactId, phone, message, to } = JSON.parse(event.body);
    const GHL_API_KEY = process.env.GHL_API_KEY;
    const GHL_LOCATION = process.env.GHL_LOCATION_ID || 'R5PobkV1CRO23kz95yYB';

    if (!message) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Message is required' }) };
    }

    // If we have a contactId, send via GHL conversations API
    if (contactId) {
      const res = await fetch(`https://services.leadconnectorhq.com/conversations/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-04-15',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type: 'SMS',
          contactId,
          message
        })
      });

      const data = await res.json();
      if (!res.ok) {
        console.error('GHL SMS error:', data);
        return { statusCode: 500, body: JSON.stringify({ error: 'GHL send failed', detail: data }) };
      }

      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, messageId: data.messageId, to })
      };
    }

    // No contactId — try to look up by phone
    if (phone) {
      const normalized = phone.replace(/\D/g, '');
      const e164 = normalized.startsWith('1') ? `+${normalized}` : `+1${normalized}`;

      // Search GHL for contact by phone
      const searchRes = await fetch(
        `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION}&phone=${encodeURIComponent(e164)}`,
        {
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Version': '2021-07-28'
          }
        }
      );
      const searchData = await searchRes.json();
      const contact = searchData.contacts?.[0];

      if (contact) {
        const res = await fetch(`https://services.leadconnectorhq.com/conversations/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Version': '2021-04-15',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ type: 'SMS', contactId: contact.id, message })
        });
        const data = await res.json();
        if (!res.ok) return { statusCode: 500, body: JSON.stringify({ error: 'GHL send failed', detail: data }) };
        return { statusCode: 200, body: JSON.stringify({ ok: true, to }) };
      }
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'No contactId or phone provided' }) };

  } catch (err) {
    console.error('tanya-send-sms error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
  }
};

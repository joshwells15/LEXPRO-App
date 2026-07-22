// ============================================================
// tanya-blast-sms.js
// Mass SMS to all contacts with the 'lexpro' tag via GHL
// Fires one at a time with a small delay to avoid rate limits
// ============================================================

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { tag = 'lexpro', message } = JSON.parse(event.body);
    const GHL_API_KEY = process.env.GHL_API_KEY;
    const GHL_LOCATION = process.env.GHL_LOCATION_ID || 'R5PobkV1CRO23kz95yYB';

    if (!message) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Message is required' }) };
    }

    // Pull all contacts with the lexpro tag
    let allContacts = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const res = await fetch(
        `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION}&tags=${encodeURIComponent(tag)}&limit=100&page=${page}`,
        {
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Version': '2021-07-28'
          }
        }
      );
      const data = await res.json();
      const contacts = data.contacts || [];
      allContacts = [...allContacts, ...contacts];

      if (contacts.length < 100) {
        hasMore = false;
      } else {
        page++;
      }
    }

    if (!allContacts.length) {
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, count: 0, message: 'No contacts found with that tag.' })
      };
    }

    // Send SMS to each contact
    let sent = 0;
    let failed = 0;

    for (const contact of allContacts) {
      try {
        // Skip contacts with no phone
        if (!contact.phone) { failed++; continue; }

        const res = await fetch(`https://services.leadconnectorhq.com/conversations/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Version': '2021-04-15',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            type: 'SMS',
            contactId: contact.id,
            message
          })
        });

        if (res.ok) {
          sent++;
        } else {
          failed++;
          console.error(`Failed to send to ${contact.id}`);
        }

        // Small delay to avoid GHL rate limits
        await new Promise(r => setTimeout(r, 150));

      } catch (e) {
        failed++;
        console.error(`Error sending to contact ${contact.id}:`, e);
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        count: sent,
        failed,
        total: allContacts.length
      })
    };

  } catch (err) {
    console.error('tanya-blast-sms error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
  }
};

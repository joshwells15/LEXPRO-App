// LEXPRO :: search-contacts.js
// GHL contact search for app pickers. Same response contract as the old
// showings-app function: { contacts: [{id, firstName, lastName, contactName, phone, email}] }
// GET /.netlify/functions/search-contacts?query=jo

const GHL_KEY = process.env.GHL_API_KEY || 'pit-b2267e03-7ae0-43d3-9cd0-02fa58f3d730';
const LOCATION_ID = 'R5PobkV1CRO23kz95yYB';

exports.handler = async (event) => {
  const query = (event.queryStringParameters && event.queryStringParameters.query || '').trim();
  if (query.length < 2) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contacts: [] }) };
  }
  try {
    const url = `https://services.leadconnectorhq.com/contacts/?locationId=${LOCATION_ID}&query=${encodeURIComponent(query)}&limit=10`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${GHL_KEY}`, 'Version': '2021-07-28' }
    });
    const data = await res.json();
    if (!res.ok) {
      return { statusCode: res.status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: data.message || 'GHL search failed', contacts: [] }) };
    }
    const contacts = (data.contacts || []).map(c => ({
      id: c.id,
      firstName: c.firstName || '',
      lastName: c.lastName || '',
      contactName: c.contactName || '',
      phone: c.phone || '',
      email: c.email || ''
    }));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contacts }) };
  } catch (err) {
    console.error('search-contacts error:', err);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message, contacts: [] }) };
  }
};

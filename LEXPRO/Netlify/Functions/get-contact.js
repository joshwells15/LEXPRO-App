// LEXPRO :: get-contact.js
// Lightweight contact info for UC screens: resolves stage + prices by field KEY at runtime.
// GET /.netlify/functions/get-contact?id=<contactId>

const GHL_KEY = process.env.GHL_API_KEY || 'pit-b2267e03-7ae0-43d3-9cd0-02fa58f3d730';
const LOCATION_ID = 'R5PobkV1CRO23kz95yYB';
const WANT_KEYS = ['seller_transactions', 'buyer_transactions', 'sales_price', 'listing_price', 'tentative_closing', 'under_contract'];

let fieldMapCache = null;
async function getFieldMap() {
  if (fieldMapCache) return fieldMapCache;
  const res = await fetch(`https://services.leadconnectorhq.com/locations/${LOCATION_ID}/customFields`, {
    headers: { 'Authorization': `Bearer ${GHL_KEY}`, 'Version': '2021-07-28' }
  });
  const data = await res.json();
  const map = {};
  (data.customFields || []).forEach(f => {
    const key = (f.fieldKey || '').replace(/^contact\./, '');
    if (WANT_KEYS.includes(key)) map[f.id] = key;
  });
  fieldMapCache = map;
  return map;
}

exports.handler = async (event) => {
  const id = event.queryStringParameters && event.queryStringParameters.id;
  if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id required' }) };
  try {
    const [fieldMap, cRes] = await Promise.all([
      getFieldMap(),
      fetch(`https://services.leadconnectorhq.com/contacts/${id}`, {
        headers: { 'Authorization': `Bearer ${GHL_KEY}`, 'Version': '2021-07-28' }
      })
    ]);
    const cData = await cRes.json();
    if (!cRes.ok) return { statusCode: cRes.status, body: JSON.stringify({ error: cData.message || 'GHL error' }) };
    const out = {};
    ((cData.contact && cData.contact.customFields) || []).forEach(f => {
      const key = fieldMap[f.id];
      if (key) out[key] = Array.isArray(f.value) ? f.value.join(', ') : (f.value || '');
    });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        stage: out.seller_transactions || out.buyer_transactions || '',
        salesPrice: out.sales_price || '',
        listPrice: out.listing_price || '',
        closing: out.tentative_closing || '',
        ucDate: out.under_contract || ''
      })
    };
  } catch (err) {
    console.error('get-contact error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

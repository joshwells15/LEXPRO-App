// LEXPRO :: buyer-sync.js
// Fired by the Buyer Transaction Update workflow (webhook step) whenever a
// buyer's stage changes. Reads the contact from GHL and finds-or-creates
// their row on the Buyers sheet tab.
//
// POST { contact_id }
//
// Buyers tab columns:
//   A First | B Last | C Address | D Phone | E Buyer Email | F UC Date
//   G Closing Date | H Sales Price | I Transaction Stage | J Stage Updated
//   K GHL Contact ID
//
// Field sources (contact custom fields, resolved by key at runtime):
//   buyer__subject_property_street/city/state/zip_code -> C
//   buyer_transactions -> I ; tentative_closing -> G ; sales_price -> H
// F stamps the first time stage = "Under Contract" and is never overwritten.
//
// ENV: GOOGLE_SERVICE_ACCOUNT_JSON

const crypto = require('crypto');
const SHEET_ID = '1KlfQEU02BcEM9RUTTi64-Eu60UzuaptT_EjE6OAXKOY';
const TAB = 'Buyers';
const GHL_KEY = 'pit-b2267e03-7ae0-43d3-9cd0-02fa58f3d730';
const LOCATION_ID = 'R5PobkV1CRO23kz95yYB';

const FIELD_KEYS = {
  street: 'buyer__subject_property_street',
  city: 'buyer__subject_property_city',
  state: 'buyer__subject_property_state',
  zip: 'buyer__subject_property_zip_code',
  stage: 'buyer_transactions',
  closing: 'tentative_closing',
  price: 'sales_price'
};

/* ---------- google auth ---------- */
function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function getGoogleToken() {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(sa.private_key).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${header}.${claims}.${signature}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  if (!res.ok) throw new Error(`google token ${res.status}`);
  return (await res.json()).access_token;
}

/* ---------- ghl ---------- */
const GHL_HEADERS = {
  Authorization: `Bearer ${GHL_KEY}`,
  Version: '2021-07-28',
  Accept: 'application/json'
};

// key -> field id map, resolved once per invocation
async function getFieldIdMap() {
  const res = await fetch(
    `https://services.leadconnectorhq.com/locations/${LOCATION_ID}/customFields`,
    { headers: GHL_HEADERS }
  );
  if (!res.ok) throw new Error(`GHL customFields ${res.status}`);
  const { customFields = [] } = await res.json();
  const byKey = {};
  for (const f of customFields) {
    // fieldKey looks like "contact.buyer_transactions"
    const key = String(f.fieldKey || '').replace(/^contact\./, '');
    byKey[key] = f.id;
  }
  const map = {};
  for (const [name, key] of Object.entries(FIELD_KEYS)) {
    map[name] = byKey[key] || null;
    if (!byKey[key]) console.warn(`field key not found in GHL: ${key}`);
  }
  return map;
}

function fieldValue(contact, fieldId) {
  if (!fieldId) return '';
  const arr = contact.customFields || contact.customField || [];
  const hit = arr.find(f => f.id === fieldId);
  return hit ? String(hit.value ?? '').trim() : '';
}

/* ---------- helpers ---------- */
function todayChicago() {
  return new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
}
function resp(code, obj) {
  return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

/* ---------- handler ---------- */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { ok: false, error: 'POST only' });
  let b = {};
  try { b = JSON.parse(event.body || '{}'); } catch { }
  const contactId = (b.contact_id || b.contactId || '').trim();
  if (!contactId) return resp(400, { ok: false, error: 'contact_id required' });

  try {
    /* 1. read the contact + field directory from GHL */
    const [contactRes, fieldMap] = await Promise.all([
      fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers: GHL_HEADERS }),
      getFieldIdMap()
    ]);
    if (!contactRes.ok) throw new Error(`GHL contact ${contactRes.status}`);
    const contact = (await contactRes.json()).contact;
    if (!contact) throw new Error('contact payload empty');

    const street = fieldValue(contact, fieldMap.street);
    const city = fieldValue(contact, fieldMap.city);
    const state = fieldValue(contact, fieldMap.state);
    const zip = fieldValue(contact, fieldMap.zip);
    const address = [street, city, [state, zip].filter(Boolean).join(' ')]
      .filter(Boolean).join(', ');

    const stage = fieldValue(contact, fieldMap.stage);
    const closing = fieldValue(contact, fieldMap.closing);
    const price = fieldValue(contact, fieldMap.price);

    const row = {
      first: contact.firstName || '',
      last: contact.lastName || '',
      address,
      phone: contact.phone || '',
      email: contact.email || '',
      closing,
      price,
      stage,
      stageUpdated: todayChicago()
    };

    /* 2. find existing row by contact id (column K) */
    const token = await getGoogleToken();
    let readRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}!A2:K1000`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!readRes.ok) {
      const errText = await readRes.text();
      if (readRes.status === 400 && errText.includes('Unable to parse range')) {
        /* Tab doesn't exist — self-heal: create it with headers, then continue */
        const mk = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{ addSheet: { properties: { title: TAB } } }] })
        });
        if (!mk.ok) throw new Error(`tab create ${mk.status}: ${await mk.text()}`);
        const hdr = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}!A1:K1?valueInputOption=USER_ENTERED`,
          { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ values: [[ 'First Name','Last Name','Address','Phone','Buyer Email','Under Contract Date','Closing Date','Sales Price','Transaction Stage','Stage Updated Date','GHL Contact ID' ]] }) }
        );
        if (!hdr.ok) throw new Error(`header write ${hdr.status}: ${await hdr.text()}`);
        readRes = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}!A2:K1000`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!readRes.ok) throw new Error(`sheets re-read ${readRes.status}: ${await readRes.text()}`);
      } else {
        throw new Error(`sheets read ${readRes.status}: ${errText}`);
      }
    }
    const rows = (await readRes.json()).values || [];
    let rowIndex = -1; // 0-based within rows (sheet row = index + 2)
    let existing = null;
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i][10] || '').trim() === contactId) { rowIndex = i; existing = rows[i]; break; }
    }

    /* 3. under-contract date: stamp once, never overwrite */
    const existingUc = existing ? (existing[5] || '').trim() : '';
    const ucDate = existingUc || (stage.toLowerCase() === 'under contract' ? todayChicago() : '');

    const values = [[
      row.first, row.last, row.address, row.phone, row.email,
      ucDate, row.closing, row.price, row.stage, row.stageUpdated, contactId
    ]];

    /* 4. update or append */
    if (rowIndex >= 0) {
      const sheetRow = rowIndex + 2;
      const upd = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}!A${sheetRow}:K${sheetRow}?valueInputOption=USER_ENTERED`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values })
        }
      );
      if (!upd.ok) throw new Error(`sheets update ${upd.status}: ${await upd.text()}`);
      console.log(`buyer-sync: updated ${row.first} ${row.last} -> ${row.stage}`);
      return resp(200, { ok: true, action: 'updated', row: sheetRow, stage: row.stage });
    } else {
      const app = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}!A:K:append?valueInputOption=USER_ENTERED`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values })
        }
      );
      if (!app.ok) throw new Error(`sheets append ${app.status}: ${await app.text()}`);
      console.log(`buyer-sync: added ${row.first} ${row.last} -> ${row.stage}`);
      return resp(200, { ok: true, action: 'created', stage: row.stage });
    }
  } catch (err) {
    console.error('buyer-sync error:', err);
    return resp(500, { ok: false, error: err.message });
  }
};

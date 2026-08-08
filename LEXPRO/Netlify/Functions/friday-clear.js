// LEXPRO :: friday-clear.js
// Runs Friday 9:15 AM Chicago (30 min after the Friday Seller Update Sender).
// Clears Option Selected (R) and Send Status (S) on every Active Listings row
// so next week's A/B/C flow starts clean. Replaces the Monday Tanya Reminder.
//
// ENV: GOOGLE_SERVICE_ACCOUNT_JSON
// netlify.toml:
//   [functions."friday-clear"]
//     schedule = "15 14 * * 5"   # 14:15 UTC = 9:15 AM CDT Friday

const crypto = require('crypto');
const SHEET_ID = '1KlfQEU02BcEM9RUTTi64-Eu60UzuaptT_EjE6OAXKOY';
const TAB = 'Active Listings';

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
  if (!res.ok) throw new Error(`google token ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

exports.handler = async () => {
  try {
    const token = await getGoogleToken();

    // find how many rows have data (read column A)
    const read = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}!A2:A500`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!read.ok) throw new Error(`sheets read ${read.status}`);
    const rows = ((await read.json()).values || []).length;
    if (!rows) return { statusCode: 200, body: JSON.stringify({ ok: true, cleared: 0 }) };

    // blank out R2:S(lastRow) in one call
    const clear = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}!R2:S${rows + 1}:clear`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
    );
    if (!clear.ok) throw new Error(`sheets clear ${clear.status}: ${await clear.text()}`);

    console.log(`friday-clear: cleared R2:S${rows + 1}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, cleared: rows }) };
  } catch (err) {
    console.error('friday-clear error:', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

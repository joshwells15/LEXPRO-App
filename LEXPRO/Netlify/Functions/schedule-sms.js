// LEXPRO :: schedule-sms.js
// Backend for the Scheduled SMS screen. Speaks the exact dialect of the
// "Scheduled SMS Action" tab that the Make Sender scenario (every 30 min)
// consumes: A MessageID | B First | C Last | D Phone(digits, no +) |
// E ContactID | F Message | G Send Date YYYY-MM-DD | H Send Time HH:mm |
// I Status (Pending/Sent/Cancelled) | J Created | K Sent At
//
// POST { action: "create", first, last, phone, contactId, message, sendDate, sendTime }
// POST { action: "list" }
// POST { action: "cancel", row }   <- sheet row number
//
// ENV: GOOGLE_SERVICE_ACCOUNT_JSON

const crypto = require('crypto');
const SHEET_ID = '1KlfQEU02BcEM9RUTTi64-Eu60UzuaptT_EjE6OAXKOY';
const TAB = 'Scheduled SMS Action';

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

function normalizePhone(p) {
  let digits = String(p || '').replace(/\D/g, '');
  if (digits.length === 10) digits = '1' + digits;
  return digits; // sheet stores without +, Sender prepends it
}
function nowStamp() {
  const d = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  // en-US gives MM/DD/YYYY, HH:mm -> convert to YYYY-MM-DD HH:mm
  const m = d.match(/(\d+)\/(\d+)\/(\d+),?\s+(\d+):(\d+)/);
  return m ? `${m[3]}-${m[1]}-${m[2]} ${m[4]}:${m[5]}` : d;
}
function resp(code, obj) {
  return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { ok: false, error: 'POST only' });
  let b = {};
  try { b = JSON.parse(event.body || '{}'); } catch { }
  const action = b.action || 'list';

  try {
    const token = await getGoogleToken();
    const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    if (action === 'create') {
      const { first = '', last = '', phone = '', contactId = '', message = '', sendDate = '', sendTime = '' } = b;
      if (!message.trim()) return resp(400, { ok: false, error: 'message required' });
      if (!sendDate || !sendTime) return resp(400, { ok: false, error: 'send date & time required' });
      const digits = normalizePhone(phone);
      if (digits.length < 11) return resp(400, { ok: false, error: 'valid phone required' });
      const row = [[
        `msg_${Date.now()}`,
        first, last, digits, contactId,
        message, sendDate, sendTime,
        'Pending', nowStamp(), ''
      ]];
      const app = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}!A:K:append?valueInputOption=USER_ENTERED`,
        { method: 'POST', headers: H, body: JSON.stringify({ values: row }) }
      );
      if (!app.ok) throw new Error(`append ${app.status}: ${await app.text()}`);
      return resp(200, { ok: true });
    }

    if (action === 'cancel') {
      const rowNum = parseInt(b.row, 10);
      if (!rowNum || rowNum < 2) return resp(400, { ok: false, error: 'row required' });
      const upd = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}!I${rowNum}?valueInputOption=USER_ENTERED`,
        { method: 'PUT', headers: H, body: JSON.stringify({ values: [['Cancelled']] }) }
      );
      if (!upd.ok) throw new Error(`cancel ${upd.status}: ${await upd.text()}`);
      return resp(200, { ok: true });
    }

    // list
    const readRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}!A2:K500`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!readRes.ok) throw new Error(`read ${readRes.status}: ${await readRes.text()}`);
    const rows = (await readRes.json()).values || [];
    const pending = [], sent = [];
    rows.forEach((r, i) => {
      const item = {
        row: i + 2,
        first: r[1] || '', last: r[2] || '', phone: r[3] || '',
        message: r[5] || '', sendDate: r[6] || '', sendTime: r[7] || '',
        status: r[8] || '', sentAt: r[10] || ''
      };
      if (item.status === 'Pending') pending.push(item);
      else if (item.status === 'Sent') sent.push(item);
    });
    pending.sort((a, b2) => (a.sendDate + a.sendTime).localeCompare(b2.sendDate + b2.sendTime));
    sent.sort((a, b2) => (b2.sentAt || '').localeCompare(a.sentAt || ''));
    return resp(200, { ok: true, pending, sent: sent.slice(0, 20) });
  } catch (err) {
    console.error('schedule-sms error:', err);
    return resp(500, { ok: false, error: err.message });
  }
};

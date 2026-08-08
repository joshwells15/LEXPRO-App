// LEXPRO :: weekly-digest.js
// Sunday 6 PM Chicago: one SMS to Josh summarizing the system's week.
// Pulls from the Showings sheet + Supabase. Also callable manually via POST
// (any body) for on-demand digests.
//
// ENV: GOOGLE_SERVICE_ACCOUNT_JSON, SUPABASE_URL, SUPABASE_SERVICE_KEY, GHL_API_KEY
// netlify.toml:
//   [functions."weekly-digest"]
//     schedule = "0 23 * * 0"   # 23:00 UTC Sunday = 6 PM CDT
//
// JOSH's GHL contact - where the digest lands
const JOSH_CONTACT_ID = 'txnhMCDRPWLUXXykNuE6';
const INTERNAL_FROM = '+14176474633';

const crypto = require('crypto');
const SHEET_ID = '1KlfQEU02BcEM9RUTTi64-Eu60UzuaptT_EjE6OAXKOY';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GHL_KEY = process.env.GHL_API_KEY;
const TZ = 'America/Chicago';

/* ---------- helpers ---------- */

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getGoogleToken() {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
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

async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  if (!res.ok) throw new Error(`Supabase ${path} -> ${res.status}`);
  return res.json();
}

// parse sheet dates like "8/6/2026" or "2026-08-06"
function parseSheetDate(s) {
  const str = String(s || '').trim();
  if (!str) return null;
  let m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
  m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const d = new Date(str);
  return isNaN(d) ? null : d;
}

/* ---------- handler ---------- */

exports.handler = async () => {
  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3600000);
    const weekAgoIso = weekAgo.toISOString();

    /* ----- Showings sheet: bookings + feedback this week ----- */
    let bookedDonna = 0, bookedManual = 0, fbSurvey = 0, fbTexted = 0, fbManual = 0, chasing = 0;
    try {
      const token = await getGoogleToken();
      const res = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent('Showings')}!A2:S1000`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const rows = (await res.json()).values || [];
      for (const r of rows) {
        const showDate = parseSheetDate(r[10]); // K
        if (!showDate || showDate < weekAgo) continue;
        const source = String(r[9] || '').toLowerCase(); // J intake source
        if (source.includes('manual')) bookedManual++; else bookedDonna++;
        const m = (r[12] || '').trim();  // M feedback received
        const n = (r[13] || '').trim();  // N content
        const o = (r[14] || '').trim();  // O survey stamp
        if (m) {
          if (n.startsWith('(texted)')) fbTexted++;
          else if (o) fbSurvey++;
          else fbManual++;
        } else if (showDate < now) {
          chasing++;
        }
      }
    } catch (e) { console.error('sheet read failed:', e.message); }

    /* ----- Supabase: escalations, listings, requests ----- */
    let escOpen = 0, escResolvedWk = 0, escNewWk = 0;
    let newListings = 0, activeListings = 0;
    let reqWk = 0, confirmedWk = 0;
    try {
      const esc = await sb(`escalations?select=status,created_at,resolved_at`);
      for (const e of esc) {
        if (e.status === 'open') escOpen++;
        if (e.created_at >= weekAgoIso) escNewWk++;
        if (e.resolved_at && e.resolved_at >= weekAgoIso) escResolvedWk++;
      }
    } catch (e) { console.error('escalations read failed:', e.message); }
    try {
      const ls = await sb(`listings?select=status,created_at`);
      for (const l of ls) {
        if (l.status === 'active') activeListings++;
        if (l.created_at >= weekAgoIso) newListings++;
      }
    } catch (e) { console.error('listings read failed:', e.message); }
    try {
      const reqs = await sb(`showing_requests?created_at=gte.${encodeURIComponent(weekAgoIso)}&select=status`);
      reqWk = reqs.length;
      confirmedWk = reqs.filter(r => r.status === 'confirmed').length;
    } catch (e) { console.error('requests read failed:', e.message); }

    /* ----- compose ----- */
    const fbTotal = fbSurvey + fbTexted + fbManual;
    const lines = [];
    lines.push(`LEXPRO weekly digest:`);
    lines.push(``);
    lines.push(`Showings: ${bookedDonna + bookedManual} this week (${bookedDonna} via Donna, ${bookedManual} manual)`);
    if (reqWk) lines.push(`Requests through Donna: ${reqWk} (${confirmedWk} confirmed)`);
    lines.push(`Feedback captured: ${fbTotal}` +
      (fbTotal ? ` (${fbSurvey} survey, ${fbTexted} texted, ${fbManual} manual)` : ''));
    if (chasing) lines.push(`Still chasing feedback on: ${chasing}`);
    lines.push(`Escalations: ${escNewWk} new, ${escResolvedWk} resolved${escOpen ? `, ${escOpen} STILL OPEN` : ', none open'}`);
    lines.push(`Listings: ${activeListings} active${newListings ? `, ${newListings} new this week` : ''}`);
    lines.push(``);
    const clean = !escOpen && !chasing;
    lines.push(clean ? `Clean week. The machine's got it.` : `Check the app for open items.`);

    const message = lines.join('\n');

    /* ----- send ----- */
    const sendRes = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GHL_KEY}`,
        Version: '2021-04-15',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'SMS',
        contactId: JOSH_CONTACT_ID,
        message,
        fromNumber: INTERNAL_FROM
      })
    });
    if (!sendRes.ok) throw new Error(`GHL send ${sendRes.status}: ${await sendRes.text()}`);

    console.log('weekly-digest sent:\n' + message);
    return { statusCode: 200, body: JSON.stringify({ ok: true, message }) };
  } catch (err) {
    console.error('weekly-digest error:', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

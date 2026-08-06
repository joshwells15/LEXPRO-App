// LEXPRO :: feedback-chase.js
// The feedback chase engine. Replaces the Make "Showing Chase SMS" scenario
// and GHL workflow 2A entirely.
//
// Runs on a schedule (every 30 min). For each showing row on the Showings tab:
//   - skip if survey already submitted (col M "Feedback Received" non-empty)
//   - skip if showing hasn't happened yet
//   - compute which chase stage is due and send agent + seller texts
//   - stamp col Q ("Feedback Chase SMS") ONLY after confirmed sends:
//       "1|2026-08-01T15:04:05Z" -> stage 1 sent at that time
//   - final stage alerts Tanya, stamps "done"
//
// Cadence (all sends only between 8:00-19:00 America/Chicago):
//   Stage 1: 1 hour after showing end
//   Stage 2: 2 hours after stage 1
//   Stage 3: 8 hours after stage 2
//   Stage 4: 24 hours after stage 3
//   Stage 5 (Tanya): 1 hour after stage 4
//
// Sheet: LEXPRO Listings, tab "Showings"
// Columns (A=1): A First B Last C Address D GHL Contact ID E Email F Phone
//   G Agent Name H Agent Phone I Agent Email J Intake Source K Showing Date
//   L Showing Time M Feedback Received N Feedback Content O Survey Submitted At
//   P Showing Confirmed SMS Q Feedback Chase SMS R Included In Weekly S Week Of
//
// ENV: GOOGLE_SERVICE_ACCOUNT_JSON, GHL_API_KEY, GHL_LOCATION_ID
// Schedule: netlify.toml -> [functions."feedback-chase"] schedule = "*/30 * * * *"

const crypto = require('crypto');

const SHEET_ID = '1KlfQEU02BcEM9RUTTi64-Eu60UzuaptT_EjE6OAXKOY';
const TAB = 'Showings';
const GHL_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION = process.env.GHL_LOCATION_ID;
const TZ = 'America/Chicago';

const AGENT_FROM = '+14173742998';   // public number - agents text this
const INTERNAL_FROM = '+14176474633'; // internal - Tanya alerts
const TANYA_CONTACT_ID = 'k4M3JrFVdMTwhKtIaQx6';
const SURVEY_BASE = 'https://lexprorealestate.com/showing-survey';

const LAUNCH_DATE = '2026-07-31'; // only chase showings on/after this date
const QUIET_START = 19; // no sends at/after 7 PM
const QUIET_END = 8;    // no sends before 8 AM

// stage delays in hours (from previous event)
const STAGES = [
  { n: 1, afterHours: 1 },   // after showing end
  { n: 2, afterHours: 2 },   // after stage 1
  { n: 3, afterHours: 8 },   // after stage 2
  { n: 4, afterHours: 24 },  // after stage 3
  { n: 5, afterHours: 1 }    // Tanya alert, after stage 4
];

/* ---------------- Google auth + sheets ---------------- */

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

async function readShowings(token) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}!A2:S1000`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`sheets read ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.values || [];
}

async function stampChase(token, rowNumber, value) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}!Q${rowNumber}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[value]] })
    }
  );
  if (!res.ok) throw new Error(`sheets stamp ${res.status}: ${await res.text()}`);
}

/* ---------------- GHL ---------------- */

async function ghl(path, { method = 'GET', body, version = '2021-07-28' } = {}) {
  const res = await fetch(`https://services.leadconnectorhq.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GHL_KEY}`,
      Version: version,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL ${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function findContactIdByPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  const e164 = digits.length === 10 ? `+1${digits}` :
    digits.length === 11 && digits.startsWith('1') ? `+${digits}` : phone;
  try {
    const r = await ghl(`/contacts/?locationId=${GHL_LOCATION}&query=${encodeURIComponent(e164)}&limit=1`);
    return r?.contacts?.[0]?.id || null;
  } catch { return null; }
}

async function sendSms(contactId, message, fromNumber) {
  const r = await ghl('/conversations/messages', {
    method: 'POST',
    version: '2021-04-15',
    body: { type: 'SMS', contactId, message, fromNumber }
  });
  return !!(r && (r.messageId || r.msg || r.conversationId || r.id));
}

/* ---------------- time helpers ---------------- */

function tzNow() {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(new Date())) p[type] = value;
  return { h: parseInt(p.hour), mi: parseInt(p.minute) };
}

function inQuietHours() {
  const { h } = tzNow();
  return h >= QUIET_START || h < QUIET_END;
}

// "2026-08-01" + "17:30" -> Date (UTC) honoring America/Chicago offset
function showingEndUtc(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [y, mo, d] = String(dateStr).split('-').map(Number);
  const [h, mi] = String(timeStr).split(':').map(Number);
  if (!y || !mo || !d || isNaN(h)) return null;
  // find UTC offset for that local time (DST-safe two-pass)
  let guess = Date.UTC(y, mo - 1, d, h + 5, mi || 0); // CDT guess
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, hour: '2-digit' });
  const localHour = parseInt(dtf.formatToParts(new Date(guess)).find(p => p.type === 'hour').value);
  if (localHour !== h) guess += (h - localHour) * 3600000;
  return new Date(guess + 60 * 60000); // + 60 min showing duration
}

function parseStamp(q) {
  // "" | "done" | "skip" | "3|2026-08-01T15:04:05Z"
  const s = String(q || '').trim();
  if (!s) return { stage: 0, at: null };
  if (s.toLowerCase() === 'done' || s.toLowerCase() === 'skip') return { stage: 99, at: null };
  const m = s.match(/^(\d)\|(.+)$/);
  if (m) return { stage: parseInt(m[1]), at: new Date(m[2]) };
  // legacy value from the old Make scenario (timestamp or text) - treat as stage 1 done long ago
  return { stage: 1, at: new Date(0) };
}

/* ---------------- messages ---------------- */

function agentMsg(stage, agentFirst, address, surveyUrl) {
  const hi = agentFirst ? `Hi ${agentFirst}! ` : 'Hi! ';
  switch (stage) {
    case 1: return `${hi}Thanks for showing ${address} today. When you have a sec, we'd love your feedback - it takes about a minute: ${surveyUrl}`;
    case 2: return `${hi}Just circling back on ${address} - your feedback really helps our seller. Quick link: ${surveyUrl}`;
    case 3: return `${hi}One more nudge on ${address} - even a sentence helps. ${surveyUrl}`;
    case 4: return `${hi}Last one, promise! If you have any thoughts on ${address}, our seller would love to hear them: ${surveyUrl}`;
  }
}

function sellerMsg(stage, sellerFirst, address) {
  const hi = sellerFirst ? `Hi ${sellerFirst}! ` : 'Hi! ';
  switch (stage) {
    case 1: return `${hi}The showing at ${address} just wrapped up. We've reached out to the agent for feedback and will get it to you as soon as we hear back.`;
    case 2: return `${hi}Quick update - we've followed up with the agent again for feedback on ${address}. Still on it!`;
    case 3: return `${hi}We've reached out to the showing agent again on ${address}. Some agents take a bit - we'll keep at it.`;
    case 4: return `${hi}One final follow-up went to the agent on ${address}. If we hear anything, you'll be the first to know.`;
  }
}

/* ---------------- handler ---------------- */

exports.handler = async () => {
  const summary = { checked: 0, sent: [], skipped: 0, flagged: [] };
  try {
    if (inQuietHours()) {
      console.log('quiet hours - no sends this run');
      return { statusCode: 200, body: JSON.stringify({ ok: true, quiet: true }) };
    }

    const token = await getGoogleToken();
    const rows = await readShowings(token);
    const now = new Date();

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 2; // sheet row (header is 1)
      const r = rows[i];
      const [first, last, address, sellerContactId, , sellerPhone,
             agentName, agentPhone, , , showDate, showTime,
             feedbackReceived] = [
        r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12]
      ];
      const chaseRaw = r[16]; // col Q

      if (!address || !showDate) continue;
      if (String(showDate).trim() < LAUNCH_DATE) continue; // pre-launch rows: never chased
      summary.checked++;

      // survey already in -> nothing to chase
      if (feedbackReceived && String(feedbackReceived).trim()) continue;

      const { stage: lastStage, at: lastAt } = parseStamp(chaseRaw);
      if (lastStage >= 5 || lastStage === 99) continue;

      const endUtc = showingEndUtc(String(showDate).trim(), String(showTime || '12:00').trim());
      if (!endUtc || endUtc > now) continue; // hasn't happened yet

      const nextStage = lastStage + 1;
      const delayMs = STAGES[nextStage - 1].afterHours * 3600000;
      const anchor = lastStage === 0 ? endUtc : (lastAt || endUtc);
      if (now - anchor < delayMs) continue; // not due yet

      // ---- stage 5: Tanya alert ----
      if (nextStage === 5) {
        const okSend = await sendSms(TANYA_CONTACT_ID,
          `No feedback from ${agentName || 'the agent'} on ${address} after 4 attempts. ` +
          `Their number: ${agentPhone || 'not on file'}. Might be worth a personal touch.`,
          INTERNAL_FROM);
        if (okSend) {
          await stampChase(token, rowNumber, 'done');
          summary.sent.push(`row ${rowNumber}: tanya-alert`);
        }
        continue;
      }

      // ---- stages 1-4: agent chase + seller FYI ----
      const agentContactId = await findContactIdByPhone(agentPhone);
      if (!agentContactId) {
        // can't chase without a reachable agent - flag once, mark skip
        await sendSms(TANYA_CONTACT_ID,
          `Can't chase feedback on ${address} - no reachable contact for agent ` +
          `${agentName || '(no name)'} ${agentPhone || '(no phone)'}. Marked skipped.`,
          INTERNAL_FROM);
        await stampChase(token, rowNumber, 'skip');
        summary.flagged.push(`row ${rowNumber}: no agent contact`);
        continue;
      }

      const surveyUrl = sellerContactId
        ? `${SURVEY_BASE}?contact_id=${sellerContactId}`
        : SURVEY_BASE;
      const agentFirst = (agentName || '').split(' ')[0] || null;

      const agentOk = await sendSms(agentContactId,
        agentMsg(nextStage, agentFirst, address, surveyUrl), AGENT_FROM);
      if (!agentOk) { summary.flagged.push(`row ${rowNumber}: agent send failed`); continue; }

      // seller FYI - non-fatal if it fails (agent chase is the core)
      let sellerNote = 'no-seller';
      if (sellerContactId) {
        try {
          const ok2 = await sendSms(sellerContactId, sellerMsg(nextStage, first, address), AGENT_FROM);
          sellerNote = ok2 ? 'seller-ok' : 'seller-fail';
        } catch { sellerNote = 'seller-fail'; }
      }

      await stampChase(token, rowNumber, `${nextStage}|${now.toISOString()}`);
      summary.sent.push(`row ${rowNumber}: stage ${nextStage} (${sellerNote})`);
    }

    console.log('feedback-chase summary:', JSON.stringify(summary));
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...summary }) };
  } catch (err) {
    console.error('feedback-chase error:', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message, ...summary }) };
  }
};

// LEXPRO :: agent-intake.js
// First-contact intake for showing agents. Replaces the CloseBot intake node.
//
// Triggered by GHL workflow "3. Donna Router":
//   Trigger : Customer Replied (SMS)
//   Filter  : does NOT have tag "lexpro" AND does NOT have tag "showing-agent"
//   Actions : Add Tag "showing-agent", Webhook POST -> this function
//
// Also fired on follow-up intake messages via the same conversation:
// agent-reply stays the owner AFTER a request exists; this function owns the
// thread BEFORE one exists. (agent-reply returns "no request on file" and
// stays silent - the router re-fires here only for untagged contacts, so
// follow-ups reach us through the companion tweak: agent-reply forwards
// no-request messages here internally. See bottom.)
//
// Behavior:
//   - Claude extracts { name, address, date, time } from the message
//   - all four present -> call the availability core (check-availability logic
//     via HTTP to our own endpoint) and relay its reason_message
//   - missing fields -> ask ONE short question for exactly what's missing
//   - stores progress on the GHL contact custom fields (same ones Donna used)
//     so partial intake survives across messages
//
// A confirmation can ONLY come from the availability endpoint's
// reason_message - this function cannot fabricate one.
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY, GHL_API_KEY, GHL_LOCATION_ID,
//      ANTHROPIC_API_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GHL_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION = process.env.GHL_LOCATION_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const AGENT_FROM = '+14173742998';
const SELF_BASE = 'https://lexproteamapp.netlify.app/.netlify/functions';
const TZ = 'America/Chicago';

/* ---------------- Supabase session store ---------------- */

async function sbFetch(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: prefer || 'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function getSession(contactId) {
  try {
    const r = await sbFetch(`intake_sessions?contact_id=eq.${encodeURIComponent(contactId)}`);
    return (r && r[0]) || null;
  } catch (e) { console.error('getSession failed:', e.message); return null; }
}

async function saveSession(contactId, fields) {
  try {
    await sbFetch('intake_sessions?on_conflict=contact_id', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: { contact_id: contactId, ...fields, updated_at: new Date().toISOString() }
    });
  } catch (e) { console.error('saveSession failed:', e.message); }
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

async function sendSms(contactId, message) {
  if (!contactId) return null;
  try {
    return await ghl('/conversations/messages', {
      method: 'POST',
      version: '2021-04-15',
      body: { type: 'SMS', contactId, message, fromNumber: AGENT_FROM }
    });
  } catch (e) { console.error('sendSms failed:', e.message); return null; }
}

async function getContact(contactId) {
  try {
    const r = await ghl(`/contacts/${contactId}`);
    return r?.contact || null;
  } catch (e) { console.error('getContact failed:', e.message); return null; }
}

async function updateContactFields(contactId, fields) {
  // fields: { listing_address, showing_date, showing_time, showing_agent_name }
  try {
    const contact = await getContact(contactId);
    if (!contact) return;
    // map custom field keys -> ids from the contact's own customFields where possible
    // GHL v2 upsert by key:
    const customFields = Object.entries(fields)
      .filter(([, v]) => v)
      .map(([k, v]) => ({ key: `contact.${k}`, field_value: String(v) }));
    if (!customFields.length) return;
    await ghl(`/contacts/${contactId}`, {
      method: 'PUT',
      body: { customFields }
    });
  } catch (e) { console.error('updateContactFields failed:', e.message); }
}

function readField(contact, key) {
  const cf = contact?.customFields || contact?.customField || [];
  for (const f of cf) {
    const k = f.key || f.fieldKey || '';
    if (k === `contact.${key}` || k === key) return f.value || f.field_value || null;
  }
  return null;
}

async function fetchLatestInboundMessage(contactId) {
  try {
    const search = await ghl(
      `/conversations/search?locationId=${GHL_LOCATION}&contactId=${contactId}&limit=1`
    );
    const convoId = search?.conversations?.[0]?.id;
    if (!convoId) return null;
    const msgs = await ghl(`/conversations/${convoId}/messages?limit=20`);
    const list = msgs?.messages?.messages || msgs?.messages || [];
    const inbound = list.find(m => m.direction === 'inbound' && (m.body || m.message));
    return inbound ? (inbound.body || inbound.message) : null;
  } catch (e) { console.error('fetchLatestInbound failed:', e.message); return null; }
}

/* ---------------- Claude extraction ---------------- */

function todayStr() {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  return dtf.format(new Date()); // YYYY-MM-DD
}
function tomorrowStr() {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  return dtf.format(new Date(Date.now() + 86400000));
}

async function extractIntake(message, known) {
  const prompt =
`You extract showing-request details from a real estate agent's SMS.

CRITICAL DATE ANCHORS (America/Chicago):
- "today" = ${todayStr()}
- "tomorrow" = ${tomorrowStr()}
Resolve date words using ONLY these anchors. Times 1-7 with no am/pm mean PM.

Already known from earlier messages (may be empty):
${JSON.stringify(known)}

Agent's new message: "${message}"

Respond ONLY with JSON:
{
  "agent_name": "full name if stated, else null",
  "listing_address": "property address as written, else null",
  "showing_date": "YYYY-MM-DD resolved from words like today/tomorrow/Friday, else null",
  "showing_time": "HH:MM 24-hour, else null",
  "is_showing_request": true/false
}

Rules:
- Merge with known values: only overwrite a known value if the new message clearly changes it.
- "is_showing_request" false only if this message is clearly not about booking a showing at all.
- Never invent values.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text)
    .join('').replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

/* ---------------- handler ---------------- */

function ok(msg, extra = {}) {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, message: msg, ...extra }) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return ok('POST only');

  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch { body = Object.fromEntries(new URLSearchParams(event.body || '')); }

  const contactId = body.contact_id || body.contactId || body.id || null;
  const phone = body.phone || body.contact_phone || null;
  if (!contactId) return ok('no contact id');

  function unwrap(v) {
    if (!v) return '';
    if (typeof v === 'object') return v.body || v.message || v.text || '';
    const s = String(v).trim();
    if (s.startsWith('{')) { try { const o = JSON.parse(s); return o.body || o.message || o.text || ''; } catch {} }
    return s;
  }
  let message = unwrap(body.message || body.body || body.sms);
  if (!message) message = await fetchLatestInboundMessage(contactId);
  if (!message) return ok('no message');

  try {
    // pull any partial intake from the session store (Supabase - deterministic)
    const contact = await getContact(contactId);
    const session = await getSession(contactId) || {};
    const known = {
      agent_name: session.agent_name || null,
      listing_address: session.listing_address || null,
      showing_date: session.showing_date || null,
      showing_time: session.showing_time || null
    };

    const x = await extractIntake(message, known);
    // Deterministic date override - never trust the model with relative dates
    const msgLower = message.toLowerCase();
    if (/\b(today|tonight|this afternoon|this evening|this morning)\b/.test(msgLower)) {
      x.showing_date = todayStr();
    } else if (/\btomorrow\b/.test(msgLower)) {
      x.showing_date = tomorrowStr();
    }
    console.log(`intake extract: ${JSON.stringify(x)} | known: ${JSON.stringify(known)}`);

    const merged = {
      agent_name: x.agent_name || known.agent_name,
      listing_address: x.listing_address || known.listing_address,
      showing_date: x.showing_date || known.showing_date,
      showing_time: x.showing_time || known.showing_time
    };

    // persist progress (session store)
    await saveSession(contactId, {
      agent_name: merged.agent_name,
      listing_address: merged.listing_address,
      showing_date: merged.showing_date,
      showing_time: merged.showing_time
    });

    if (x.is_showing_request === false && !merged.listing_address) {
      await sendSms(contactId,
        `Hi! This is Donna with LexPro. Are you looking to set up a showing on one of our listings? ` +
        `Just send me the property address and a day/time that works.`);
      return ok('not a showing request - prompted');
    }

    // what's missing?
    const missing = [];
    if (!merged.listing_address) missing.push('the property address');
    if (!merged.showing_date && !merged.showing_time) missing.push('the day and time you want');
    else if (!merged.showing_date) missing.push('the day');
    else if (!merged.showing_time) missing.push('the time');
    if (!merged.agent_name) missing.push('your name');

    if (missing.length) {
      const asks = (parseInt(session.ask_count) || 0) + 1;
      await saveSession(contactId, { ask_count: asks });
      if (asks >= 2) {
        try {
          await ghl('/conversations/messages', {
            method: 'POST', version: '2021-04-15',
            body: { type: 'SMS', contactId: 'k4M3JrFVdMTwhKtIaQx6',
              message: `Donna may be struggling with a showing agent (${phone || 'unknown number'}). ` +
                       `Their last message: "${message}". Still missing: ${missing.join(', ')}. Worth a look.`,
              fromNumber: '+14176474633' }
          });
        } catch (e) { console.error('stuck-convo alert failed:', e.message); }
      }
      const ask = missing.length === 1 ? missing[0] : missing.slice(0, -1).join(', ') + ' and ' + missing[missing.length - 1];
      await sendSms(contactId,
        `Hi${merged.agent_name ? ' ' + merged.agent_name.split(' ')[0] : ''}! Happy to get that set up - I just need ${ask}.`);
      return ok('asked for missing fields', { missing, asks });
    }

    await saveSession(contactId, { ask_count: 0 });

    // all four present -> hit the availability engine (single source of truth)
    const availRes = await fetch(`${SELF_BASE}/check-availability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        listing_address: merged.listing_address,
        showing_date: merged.showing_date,
        showing_time: merged.showing_time,
        showing_agent_name: merged.agent_name,
        showing_agent_phone: phone || contact?.phone || '',
        workflow: 'AgentIntake',
        timezone: TZ
      })
    });
    const avail = await availRes.json();
    console.log(`availability: status=${avail.status} hold=${avail.hold_id}`);

    // Double listing_unclear -> escalate to Tanya instead of looping
    if (avail.status === 'listing_unclear') {
      const n = (parseInt(session.unclear_count) || 0) + 1;
      await saveSession(contactId, { unclear_count: n });
      // a bad address should not survive as "known" - clear it so the next
      // message re-extracts fresh instead of looping on the failed one
      await saveSession(contactId, { listing_address: null });
      if (n >= 2) {
        await saveSession(contactId, { unclear_count: 0 });
        await sendSms(contactId,
          `I'm having trouble matching that property on my end - let me have someone from our team reach out to help you directly.`);
        try {
          await ghl('/conversations/messages', {
            method: 'POST', version: '2021-04-15',
            body: { type: 'SMS', contactId: 'k4M3JrFVdMTwhKtIaQx6',
              message: `Agent can't be matched to a listing. They said: "${message}" ` +
                       `(from ${phone || 'unknown number'}). Can you reach out?`,
              fromNumber: '+14176474633' }
          });
        } catch (e) { console.error('unclear escalation failed:', e.message); }
        return ok('double unclear - escalated');
      }
    } else {
      // successful match resets the counter and closes the session
      await saveSession(contactId, { unclear_count: 0 });
    }

    // relay ONLY what the engine said - this function cannot compose confirmations
    let reply = avail.reason_message || `Let me check on that and get right back to you.`;
    if (Array.isArray(avail.top_3_alternates) && avail.top_3_alternates.length) {
      reply += ` Available instead: ${avail.top_3_alternates.join(', ')}.`;
    }
    await sendSms(contactId, reply);

    return ok('intake complete', { status: avail.status });

  } catch (err) {
    console.error('agent-intake error:', err);
    await sendSms(contactId,
      `Thanks for reaching out! Give me just a few minutes and I'll get back to you on that.`);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

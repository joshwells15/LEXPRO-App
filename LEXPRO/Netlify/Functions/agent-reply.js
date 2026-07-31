// LEXPRO :: agent-reply.js
// Handles the showing agent's replies AFTER intake - counter-offer responses,
// status checks, new time proposals, and walk-aways. Replaces the CloseBot
// counter branch, which cannot execute over live SMS.
//
// Triggered by a GHL workflow:
//   Trigger : Customer Replied (SMS)
//   Filter  : has tag "showing-agent" AND does NOT have tag "start-donna-active"
//             (see workflow notes - only fires when Donna's intake is done)
//   Action  : Webhook (POST) -> this function
//
// The function only acts when the agent has a request in a decided or pending
// state. If the agent has no request at all, it stays silent so Donna's intake
// can do its job.
//
// ENV REQUIRED:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   GHL_API_KEY, GHL_LOCATION_ID
//   ANTHROPIC_API_KEY
// ENV OPTIONAL:
//   SHOWING_INTAKE_WEBHOOK

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GHL_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION = process.env.GHL_LOCATION_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const INTAKE_WEBHOOK = process.env.SHOWING_INTAKE_WEBHOOK || null;

const AGENT_FROM = '+14173742998';
const INTERNAL_FROM = '+14176474633';
// REHEARSAL: alerts -> Test Seller. SWAP TO TANYA k4M3JrFVdMTwhKtIaQx6 BEFORE 9AM DEMO.
const TANYA_CONTACT_ID = '80YL8ihM02I1wlcswzyr';
const AWAITING_TAG = 'awaiting-showing-approval';
const TZ = 'America/Chicago';
const HOLD_MINUTES = 120;

/* ------------------------------------------------------------------ */
/* Supabase + GHL plumbing (same as siblings)                          */
/* ------------------------------------------------------------------ */

async function sb(path, { method = 'GET', body, prefer } = {}) {
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

function e164(phone) {
  if (!phone) return null;
  const d = String(phone).replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return String(phone).startsWith('+') ? String(phone) : `+${d}`;
}

async function lastOutboundMessage(contactId) {
  try {
    const search = await ghl(
      `/conversations/search?locationId=${GHL_LOCATION}&contactId=${contactId}&limit=1`
    );
    const convoId = search?.conversations?.[0]?.id;
    if (!convoId) return null;
    const msgs = await ghl(`/conversations/${convoId}/messages?limit=10`);
    const list = msgs?.messages?.messages || msgs?.messages || [];
    const out = list.find(m => m.direction === 'outbound' && (m.body || m.message));
    return out ? (out.body || out.message) : null;
  } catch { return null; }
}

async function sendSms(contactId, message, fromNumber, dedupe = false) {
  if (!contactId) return null;
  if (dedupe) {
    const last = await lastOutboundMessage(contactId);
    if (last && last.trim() === message.trim()) {
      console.log('dedupe: suppressing identical repeat message');
      return null;
    }
  }
  try {
    return await ghl('/conversations/messages', {
      method: 'POST',
      version: '2021-04-15',
      body: { type: 'SMS', contactId, message, fromNumber }
    });
  } catch (e) {
    console.error('sendSms failed:', e.message);
    return null;
  }
}

async function addTag(contactId, tag) {
  try {
    await ghl(`/contacts/${contactId}/tags`, { method: 'POST', body: { tags: [tag] } });
  } catch (e) { console.error('addTag failed:', e.message); }
}


async function muteDonna(contactId) {
  try { await addTag(contactId, 'ai off'); } catch (e) { console.error('mute failed:', e.message); }
}

async function fetchLatestInboundMessage(contactId) {
  if (!contactId) return null;
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
  } catch (e) {
    console.error('fetchLatestInboundMessage failed:', e.message);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Time helpers (mirror check-availability)                            */
/* ------------------------------------------------------------------ */

function tzOffsetMs(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(new Date(utcMs))) p[type] = value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}

function wallToUtc(y, mo, d, h, mi, tz = TZ) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const o1 = tzOffsetMs(guess, tz);
  let ms = guess - o1;
  const o2 = tzOffsetMs(ms, tz);
  if (o2 !== o1) ms = guess - o2;
  return new Date(ms);
}

function tzParts(date, tz = TZ) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(date)) p[type] = value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}

function formatSlot(date) {
  const p = tzParts(date);
  const now = tzParts(new Date());
  const tmr = tzParts(new Date(Date.now() + 86400000));
  let dayLabel;
  if (p.y === now.y && p.mo === now.mo && p.d === now.d) dayLabel = 'today';
  else if (p.y === tmr.y && p.mo === tmr.mo && p.d === tmr.d) dayLabel = 'tomorrow';
  else dayLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'long', month: 'short', day: 'numeric'
  }).format(date);
  let h = p.h;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${dayLabel} at ${h}:${String(p.mi).padStart(2, '0')} ${ampm}`;
}

function timeStrToMinutes(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
}

function overlaps(aS, aE, bS, bE) { return aS < bE && bS < aE; }


async function expireStaleHolds() {
  const nowIso = new Date().toISOString();
  try {
    await sb(`showing_holds?status=eq.active&expires_at=lt.${nowIso}`, {
      method: 'PATCH', body: { status: 'expired' }, prefer: 'return=minimal'
    });
    await sb(`showing_requests?status=eq.pending_seller_approval&hold_expires_at=lt.${nowIso}`, {
      method: 'PATCH', body: { status: 'expired' }, prefer: 'return=minimal'
    });
  } catch (e) { console.error('expireStaleHolds failed (non-fatal):', e.message); }
}

async function getBusyBlocks(listingId, ignoreRequestId) {
  const holds = await sb(
    `showing_holds?listing_id=eq.${listingId}&status=eq.active&select=request_id,hold_start,hold_end`
  );
  const confirmed = await sb(
    `showing_requests?listing_id=eq.${listingId}&status=eq.confirmed&select=id,requested_start,requested_end`
  );
  const blocks = [];
  for (const h of holds) {
    if (ignoreRequestId && h.request_id === ignoreRequestId) continue;
    blocks.push({ start: new Date(h.hold_start).getTime(), end: new Date(h.hold_end).getTime() });
  }
  for (const c of confirmed) {
    if (ignoreRequestId && c.id === ignoreRequestId) continue;
    blocks.push({ start: new Date(c.requested_start).getTime(), end: new Date(c.requested_end).getTime() });
  }
  return blocks;
}

/* ------------------------------------------------------------------ */
/* Claude classification                                               */
/* ------------------------------------------------------------------ */

async function classifyAgentReply(message, context) {
  const now = tzParts(new Date());
  const prompt =
`You are handling SMS replies from a real estate showing agent negotiating a showing time.

Context: ${context}
Today's date: ${now.y}-${String(now.mo).padStart(2,'0')}-${String(now.d).padStart(2,'0')} (America/Chicago)

The agent's reply: "${message}"

Respond with ONLY a JSON object, no markdown:
{
  "intent": "accept_time" | "propose_time" | "status_check" | "property_question" | "will_respond_later" | "walking_away" | "acknowledge" | "unclear",
  "date": "YYYY-MM-DD or null",
  "time": "HH:MM in 24h or null",
  "note": "one short sentence"
}

Rules:
- accept_time: they agree to a specific time that was offered to them. Extract that date and time.
- propose_time: the offered time doesn't work but they name a different one. Extract it.
- If they name a day without a specific clock time (like "Saturday morning"), set time to null.
- status_check: only asking for an update ("any word?", "did you hear back?").
- property_question: asking about the property itself (beds, baths, sqft, acreage, year, garage, basement, HOA, etc.), not about scheduling.
- walking_away: done entirely ("thanks anyway", "we'll pass", "never mind").
- acknowledge: polite close after a confirmation ("great, thanks", "sounds good").
- will_respond_later: they need time and will get back to us ("let me check", "checking with my clients", "give me a minute", "I'll get back to you"). Do NOT treat these as unclear.
- unclear: anything else.
- Times without am/pm between 1-7 mean PM for showings.`;

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

/* ------------------------------------------------------------------ */
/* Seller re-ask + intake push (mirror siblings)                       */
/* ------------------------------------------------------------------ */

async function findContactIdByPhone(phone) {
  const p = e164(phone);
  if (!p) return null;
  try {
    const r = await ghl(
      `/contacts/search/duplicate?locationId=${GHL_LOCATION}&number=${encodeURIComponent(p)}`
    );
    return r?.contact?.id || null;
  } catch (e) {
    console.error('contact lookup failed:', e.message);
    return null;
  }
}

async function askSeller(listing, normalized, priorContext) {
  let contactId = listing.seller_contact_id;
  if (!contactId) contactId = await findContactIdByPhone(listing.seller_phone);
  if (!contactId) {
    console.error(`askSeller: no contact for listing ${listing.id} (id+phone both failed)`);
    return false;
  }

  const first = listing.seller_first_name || (listing.seller_name || '').split(' ')[0];
  const when = normalized.replace(/^(Today|Tomorrow)/, m => m.toLowerCase()).replace(' CT', '');

  // Compose a context-aware message; fall back to the template if Claude fails.
  let msg = null;
  if (priorContext) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 150,
          messages: [{ role: 'user', content:
`You are Donna, LexPro's friendly showing coordinator, texting a home seller${first ? ' named ' + first : ''}.

Context: ${priorContext}
The showing agent has now settled on: ${when}.

Write ONE short SMS (under 300 chars) asking the seller to confirm this time. Reference the earlier exchange naturally - do not reintroduce yourself or repeat the full pitch. End by asking them to reply yes to confirm or suggest another time. Output ONLY the message text.` }]
        })
      });
      if (res.ok) {
        const data = await res.json();
        const t = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
        if (t && t.length < 400) msg = t;
      }
    } catch (e) { console.error('askSeller compose failed, using template:', e.message); }
  }

  if (!msg) {
    msg = `Hi${first ? ' ' + first : ''}, it's Donna with LexPro. Got a request for a showing ` +
      `${when}. Does that time work for you? Reply yes to confirm, or let us know a ` +
      `better time that would work.`;
  }

  const sent = await sendSms(contactId, msg, AGENT_FROM);
  if (sent) await addTag(contactId, AWAITING_TAG);
  return !!sent;
}

async function pushToIntake(request, listing) {
  if (!INTAKE_WEBHOOK || request.pushed_to_intake) return false;
  const p = tzParts(new Date(request.requested_start));
  const payload = {
    seller_first_name: listing.seller_first_name || '',
    seller_last_name: listing.seller_last_name || '',
    seller_address: listing.address_full,
    seller_phone: listing.seller_phone || '',
    seller_email: listing.seller_email || '',
    seller_contact_id: listing.seller_contact_id || '',
    agent_name: request.showing_agent_name || '',
    agent_phone: request.showing_agent_phone || '',
    agent_email: request.showing_agent_email || '',
    showing_date: `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`,
    showing_time: `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`,
    intake_source: 'Donna'
  };
  const res = await fetch(INTAKE_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`intake webhook ${res.status}`);
  await sb(`showing_requests?id=eq.${request.id}`, {
    method: 'PATCH', body: { pushed_to_intake: true }, prefer: 'return=minimal'
  });
  return true;
}

/* ------------------------------------------------------------------ */
/* Handler                                                             */
/* ------------------------------------------------------------------ */

function ok(msg, extra = {}) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, message: msg, ...extra })
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return ok('POST only');

  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch { body = Object.fromEntries(new URLSearchParams(event.body || '')); }

  const agentContactId = body.contact_id || body.contactId || body.id || null;
  const agentPhone = e164(body.phone || body.contact_phone || null);

  function unwrapMessage(v) {
    if (!v) return '';
    if (typeof v === 'object') return v.body || v.message || v.text || '';
    const s = String(v).trim();
    if (s.startsWith('{')) {
      try { const o = JSON.parse(s); return o.body || o.message || o.text || ''; }
      catch { /* fall through */ }
    }
    return s;
  }

  let message = unwrapMessage(body.message || body.body || body.sms || body.message_body);
  if (!message) message = await fetchLatestInboundMessage(agentContactId);
  if (!message) return ok('No message found');

  try {
    /* -------- find this agent's most recent request -------- */

    if (!agentPhone) return ok('No agent phone');

    const reqs = await sb(
      `showing_requests?showing_agent_phone=eq.${encodeURIComponent(agentPhone)}` +
      `&order=created_at.desc&limit=1&select=*`
    );
    // No request at all -> intake hasn't happened. Stay silent; Donna's turf.
    if (!reqs.length) return ok('No request on file - leaving to intake');

    await expireStaleHolds();

    const request = reqs[0];
    // Donna's intake is done the moment we're handling the thread - silence her from here on.
    if (agentContactId) await muteDonna(agentContactId);
    const listing = (await sb(`listings?id=eq.${request.listing_id}&select=*`))[0];
    if (!listing) return ok('Listing missing');

    // Freshly-pending requests where the seller hasn't answered yet:
    // agent messages here are usually chase-ups; still handle them.
    const slot = formatSlot(new Date(request.requested_start));
    const alts = Array.isArray(request.seller_alternate_times) ? request.seller_alternate_times : [];

    const context =
      `Property: ${listing.address_full}. Their original request: ${slot}, current status: ` +
      `${request.status}.` +
      (alts.length ? ` The seller offered these alternate times instead: ${alts.join(', ')}.` : '');

    let verdict;
    try {
      verdict = await classifyAgentReply(message, context);
    } catch (e) {
      console.error('classify failed:', e.message);
      verdict = { intent: 'unclear', date: null, time: null };
    }
    console.log(`verdict: ${JSON.stringify(verdict)} | request ${request.id} status=${request.status}`);

    const nowIso = new Date().toISOString();

    /* -------- acknowledge: friendly close, nothing to do -------- */

    if (verdict.intent === 'acknowledge') {
      return ok('Acknowledged - no action');
    }

    if (verdict.intent === 'will_respond_later') {
      return ok('Agent will respond later - staying quiet');
    }

    /* -------- status check -------- */

    if (verdict.intent === 'status_check') {
      if (request.status === 'confirmed') {
        await sendSms(agentContactId,
          `You're confirmed for ${listing.address_full} ${slot}. See you then!`, AGENT_FROM);
        return ok('Status: confirmed');
      }
      if (request.status === 'pending_seller_approval') {
        if (!request.escalated_at) {
          await sb(`showing_requests?id=eq.${request.id}`, {
            method: 'PATCH', body: { escalated_at: nowIso }, prefer: 'return=minimal'
          });
          await sendSms(TANYA_CONTACT_ID,
            `Showing agent is chasing us. ${listing.address_full}, requested ${slot} by ` +
            `${request.showing_agent_name || 'an agent'} (${agentPhone}). Seller hasn't ` +
            `replied. Can you nudge them?`, INTERNAL_FROM);
        }
        await sendSms(agentContactId,
          `Still waiting on the seller for ${listing.address_full} at ${slot}. I've flagged ` +
          `it with our coordinator and will text you the moment I hear back.`, AGENT_FROM);
        return ok('Status: pending, escalated');
      }
      await sendSms(agentContactId,
        `That request for ${slot} at ${listing.address_full} is no longer active. ` +
        `Want me to check another time?`, AGENT_FROM);
      return ok('Status: inactive');
    }


    /* -------- property question -------- */

    if (verdict.intent === 'property_question') {
      const facts = listing.property_facts || null;
      let answer = null;
      if (facts) {
        try {
          const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': ANTHROPIC_KEY,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-6',
              max_tokens: 200,
              messages: [{ role: 'user', content:
`You are Donna, a friendly showing coordinator. A showing agent asked about ${listing.address_full}:
"${message}"

Known facts (JSON): ${JSON.stringify(facts)}
${listing.showing_notes ? 'Showing notes: ' + listing.showing_notes : ''}

If the facts answer the question, reply with ONE short conversational SMS answering it. If the facts do NOT contain what they asked, reply with exactly: UNKNOWN
Output only the SMS text or UNKNOWN.` }]
            })
          });
          if (res.ok) {
            const data = await res.json();
            const t = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
            if (t && t !== 'UNKNOWN' && !t.startsWith('UNKNOWN')) answer = t;
          }
        } catch (e) { console.error('property answer failed:', e.message); }
      }

      if (answer) {
        await sendSms(agentContactId, answer, AGENT_FROM);
        return ok('Property question answered');
      }

      await sendSms(agentContactId,
        `Good question - let me check with the team on that and get right back to you.`, AGENT_FROM);
      await sendSms(TANYA_CONTACT_ID,
        `Showing agent ${request.showing_agent_name || ''} (${agentPhone}) asked about ` +
        `${listing.address_full}: "${message}" - we don't have that on file. Can you reply to them?`,
        INTERNAL_FROM);
      return ok('Property question escalated');
    }

    /* -------- walking away -------- */

    if (verdict.intent === 'walking_away') {
      if (request.status === 'pending_seller_approval' || request.status === 'seller_rejected') {
        await sb(`showing_requests?id=eq.${request.id}`, {
          method: 'PATCH', body: { status: 'cancelled' }, prefer: 'return=minimal'
        });
        await sb(`showing_holds?request_id=eq.${request.id}&status=eq.active`, {
          method: 'PATCH', body: { status: 'released' }, prefer: 'return=minimal'
        });
      }
      await sendSms(agentContactId,
        `No problem - thanks for reaching out about ${listing.address_full}. ` +
        `If anything changes, just text us.`, AGENT_FROM);
      await sendSms(TANYA_CONTACT_ID,
        `Showing agent ${request.showing_agent_name || ''} (${agentPhone}) walked away from ` +
        `${listing.address_full} after the seller couldn't do ${slot}. Might be worth a ` +
        `personal follow-up.`, INTERNAL_FROM);
      return ok('Walked away - cancelled and escalated');
    }

    /* -------- accept / propose a time -------- */

    if (verdict.intent === 'accept_time' || verdict.intent === 'propose_time') {
      if (!verdict.time) {
        await sendSms(agentContactId,
          `What specific time works best? I'll get it over to the seller right away.`, AGENT_FROM);
        return ok('Time missing - asked for specifics');
      }

      // Build the new slot
      const dateStr = verdict.date;
      const [hh, mm] = verdict.time.split(':').map(Number);
      let d;
      if (dateStr) {
        const [y, mo, dd] = dateStr.split('-').map(Number);
        d = { y, mo, d: dd };
      } else {
        // no date given - keep the original request's date
        const p = tzParts(new Date(request.requested_start));
        d = { y: p.y, mo: p.mo, d: p.d };
      }
      const startUtc = wallToUtc(d.y, d.mo, d.d, hh, mm);
      const endUtc = new Date(startUtc.getTime() + (listing.slot_minutes || 60) * 60000);
      const normalized = formatSlot(startUtc);
      const now = Date.now();

      if (startUtc.getTime() < now) {
        await sendSms(agentContactId,
          `${normalized} has already passed - what other time works?`, AGENT_FROM);
        return ok('Time in past');
      }

      // Listing rules
      const p = tzParts(startUtc);
      const startMin = p.h * 60 + p.mi;
      const endMin = startMin + (listing.slot_minutes || 60);
      if (startMin < timeStrToMinutes(listing.allowed_start) ||
          endMin > timeStrToMinutes(listing.allowed_end)) {
        await sendSms(agentContactId,
          `${normalized} is outside the showing hours for ${listing.address_full}. ` +
          `What other time could work?`, AGENT_FROM);
        return ok('Outside allowed hours');
      }

      // Conflicts
      const busy = await getBusyBlocks(listing.id, request.id);
      const s = startUtc.getTime(), e2 = endUtc.getTime();
      if (busy.some(b => overlaps(s, e2, b.start, b.end))) {
        await sendSms(agentContactId,
          `${normalized} just became unavailable at ${listing.address_full}. ` +
          `What other time could work?`, AGENT_FROM);
        return ok('Conflict');
      }

      // Update the existing request to the new slot and set pending again
      const holdExpires = new Date(now + HOLD_MINUTES * 60000).toISOString();
      const sellerOffered = alts.length > 0 && verdict.intent === 'accept_time';

      await sb(`showing_requests?id=eq.${request.id}`, {
        method: 'PATCH',
        body: {
          requested_start: startUtc.toISOString(),
          requested_end: endUtc.toISOString(),
          status: 'pending_seller_approval',
          hold_expires_at: holdExpires,
          seller_alternate_times: null,
          escalated_at: null
        },
        prefer: 'return=minimal'
      });

      // Fresh hold on the new slot
      await sb(`showing_holds?request_id=eq.${request.id}&status=eq.active`, {
        method: 'PATCH', body: { status: 'released' }, prefer: 'return=minimal'
      });
      try {
        await sb('showing_holds', {
          method: 'POST',
          body: [{
            listing_id: listing.id,
            request_id: request.id,
            hold_start: startUtc.toISOString(),
            hold_end: endUtc.toISOString(),
            expires_at: holdExpires,
            status: 'active'
          }]
        });
      } catch (raceErr) {
        await sendSms(agentContactId,
          `${normalized} was just taken by another request. What other time could work?`, AGENT_FROM);
        return ok('Race lost');
      }

      // Ask the seller to confirm the new time
      const priorCtx = request.seller_response
        ? `The seller earlier said: "${request.seller_response}"`
        : null;
      const sellerReached = await askSeller(listing, normalized, priorCtx);

      await sendSms(agentContactId,
        sellerReached
          ? `Got it - I've sent ${normalized} to the seller` +
            (sellerOffered ? ` to lock it in` : ` for approval`) +
            ` and will text you the moment they confirm.`
          : `Got it - I'm confirming ${normalized} with the seller and will follow up shortly.`,
        AGENT_FROM);

      if (!sellerReached) {
        await sb(`showing_requests?id=eq.${request.id}`, {
          method: 'PATCH', body: { escalated_at: nowIso }, prefer: 'return=minimal'
        });
        await sendSms(TANYA_CONTACT_ID,
          `Can't reach seller by text for ${listing.address_full}. Agent wants ${normalized} ` +
          `(${request.showing_agent_name || 'agent'}, ${agentPhone}). Slot held 2 hours - ` +
          `please contact the seller directly.`, INTERNAL_FROM);
      }

      return ok('New time pending seller approval', { slot: normalized });
    }

    /* -------- unclear -------- */

    await sendSms(agentContactId,
      `Just to make sure I've got it right - are you good with one of the offered times, ` +
      `or is there a different time that works better?`, AGENT_FROM, true);
    return ok('Unclear - asked for clarification');

  } catch (err) {
    console.error('agent-reply error:', err);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

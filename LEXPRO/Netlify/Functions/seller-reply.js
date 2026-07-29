// LEXPRO :: seller-reply.js
// Fires when a seller replies to a showing-approval text.
//
// Triggered by a GHL workflow:
//   Trigger  : Customer Replied (SMS)
//   Filter   : has tag "awaiting-showing-approval"
//   Action   : Webhook (POST) -> this function
//
// Expected body (form-encoded or JSON):
//   contact_id, message, phone
//
// What it does:
//   1. finds the seller's pending showing request
//   2. asks Claude to classify the reply (approve / reject+alternates / unclear)
//   3. approve  -> confirm request, convert hold, text the agent, push to Showing Intake
//      reject   -> store alternates, text the agent with the seller's options
//      unclear  -> escalate to Tanya, leave the request pending
//
// ENV REQUIRED:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   GHL_API_KEY, GHL_LOCATION_ID
//   ANTHROPIC_API_KEY
// ENV OPTIONAL:
//   SHOWING_INTAKE_WEBHOOK  (Make webhook the Showings app form already posts to)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GHL_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION = process.env.GHL_LOCATION_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const INTAKE_WEBHOOK = process.env.SHOWING_INTAKE_WEBHOOK || null;

const AGENT_FROM = '+14173742998';    // Donna's number - keeps the thread together
const INTERNAL_FROM = '+14176474633'; // internal, Tanya/Lex
// TESTING: escalations -> Josh. Swap back to Tanya (k4M3JrFVdMTwhKtIaQx6) before go-live.
const TANYA_CONTACT_ID = 'txnhMCDRPWLUXXykNuE6';
const AWAITING_TAG = 'awaiting-showing-approval';
const TZ = 'America/Chicago';

/* ------------------------------------------------------------------ */
/* Supabase                                                            */
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

/* ------------------------------------------------------------------ */
/* GoHighLevel                                                         */
/* ------------------------------------------------------------------ */

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

async function sendSms(contactId, message, fromNumber) {
  if (!contactId) return null;
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

async function removeTag(contactId, tag) {
  try {
    await ghl(`/contacts/${contactId}/tags`, {
      method: 'DELETE',
      body: { tags: [tag] }
    });
  } catch (e) {
    console.error('removeTag failed:', e.message);
  }
}

// The free GHL webhook action may not include the message body, so fetch the
// most recent inbound SMS ourselves when it's missing.
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

    // direction "inbound" = from the seller
    const inbound = list.find(m => m.direction === 'inbound' && (m.body || m.message));
    return inbound ? (inbound.body || inbound.message) : null;
  } catch (e) {
    console.error('fetchLatestInboundMessage failed:', e.message);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Time formatting                                                     */
/* ------------------------------------------------------------------ */

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

// Split a UTC instant into the date/time strings the Showing Intake form sends.
// Format matches what the live system produces: 2026-07-27 / 18:45
function intakeDateTime(date) {
  const p = tzParts(date);
  return {
    date: `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`,
    time: `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`
  };
}

/* ------------------------------------------------------------------ */
/* Claude: classify the seller's reply                                 */
/* ------------------------------------------------------------------ */

async function classifyReply(message, requestedSlot, address) {
  const prompt =
`A home seller was asked to approve a showing at ${address} for ${requestedSlot}.

Their reply: "${message}"

Classify it. Respond with ONLY a JSON object, no markdown, no preamble:
{
  "decision": "approve" | "reject" | "unclear",
  "alternate_times": ["plain english times the seller offered instead"],
  "note": "one short sentence summarizing their reply"
}

Rules:
- "approve" if they agree to the requested time in any form (yes, sure, that works, sounds good, ok).
- "reject" if they cannot do that time. Put any times they suggest instead in alternate_times.
- "unclear" if you cannot tell, or they asked a question instead of answering.
- alternate_times is [] unless they actually named other times.`;

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
  const raw = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .replace(/```json|```/g, '')
    .trim();

  return JSON.parse(raw);
}

/* ------------------------------------------------------------------ */
/* Push a confirmed showing into the existing Showing Intake pipeline  */
/* ------------------------------------------------------------------ */

async function pushToIntake(request, listing) {
  if (!INTAKE_WEBHOOK) {
    console.log('SHOWING_INTAKE_WEBHOOK not set - skipping sheet/chase push');
    return false;
  }
  if (request.pushed_to_intake) {
    console.log(`Request ${request.id} already pushed - skipping`);
    return false;
  }

  const { date, time } = intakeDateTime(new Date(request.requested_start));

  // Field names must match the LEXPRO: Showing Intake webhook exactly (scenario 5312812)
  const payload = {
    seller_first_name: listing.seller_first_name || '',
    seller_last_name:  listing.seller_last_name  || '',
    seller_address:    listing.address_full,
    seller_phone:      listing.seller_phone      || '',
    seller_email:      listing.seller_email      || '',
    seller_contact_id: listing.seller_contact_id || '',
    agent_name:        request.showing_agent_name  || '',
    agent_phone:       request.showing_agent_phone || '',
    agent_email:       request.showing_agent_email || '',
    showing_date:      date,
    showing_time:      time,
    intake_source:     'Donna'
  };

  try {
    const res = await fetch(INTAKE_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`intake webhook ${res.status}`);

    await sb(`showing_requests?id=eq.${request.id}`, {
      method: 'PATCH',
      body: { pushed_to_intake: true },
      prefer: 'return=minimal'
    });
    return true;
  } catch (e) {
    console.error('pushToIntake failed:', e.message);
    return false;
  }
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

  // GHL may send JSON or form-encoded
  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    body = Object.fromEntries(new URLSearchParams(event.body || ''));
  }

  const sellerContactId = body.contact_id || body.contactId || body.id || null;
  const sellerPhone = body.phone || body.contact_phone || null;

  // GHL may send the message as a plain string, an object, or a JSON string
  // that looks like {"type":2,"body":"yes that works"} - unwrap all three.
  function unwrapMessage(v) {
    if (!v) return '';
    if (typeof v === 'object') return v.body || v.message || v.text || '';
    const s = String(v).trim();
    if (s.startsWith('{')) {
      try {
        const o = JSON.parse(s);
        return o.body || o.message || o.text || '';
      } catch { /* fall through */ }
    }
    return s;
  }

  let message = unwrapMessage(
    body.message || body.body || body.sms || body.message_body
  );

  // Free GHL webhook may omit the message body - go get it.
  if (!message) message = await fetchLatestInboundMessage(sellerContactId);

  if (!message) return ok('No message found for this contact - nothing to classify');

  try {
    /* -------- 1. find the seller's listing -------- */

    let listings = [];
    if (sellerContactId) {
      listings = await sb(
        `listings?seller_contact_id=eq.${encodeURIComponent(sellerContactId)}&select=*`
      );
    }
    if (!listings.length && sellerPhone) {
      listings = await sb(
        `listings?seller_phone=eq.${encodeURIComponent(e164(sellerPhone))}&select=*`
      );
    }
    if (!listings.length) return ok('No listing matched this seller');

    const listingIds = listings.map(l => `"${l.id}"`).join(',');

    /* -------- 2. find their pending request -------- */

    const pending = await sb(
      `showing_requests?listing_id=in.(${listingIds})` +
      `&status=eq.pending_seller_approval&order=created_at.desc&limit=1&select=*`
    );
    if (!pending.length) return ok('No pending request for this seller');

    const request = pending[0];
    const listing = listings.find(l => l.id === request.listing_id);
    const slot = formatSlot(new Date(request.requested_start));

    /* -------- 3. classify -------- */

    let verdict;
    try {
      verdict = await classifyReply(message, slot, listing.address_full);
    } catch (e) {
      console.error('classifyReply failed:', e.message);
      verdict = { decision: 'unclear', alternate_times: [], note: 'Could not read the reply.' };
    }

    const agentContactId = await findContactIdByPhone(request.showing_agent_phone);
    const nowIso = new Date().toISOString();

    /* -------- 4a. APPROVED -------- */

    if (verdict.decision === 'approve') {
      await sb(`showing_requests?id=eq.${request.id}`, {
        method: 'PATCH',
        body: {
          status: 'confirmed',
          seller_response: message,
          seller_responded_at: nowIso,
          confirmed_at: nowIso
        },
        prefer: 'return=minimal'
      });

      await sb(`showing_holds?request_id=eq.${request.id}&status=eq.active`, {
        method: 'PATCH',
        body: { status: 'converted' },
        prefer: 'return=minimal'
      });

      const fresh = (await sb(`showing_requests?id=eq.${request.id}&select=*`))[0];
      await pushToIntake(fresh, listing);

      await sendSms(
        agentContactId,
        `Good news - the seller approved your showing at ${listing.address_full} ${slot}. ` +
        `You're all set. We'll reach out afterward for feedback.`,
        AGENT_FROM
      );

      if (sellerContactId) await removeTag(sellerContactId, AWAITING_TAG);
      return ok('Approved and confirmed', { request_id: request.id });
    }

    /* -------- 4b. REJECTED -------- */

    if (verdict.decision === 'reject') {
      const alts = Array.isArray(verdict.alternate_times) ? verdict.alternate_times : [];

      await sb(`showing_requests?id=eq.${request.id}`, {
        method: 'PATCH',
        body: {
          status: 'seller_rejected',
          seller_response: message,
          seller_alternate_times: alts,
          seller_responded_at: nowIso
        },
        prefer: 'return=minimal'
      });

      await sb(`showing_holds?request_id=eq.${request.id}&status=eq.active`, {
        method: 'PATCH',
        body: { status: 'released' },
        prefer: 'return=minimal'
      });

      const agentMsg = alts.length
        ? `The seller can't do ${slot} at ${listing.address_full}, but offered: ` +
          `${alts.join(', ')}. Do any of those work?`
        : `The seller can't do ${slot} at ${listing.address_full}. ` +
          `What other times would work for you?`;

      await sendSms(agentContactId, agentMsg, AGENT_FROM);

      if (sellerContactId) await removeTag(sellerContactId, AWAITING_TAG);
      return ok('Rejected, agent notified', { alternates: alts });
    }

    /* -------- 4c. UNCLEAR -> Tanya -------- */

    await sb(`showing_requests?id=eq.${request.id}`, {
      method: 'PATCH',
      body: { seller_response: message, escalated_at: nowIso },
      prefer: 'return=minimal'
    });

    await sendSms(
      TANYA_CONTACT_ID,
      `Seller reply needs a human. ${listing.address_full}, showing requested ${slot} ` +
      `by ${request.showing_agent_name || 'an agent'}. Seller said: "${message}"`,
      INTERNAL_FROM
    );

    return ok('Unclear - escalated to Tanya');

  } catch (err) {
    console.error('seller-reply error:', err);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};

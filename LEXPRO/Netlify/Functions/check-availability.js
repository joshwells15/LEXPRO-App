// LEXPRO :: check-availability.js
// Donna's availability endpoint. Matches a listing from free-text address,
// validates the requested slot against that listing's showing rules,
// places a hold if open, and returns the JSON contract CloseBot expects.
//
// Handles all three request types from Donna:
//   (none)             -> first availability check
//   alternate_recheck  -> agent picked one of the top-3 we offered
//   counter_response   -> agent accepted/rejected a seller counter-offer
//
// ENV REQUIRED:
//   SUPABASE_URL          e.g. https://dqiiekdfmocvizzvmwlc.supabase.co
//   SUPABASE_SERVICE_KEY  service_role key (NOT the anon key)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GHL_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION = process.env.GHL_LOCATION_ID;

const SELLER_FROM = '+14173742998';   // seller-facing number
const INTERNAL_FROM = '+14176474633'; // internal, Tanya/Lex
const TANYA_CONTACT_ID = 'k4M3JrFVdMTwhKtIaQx6';
const AWAITING_TAG = 'awaiting-showing-approval';

const TZ = 'America/Chicago';
const HOLD_MINUTES = 120;   // matches the Tanya escalation window
const MAX_ALTERNATES = 3;
const ALTERNATE_DAYS_AHEAD = 3;

/* ------------------------------------------------------------------ */
/* Supabase REST helper                                                */
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
  if (!res.ok) {
    throw new Error(`Supabase ${method} ${path} -> ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

/* ------------------------------------------------------------------ */
/* GoHighLevel helpers                                                 */
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

// Find (or create) a GHL contact id from a phone number.
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
  return ghl('/conversations/messages', {
    method: 'POST',
    version: '2021-04-15',
    body: { type: 'SMS', contactId, message, fromNumber }
  });
}

async function addTag(contactId, tag) {
  return ghl(`/contacts/${contactId}/tags`, {
    method: 'POST',
    body: { tags: [tag] }
  });
}

// Text the seller and flag them so their reply routes to seller-reply.js.
// Never allowed to break the agent-facing response — logs and moves on.
async function notifySeller(listing, request, normalized, agentName) {
  try {
    let contactId = listing.seller_contact_id;
    if (!contactId) contactId = await findContactIdByPhone(listing.seller_phone);
    if (!contactId) {
      console.error(`No seller contact for listing ${listing.id}`);
      return false;
    }

    // If this seller has more than one active listing, name the property so
    // "a showing tomorrow at 2" can't be ambiguous. Otherwise leave it out.
    let propertyBit = '';
    try {
      const phone = encodeURIComponent(listing.seller_phone || '');
      const cid = encodeURIComponent(listing.seller_contact_id || '');
      const or = `or=(seller_phone.eq.${phone},seller_contact_id.eq.${cid})`;
      const siblings = await sb(`listings?${or}&status=eq.active&select=id`);
      if (siblings.length > 1) {
        const street = listing.address_full.split(',')[0].trim();
        propertyBit = ` at ${street}`;
      }
    } catch (e) {
      console.error('sibling listing check failed (non-fatal):', e.message);
    }

    const first = listing.seller_first_name || (listing.seller_name || '').split(' ')[0];
    const when = normalized
      .replace(/^(Today|Tomorrow)/, m => m.toLowerCase())
      .replace(' CT', '');

    const msg =
      `Hi${first ? ' ' + first : ''}, it's Donna with LexPro. Got a request for a showing` +
      `${propertyBit} ${when}. Does that time work for you? Reply yes to confirm, or ` +
      `let us know a better time that would work.`;

    await sendSms(contactId, msg, SELLER_FROM);
    await addTag(contactId, AWAITING_TAG);

    await sb(`showing_requests?id=eq.${request.id}`, {
      method: 'PATCH',
      body: { seller_notified_at: new Date().toISOString() },
      prefer: 'return=minimal'
    });
    return true;
  } catch (e) {
    console.error('notifySeller failed:', e.message);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Timezone math (no dependencies)                                     */
/* ------------------------------------------------------------------ */

function tzOffsetMs(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(new Date(utcMs))) p[type] = value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - utcMs;
}

// Turn a wall-clock time in `tz` into a real UTC Date. DST-correct.
function wallToUtc(y, mo, d, h, mi, tz = TZ) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const o1 = tzOffsetMs(guess, tz);
  let ms = guess - o1;
  const o2 = tzOffsetMs(ms, tz);
  if (o2 !== o1) ms = guess - o2;
  return new Date(ms);
}

// Wall-clock parts of a UTC instant, as seen in `tz`.
function tzParts(date, tz = TZ) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short'
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(date)) p[type] = value;
  return {
    y: +p.year, mo: +p.month, d: +p.day,
    h: +p.hour, mi: +p.minute, weekday: p.weekday
  };
}

function todayInTz(tz = TZ) {
  const p = tzParts(new Date(), tz);
  return { y: p.y, mo: p.mo, d: p.d };
}

/* ------------------------------------------------------------------ */
/* Address normalization                                               */
/* ------------------------------------------------------------------ */

const DIRECTIONALS = new Set([
  'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw',
  'north', 'south', 'east', 'west',
  'northeast', 'northwest', 'southeast', 'southwest'
]);

const SUFFIXES = new Set([
  'st', 'street', 'ave', 'avenue', 'rd', 'road', 'dr', 'drive',
  'ln', 'lane', 'ct', 'court', 'cir', 'circle', 'blvd', 'boulevard',
  'pl', 'place', 'ter', 'terrace', 'way', 'trl', 'trail', 'pkwy',
  'parkway', 'hwy', 'highway', 'loop', 'run', 'path', 'row', 'sq'
]);

// "1232 sicily ct repmo"          -> { houseNumber: '1232', streetToken: 'sicily' }
// "1232 S Sicily Ct, Republic MO" -> { houseNumber: '1232', streetToken: 'sicily' }
// "3502 N. Bob White Dr in Ozark" -> { houseNumber: '3502', streetToken: 'bob' }
function normalizeAddress(raw) {
  if (!raw) return null;

  const cleaned = String(raw)
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = cleaned.split(' ').filter(Boolean);
  if (!tokens.length) return null;

  // house number = first token that is (or starts with) digits
  let idx = tokens.findIndex(t => /^\d+[a-z]?$/.test(t));
  if (idx === -1) return null;

  const houseNumber = tokens[idx].replace(/[a-z]/g, '');

  // first meaningful street word after the number
  let streetToken = null;
  for (let i = idx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (DIRECTIONALS.has(t)) continue;
    if (SUFFIXES.has(t)) continue;
    if (t === 'in' || t === 'at' || t === 'on') continue;
    if (/^\d+$/.test(t)) continue;
    streetToken = t;
    break;
  }

  if (!streetToken) return null;
  return { houseNumber, streetToken, key: `${houseNumber}|${streetToken}` };
}

/* ------------------------------------------------------------------ */
/* Date + time parsing from natural language                           */
/* ------------------------------------------------------------------ */

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};

const WEEKDAYS = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6
};

function addDays({ y, mo, d }, n) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function dayOfWeek({ y, mo, d }) {
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase().trim();
  const today = todayInTz();

  if (/\b(today|tonight|this afternoon|this evening|asap|now)\b/.test(s)) return today;
  if (/\btomorrow\b/.test(s)) return addDays(today, 1);

  // ISO: 2026-07-29
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3] };

  // 7/29 or 07/29/2026
  m = s.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (m) {
    let y = m[3] ? +m[3] : today.y;
    if (y < 100) y += 2000;
    return { y, mo: +m[1], d: +m[2] };
  }

  // "July 29" / "jul 29th"
  m = s.match(/\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (m && MONTHS[m[1]]) {
    const mo = MONTHS[m[1]];
    const d = +m[2];
    let y = today.y;
    // if that date already passed this year, assume next year
    if (mo < today.mo || (mo === today.mo && d < today.d)) y += 1;
    return { y, mo, d };
  }

  // weekday name -> next occurrence (today counts if "today" wasn't said)
  for (const [name, dow] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`\\b${name}\\b`).test(s)) {
      let cur = today;
      for (let i = 0; i < 8; i++) {
        if (dayOfWeek(cur) === dow && i > 0) return cur;
        if (dayOfWeek(cur) === dow && i === 0) return cur;
        cur = addDays(cur, 1);
      }
    }
  }

  return null;
}

function parseTime(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase().trim();

  // 5:30 pm / 17:00 / 5 pm / 5pm / 5
  let m = s.match(/(\d{1,2})\s*:\s*(\d{2})\s*(am|pm)?/);
  if (m) {
    let h = +m[1];
    const mi = +m[2];
    const ap = m[3];
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (!ap && h >= 1 && h <= 7) h += 12;   // "5:30" for a showing means PM
    return { h, mi };
  }

  m = s.match(/(\d{1,2})\s*(am|pm)/);
  if (m) {
    let h = +m[1];
    if (m[2] === 'pm' && h < 12) h += 12;
    if (m[2] === 'am' && h === 12) h = 0;
    return { h, mi: 0 };
  }

  m = s.match(/\b(\d{1,2})\b/);
  if (m) {
    let h = +m[1];
    if (h >= 1 && h <= 7) h += 12;          // bare 1-7 -> afternoon
    if (h > 23) return null;
    return { h, mi: 0 };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Formatting for the agent-facing reply                               */
/* ------------------------------------------------------------------ */

function formatSlot(dateUtc) {
  const p = tzParts(dateUtc);
  const today = todayInTz();
  const tomorrow = addDays(today, 1);

  let dayLabel;
  if (p.y === today.y && p.mo === today.mo && p.d === today.d) dayLabel = 'Today';
  else if (p.y === tomorrow.y && p.mo === tomorrow.mo && p.d === tomorrow.d) dayLabel = 'Tomorrow';
  else {
    dayLabel = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric'
    }).format(dateUtc);
  }

  let h = p.h;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const mm = String(p.mi).padStart(2, '0');
  return `${dayLabel} at ${h}:${mm} ${ampm} CT`;
}

/* ------------------------------------------------------------------ */
/* Core availability logic                                             */
/* ------------------------------------------------------------------ */

function timeStrToMinutes(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
}

function slotWithinRules(startUtc, listing) {
  const p = tzParts(startUtc);
  const startMin = p.h * 60 + p.mi;
  const endMin = startMin + listing.slot_minutes;
  const allowedStart = timeStrToMinutes(listing.allowed_start);
  const allowedEnd = timeStrToMinutes(listing.allowed_end);
  return startMin >= allowedStart && endMin <= allowedEnd;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

async function getBusyBlocks(listingId, ignoreHoldId, ignoreRequestId) {
  const holds = await sb(
    `showing_holds?listing_id=eq.${listingId}&status=eq.active&select=id,hold_start,hold_end`
  );
  const confirmed = await sb(
    `showing_requests?listing_id=eq.${listingId}&status=eq.confirmed&select=id,requested_start,requested_end`
  );

  const blocks = [];
  for (const h of holds) {
    if (ignoreHoldId && h.id === ignoreHoldId) continue;
    blocks.push({
      kind: 'hold',
      start: new Date(h.hold_start).getTime(),
      end: new Date(h.hold_end).getTime()
    });
  }
  for (const c of confirmed) {
    if (ignoreRequestId && c.id === ignoreRequestId) continue;
    blocks.push({
      kind: 'confirmed',
      start: new Date(c.requested_start).getTime(),
      end: new Date(c.requested_end).getTime()
    });
  }
  return blocks;
}

function findAlternates(listing, busy, afterUtc, notBefore) {
  const out = [];
  const startDay = tzParts(afterUtc);
  const allowedStart = timeStrToMinutes(listing.allowed_start);
  const allowedEnd = timeStrToMinutes(listing.allowed_end);
  const step = listing.slot_minutes;

  for (let dayOffset = 0; dayOffset <= ALTERNATE_DAYS_AHEAD && out.length < MAX_ALTERNATES; dayOffset++) {
    const day = addDays({ y: startDay.y, mo: startDay.mo, d: startDay.d }, dayOffset);

    for (let min = allowedStart; min + step <= allowedEnd; min += step) {
      if (out.length >= MAX_ALTERNATES) break;

      const h = Math.floor(min / 60);
      const mi = min % 60;
      const slotStart = wallToUtc(day.y, day.mo, day.d, h, mi);
      const s = slotStart.getTime();
      const e = s + step * 60000;

      if (s <= afterUtc.getTime()) continue;      // must be after the requested time
      if (s < notBefore) continue;                // respects notice_hours
      if (busy.some(b => overlaps(s, e, b.start, b.end))) continue;

      out.push(formatSlot(slotStart));
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Housekeeping: expire stale holds                                    */
/* ------------------------------------------------------------------ */

async function expireStaleHolds() {
  const nowIso = new Date().toISOString();
  try {
    await sb(`showing_holds?status=eq.active&expires_at=lt.${nowIso}`, {
      method: 'PATCH',
      body: { status: 'expired' },
      prefer: 'return=minimal'
    });
    await sb(`showing_requests?status=eq.pending_seller_approval&hold_expires_at=lt.${nowIso}`, {
      method: 'PATCH',
      body: { status: 'expired' },
      prefer: 'return=minimal'
    });
  } catch (e) {
    console.error('expireStaleHolds failed (non-fatal):', e.message);
  }
}

/* ------------------------------------------------------------------ */
/* Status check: the agent is chasing us for an answer                 */
/* ------------------------------------------------------------------ */

async function handleStatusCheck(requestId, agentPhone) {
  let rows = [];

  if (requestId) {
    rows = await sb(`showing_requests?id=eq.${encodeURIComponent(requestId)}&select=*`);
  }
  if (!rows.length && agentPhone) {
    rows = await sb(
      `showing_requests?showing_agent_phone=eq.${encodeURIComponent(agentPhone)}` +
      `&order=created_at.desc&limit=1&select=*`
    );
  }
  if (!rows.length) {
    return reply({
      status: 'pending',
      reason_message: "I don't have an open request on file for you right now. What property and time are you looking at?"
    });
  }

  const req = rows[0];
  const listing = (await sb(`listings?id=eq.${req.listing_id}&select=*`))[0];
  const slot = formatSlot(new Date(req.requested_start));
  const address = listing ? listing.address_full : 'that property';

  if (req.status === 'confirmed') {
    return reply({
      status: 'open',
      matched_listing_address: address,
      requested_time_normalized: slot,
      request_id: req.id,
      reason_message: `Good news - the seller approved ${address} for ${slot}. You're confirmed.`
    });
  }

  if (req.status === 'seller_rejected') {
    const alts = Array.isArray(req.seller_alternate_times) ? req.seller_alternate_times : [];
    return reply({
      status: 'unavailable',
      matched_listing_address: address,
      requested_time_normalized: slot,
      request_id: req.id,
      reason_message: alts.length
        ? `The seller couldn't do ${slot}, but offered other times.`
        : `The seller couldn't do ${slot}. What other times would work for you?`,
      top_3_alternates: alts.slice(0, 3)
    });
  }

  if (req.status === 'expired' || req.status === 'cancelled') {
    return reply({
      status: 'unavailable',
      matched_listing_address: address,
      requested_time_normalized: slot,
      reason_message: `That request for ${slot} is no longer active. Want me to check another time?`
    });
  }

  // Still pending. The agent chasing us is the signal that the seller is slow -
  // escalate to Tanya once, then keep the agent informed.
  if (!req.escalated_at) {
    try {
      await sb(`showing_requests?id=eq.${req.id}`, {
        method: 'PATCH',
        body: { escalated_at: new Date().toISOString() },
        prefer: 'return=minimal'
      });
      await sendSms(
        TANYA_CONTACT_ID,
        `Showing agent is chasing us. ${address}, requested ${slot} by ` +
        `${req.showing_agent_name || 'an agent'} (${req.showing_agent_phone || 'no phone'}). ` +
        `Seller hasn't replied. Can you nudge them?`,
        INTERNAL_FROM
      );
    } catch (e) {
      console.error('status_check escalation failed:', e.message);
    }
  }

  return reply({
    status: 'pending',
    matched_listing_address: address,
    requested_time_normalized: slot,
    request_id: req.id,
    hold_id: null,
    reason_message: `Still waiting on the seller for ${address} at ${slot}. ` +
      `I've flagged it with our coordinator to follow up, and I'll text you the moment I hear back.`
  });
}

/* ------------------------------------------------------------------ */
/* Response shape                                                      */
/* ------------------------------------------------------------------ */

function reply(payload) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'unavailable',
      reason_message: '',
      requested_time_normalized: null,
      matched_listing_address: null,
      hold_id: null,
      request_id: null,
      top_3_alternates: [],
      ...payload
    })
  };
}

/* ------------------------------------------------------------------ */
/* Handler                                                             */
/* ------------------------------------------------------------------ */

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return reply({ status: 'listing_unclear', reason_message: 'POST only.' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
    return reply({
      status: 'listing_unclear',
      reason_message: "I'm having a technical problem on my end. Someone from our team will follow up shortly."
    });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return reply({ status: 'listing_unclear', reason_message: 'Bad request body.' });
  }

  const {
    listing_address,
    showing_date,
    showing_time,
    showing_agent_name,
    showing_agent_phone,
    request_type
  } = body;

  // Donna may send the literal string "null" for empty contact fields
  const clean = v => (!v || v === 'null' || v === 'undefined' ? null : String(v).trim());
  const priorHoldId = clean(body.hold_id);
  const priorRequestId = clean(body.request_id);

  try {
    await expireStaleHolds();

    /* -------- 0. status check: "any word yet?" -------- */

    if (request_type === 'status_check') {
      return await handleStatusCheck(priorRequestId, clean(showing_agent_phone));
    }

    /* -------- 1. match the listing -------- */

    const norm = normalizeAddress(listing_address);
    if (!norm) {
      return reply({
        status: 'listing_unclear',
        reason_message: "I couldn't make out the property address. What's the full address?"
      });
    }

    let listings = await sb(
      `listings?address_key=eq.${encodeURIComponent(norm.key)}&status=eq.active&select=*`
    );

    // fallback: house number alone (agent may have used a nickname for the street)
    if (!listings.length) {
      listings = await sb(
        `listings?house_number=eq.${encodeURIComponent(norm.houseNumber)}&status=eq.active&select=*`
      );
    }

    if (!listings.length) {
      return reply({
        status: 'listing_unclear',
        reason_message: "I couldn't find that property in our listings. Can you send the full address?"
      });
    }
    if (listings.length > 1) {
      return reply({
        status: 'listing_unclear',
        reason_message: 'I found more than one property that could match. Can you send the full address including the street name and city?'
      });
    }

    const listing = listings[0];

    /* -------- 2. parse the requested slot -------- */

    const d = parseDate(showing_date);
    const t = parseTime(showing_time);

    if (!d || !t) {
      return reply({
        status: 'listing_unclear',
        matched_listing_address: listing.address_full,
        reason_message: "I've got the property, but I need the day and time. What day and time works?"
      });
    }

    const startUtc = wallToUtc(d.y, d.mo, d.d, t.h, t.mi);
    const endUtc = new Date(startUtc.getTime() + listing.slot_minutes * 60000);
    const normalized = formatSlot(startUtc);
    const now = Date.now();
    const notBefore = now + listing.notice_hours * 3600000;

    /* -------- 3. release the agent's own prior hold on a re-check -------- */

    if ((request_type === 'alternate_recheck' || request_type === 'counter_response') && priorHoldId) {
      try {
        await sb(`showing_holds?id=eq.${priorHoldId}`, {
          method: 'PATCH',
          body: { status: 'released' },
          prefer: 'return=minimal'
        });
      } catch (e) {
        console.error('Could not release prior hold:', e.message);
      }
    }

    /* -------- 4. validate against the listing's rules -------- */

    const busy = await getBusyBlocks(listing.id, priorHoldId, priorRequestId);

    if (startUtc.getTime() < now) {
      const alts = findAlternates(listing, busy, new Date(now), notBefore);
      return reply({
        status: 'unavailable',
        matched_listing_address: listing.address_full,
        requested_time_normalized: normalized,
        reason_message: 'That time has already passed.',
        top_3_alternates: alts
      });
    }

    if (startUtc.getTime() < notBefore) {
      const alts = findAlternates(listing, busy, new Date(notBefore), notBefore);
      return reply({
        status: 'unavailable',
        matched_listing_address: listing.address_full,
        requested_time_normalized: normalized,
        reason_message: `This listing needs ${listing.notice_hours} hours notice for showings.`,
        top_3_alternates: alts
      });
    }

    if (!slotWithinRules(startUtc, listing)) {
      const alts = findAlternates(listing, busy, startUtc, notBefore);
      return reply({
        status: 'unavailable',
        matched_listing_address: listing.address_full,
        requested_time_normalized: normalized,
        reason_message: 'That time is outside the showing hours for this property.',
        top_3_alternates: alts
      });
    }

    /* -------- 5. conflict check -------- */

    const s = startUtc.getTime();
    const e = endUtc.getTime();
    const conflict = busy.find(b => overlaps(s, e, b.start, b.end));

    if (conflict) {
      const alts = findAlternates(listing, busy, startUtc, notBefore);
      const isPending = conflict.kind === 'hold';
      return reply({
        status: isPending ? 'pending' : 'unavailable',
        matched_listing_address: listing.address_full,
        requested_time_normalized: normalized,
        reason_message: isPending
          ? 'That time is currently pending seller approval for another request.'
          : 'There is already a showing scheduled at that time.',
        top_3_alternates: alts
      });
    }

    /* -------- 6. open: create the request + hold -------- */

    const holdExpires = new Date(now + HOLD_MINUTES * 60000).toISOString();

    const [request] = await sb('showing_requests', {
      method: 'POST',
      body: [{
        listing_id: listing.id,
        showing_agent_name: clean(showing_agent_name),
        showing_agent_phone: clean(showing_agent_phone),
        requested_start: startUtc.toISOString(),
        requested_end: endUtc.toISOString(),
        status: 'pending_seller_approval',
        hold_expires_at: holdExpires,
        source_bot: 'Donna'
      }]
    });

    let hold;
    try {
      [hold] = await sb('showing_holds', {
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
    } catch (err) {
      // The unique index caught a race: someone grabbed this slot mid-request.
      await sb(`showing_requests?id=eq.${request.id}`, {
        method: 'PATCH',
        body: { status: 'cancelled' },
        prefer: 'return=minimal'
      });
      const freshBusy = await getBusyBlocks(listing.id, null, null);
      const alts = findAlternates(listing, freshBusy, startUtc, notBefore);
      return reply({
        status: 'pending',
        matched_listing_address: listing.address_full,
        requested_time_normalized: normalized,
        reason_message: 'That time was just requested by another agent and is pending seller approval.',
        top_3_alternates: alts
      });
    }

    const sellerReached = await notifySeller(
      listing, request, normalized, clean(showing_agent_name)
    );

    return reply({
      status: 'open',
      matched_listing_address: listing.address_full,
      requested_time_normalized: normalized,
      reason_message: sellerReached
        ? `${listing.address_full} is open ${normalized}. I've sent it to the seller for approval and will let you know as soon as I hear back.`
        : `${listing.address_full} is open ${normalized}. I'm getting it confirmed and will follow up shortly.`,
      hold_id: hold.id,
      request_id: request.id,
      top_3_alternates: []
    });

  } catch (err) {
    console.error('check-availability error:', err);
    return reply({
      status: 'listing_unclear',
      reason_message: "I'm having trouble checking that right now. Someone from our team will follow up shortly."
    });
  }
};

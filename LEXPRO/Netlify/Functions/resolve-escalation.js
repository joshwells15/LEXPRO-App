// LEXPRO :: resolve-escalation.js
// The escalation cockpit's backend.
//   GET  -> open escalations (newest first) + recent resolved
//   POST { id, action } where action:
//     'seller_yes'        -> full approval: confirm request, convert hold,
//                            text agent, push intake, stamp resolved
//     'seller_counter'    -> { time: "HH:MM", date: "YYYY-MM-DD" } relay to agent
//     'cancel_request'    -> cancel + release + notify agent
//     'handled'           -> clear intake escalation (Donna may speak again) + resolve
//     'dismiss'           -> mark dismissed
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY, GHL_API_KEY, GHL_LOCATION_ID

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GHL_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION = process.env.GHL_LOCATION_ID;
const AGENT_FROM = '+14173742998';
const TZ = 'America/Chicago';
const INTAKE_WEBHOOK = process.env.SHOWING_INTAKE_WEBHOOK;

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
      Authorization: `Bearer ${GHL_KEY}`, Version: version,
      'Content-Type': 'application/json', Accept: 'application/json'
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

async function sendSms(contactId, message) {
  if (!contactId) return false;
  try {
    const r = await ghl('/conversations/messages', {
      method: 'POST', version: '2021-04-15',
      body: { type: 'SMS', contactId, message, fromNumber: AGENT_FROM }
    });
    return !!(r && (r.messageId || r.conversationId));
  } catch (e) { console.error('sendSms failed:', e.message); return false; }
}

function fmtSlot(iso) {
  const d = new Date(iso);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
  return dtf.format(d);
}

function resp(code, obj) {
  return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

async function markResolved(id, action) {
  await sb(`escalations?id=eq.${id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { status: action === 'dismiss' ? 'dismissed' : 'resolved',
            resolved_action: action, resolved_at: new Date().toISOString() }
  });
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'GET') {
      const open = await sb(`escalations?status=eq.open&select=*&order=created_at.desc&limit=50`);
      const recent = await sb(`escalations?status=neq.open&select=id,kind,summary,resolved_action,resolved_at&order=resolved_at.desc&limit=10`);
      return resp(200, { ok: true, open, recent });
    }

    if (event.httpMethod !== 'POST') return resp(405, { ok: false, error: 'GET or POST' });

    let b = {};
    try { b = JSON.parse(event.body || '{}'); } catch { }
    if (!b.id || !b.action) return resp(400, { ok: false, error: 'id and action required' });

    const [esc] = await sb(`escalations?id=eq.${encodeURIComponent(b.id)}&select=*`);
    if (!esc) return resp(404, { ok: false, error: 'escalation not found' });
    if (esc.status !== 'open') return resp(200, { ok: true, note: 'already handled' });

    /* ---- dismiss: universal ---- */
    if (b.action === 'dismiss') {
      await markResolved(esc.id, 'dismiss');
      return resp(200, { ok: true, action: 'dismissed' });
    }

    /* ---- handled: clears intake silence so Donna may speak again ---- */
    if (b.action === 'handled') {
      if (esc.intake_contact_id) {
        try {
          await sb(`intake_sessions?contact_id=eq.${encodeURIComponent(esc.intake_contact_id)}`, {
            method: 'PATCH', prefer: 'return=minimal',
            body: { escalated_at: null, unclear_count: 0, ask_count: 0 }
          });
        } catch (e) { console.error('session clear failed:', e.message); }
      }
      await markResolved(esc.id, 'handled');
      return resp(200, { ok: true, action: 'handled' });
    }

    /* ---- request-based actions need the request + listing ---- */
    const needReq = ['seller_yes', 'seller_counter', 'cancel_request'].includes(b.action);
    if (!needReq) return resp(400, { ok: false, error: `unknown action ${b.action}` });
    if (!esc.request_id) return resp(400, { ok: false, error: 'no request attached to this escalation' });

    const [request] = await sb(`showing_requests?id=eq.${esc.request_id}&select=*`);
    if (!request) return resp(404, { ok: false, error: 'request not found' });
    const [listing] = await sb(`listings?id=eq.${request.listing_id}&select=*`);
    const agentContactId = esc.agent_contact_id || await findContactIdByPhone(request.showing_agent_phone);
    const slot = fmtSlot(request.requested_start);

    if (b.action === 'seller_yes') {
      await sb(`showing_requests?id=eq.${request.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { status: 'confirmed', confirmed_at: new Date().toISOString(), escalated_at: null }
      });
      await sb(`showing_holds?request_id=eq.${request.id}&status=eq.active`, {
        method: 'PATCH', prefer: 'return=minimal', body: { status: 'converted' }
      });
      const notes = listing?.showing_notes ? ` A note from the seller side: ${listing.showing_notes}.` : '';
      await sendSms(agentContactId,
        `Good news - the seller approved your showing at ${listing?.address_full || 'the property'} ` +
        `${slot}. You're all set.${notes} We'll reach out afterward for feedback.`);
      // push to intake (sheet row) - same payload shape as seller-reply
      if (INTAKE_WEBHOOK && listing && !request.pushed_to_intake) {
        try {
          const st = new Date(request.requested_start);
          const dtfD = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
          const dtfT = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
          await fetch(INTAKE_WEBHOOK, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              seller_first_name: listing.seller_first_name || '',
              seller_last_name: listing.seller_last_name || '',
              seller_address: listing.address_full,
              seller_phone: listing.seller_phone || '',
              seller_email: listing.seller_email || '',
              seller_contact_id: listing.seller_contact_id || '',
              agent_name: request.showing_agent_name || '',
              agent_phone: request.showing_agent_phone || '',
              agent_email: '',
              showing_date: dtfD.format(st),
              showing_time: dtfT.format(st),
              intake_source: 'Donna'
            })
          });
          await sb(`showing_requests?id=eq.${request.id}`, {
            method: 'PATCH', prefer: 'return=minimal', body: { pushed_to_intake: true }
          });
        } catch (e) { console.error('intake push failed:', e.message); }
      }
      await markResolved(esc.id, 'seller_yes');
      return resp(200, { ok: true, action: 'confirmed' });
    }

    if (b.action === 'seller_counter') {
      const t = b.time, d = b.date;
      if (!/^\d{2}:\d{2}$/.test(t || '')) return resp(400, { ok: false, error: 'time HH:MM required' });
      const when = d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `on ${d} at ${t}` : `at ${t}`;
      await sb(`showing_requests?id=eq.${request.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { status: 'seller_rejected', seller_alternate_times: [`${when}`] }
      });
      await sb(`showing_holds?request_id=eq.${request.id}&status=eq.active`, {
        method: 'PATCH', prefer: 'return=minimal', body: { status: 'released' }
      });
      await sendSms(agentContactId,
        `The seller can't do ${slot} at ${listing?.address_full || 'the property'}, but offered ` +
        `${when}. Does that work?`);
      await markResolved(esc.id, 'seller_counter');
      return resp(200, { ok: true, action: 'countered' });
    }

    if (b.action === 'cancel_request') {
      await sb(`showing_requests?id=eq.${request.id}`, {
        method: 'PATCH', prefer: 'return=minimal', body: { status: 'cancelled' }
      });
      await sb(`showing_holds?request_id=eq.${request.id}&status=eq.active`, {
        method: 'PATCH', prefer: 'return=minimal', body: { status: 'released' }
      });
      await sendSms(agentContactId,
        `Unfortunately we weren't able to set up the showing at ` +
        `${listing?.address_full || 'the property'} for ${slot}. We're sorry about that - ` +
        `feel free to reach out about other times or listings.`);
      await markResolved(esc.id, 'cancel_request');
      return resp(200, { ok: true, action: 'cancelled' });
    }
  } catch (err) {
    console.error('resolve-escalation error:', err);
    return resp(500, { ok: false, error: err.message });
  }
};

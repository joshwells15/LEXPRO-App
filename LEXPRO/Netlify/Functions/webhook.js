const https = require('https');

const SUPABASE_URL = 'dqiiekdfmocvizzvmwlc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRxaWlla2RmbW9jdml6enZtd2xjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MjcwOTcsImV4cCI6MjA5MTMwMzA5N30.Njm_nwlOJiHaapqeqj1ZhInkFUHiAqoglB5LuVauCwM';
const GHL_API_KEY = 'pit-4e98487c-3f65-409c-a264-16352f97c01a';
const GHL_LOCATION_ID = 'R5PobkV1CRO23kz95yYB';

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path, method: 'GET', headers };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve({}); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function supabaseInsert(data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const options = {
      hostname: SUPABASE_URL,
      path: '/rest/v1/notifications',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=minimal',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseBody(event) {
  const contentType = (event.headers && (event.headers['content-type'] || event.headers['Content-Type'])) || '';
  const raw = event.body || '';
  if (contentType.includes('application/json')) {
    try { return JSON.parse(raw); } catch(e) { return {}; }
  }
  if (contentType.includes('application/x-www-form-urlencoded') || raw.includes('=')) {
    try {
      const params = new URLSearchParams(raw);
      const obj = {};
      for (const [k, v] of params.entries()) obj[k] = v;
      return obj;
    } catch(e) { return {}; }
  }
  try { return JSON.parse(raw); } catch(e) { return {}; }
}

async function lookupOpportunityId(contactId) {
  try {
    const data = await httpsGet(
      'services.leadconnectorhq.com',
      `/opportunities/search?location_id=${GHL_LOCATION_ID}&contact_id=${contactId}&status=open`,
      {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Accept': 'application/json'
      }
    );
    const opps = data.opportunities || [];
    const open = opps.find(o => o.status === 'open') || opps[0];
    return open ? open.id : null;
  } catch(e) {
    console.error('opportunity lookup failed:', e);
    return null;
  }
}

function classifyWebhook(payload) {
  const type = payload.type || payload.event || '';
  const name = (payload.contact?.name || payload.contact_name || payload.name || 'Unknown').trim();
  const oppName = payload.opportunity?.name || '';

  if (type.includes('closing') || type.includes('close')) {
    const days = payload.days_until_close || '';
    return {
      type: 'closing',
      title: `Closing ${days ? `in ${days} days` : 'soon'}`,
      body: payload.message || `${name}${oppName ? ' — ' + oppName : ''}`,
      urgency: days && parseInt(days) <= 2 ? 'high' : 'normal'
    };
  }
  if (type.includes('appraisal')) {
    return { type: 'appraisal', title: 'Appraisal Received', body: payload.message || name, urgency: 'normal' };
  }
  if (type.includes('clear_to_close') || type.includes('cleartoclose')) {
    return { type: 'clear_to_close', title: 'Clear to Close!', body: payload.message || name, urgency: 'high' };
  }
  if (type.includes('inspection')) {
    return {
      type: 'inspection',
      title: payload.message ? '🔔 Inspection Reminder' : 'Inspection Notice',
      body: payload.message || name,
      urgency: 'normal'
    };
  }
  if (type.includes('listing')) {
    return { type: 'listing', title: 'Listing Goes Live', body: payload.message || name, urgency: 'normal' };
  }
  if (type.includes('under_contract') || type.includes('undercontract')) {
    return { type: 'under_contract', title: 'Under Contract', body: payload.message || name, urgency: 'normal' };
  }
  if (type.includes('contact') || type.includes('new_contact')) {
    return { type: 'new_contact', title: 'New Contact Added', body: payload.message || name, urgency: 'normal' };
  }
  return {
    type: type || 'general',
    title: payload.title || 'New Notification',
    body: payload.message || name,
    urgency: 'normal'
  };
}

exports.handler = async (event, context) => {
  if (event.httpMethod === 'GET') {
    return { statusCode: 200, body: JSON.stringify({ status: 'LexPro webhook receiver active' }) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const payload = parseBody(event);
  const classified = classifyWebhook(payload);

  const contactId = payload.contact?.id || payload.contactId || payload.contact_id || null;

  // Look up opportunity ID server-side if not provided
  let oppId = payload.opportunity?.id || payload.opportunityId || payload.opportunity_id || null;
  if (!oppId && contactId) {
    oppId = await lookupOpportunityId(contactId);
  }

  const notification = {
    type: classified.type,
    title: classified.title,
    body: classified.body,
    ghl_contact_id: contactId,
    ghl_opportunity_id: oppId,
    urgency: classified.urgency,
    is_read: false
  };

  try {
    await supabaseInsert(notification);
    return { statusCode: 200, body: JSON.stringify({ success: true, notification }) };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

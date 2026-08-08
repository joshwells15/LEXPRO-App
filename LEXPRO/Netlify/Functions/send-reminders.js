// Triggered by Make's daily 9am schedule (single HTTP call, no data mapping).
// Queries Supabase for open tasks and sends ONE GHL SMS digest per person.
const SUPABASE_URL = 'https://dqiiekdfmocvizzvmwlc.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
// Same GHL Private Integration Token used across LEXPRO Make scenarios
const GHL_API_KEY = 'pit-b2267e03-7ae0-43d3-9cd0-02fa58f3d730';
// Internal/system-to-team number (same as Tanya's alerts)
const INTERNAL_FROM = '+14176474633';
// Simple shared secret so random traffic can't trigger reminder blasts
const REMINDER_KEY = 'lexpro-9am-2026';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const providedKey = event.headers['x-reminder-key'] || event.headers['X-Reminder-Key'];
  if (providedKey !== REMINDER_KEY) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  try {
    // 1. Get all open tasks
    const res = await fetch(`${SUPABASE_URL}/rest/v1/lex_tasks?status=eq.open&select=*`, {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      }
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('Supabase query failed:', errText);
      return { statusCode: 500, body: JSON.stringify({ error: 'Supabase query failed' }) };
    }
    const tasks = await res.json();
    if (!tasks.length) {
      return { statusCode: 200, body: JSON.stringify({ success: true, sent: 0, note: 'No open tasks' }) };
    }

    // 2. Group open tasks by person -> one digest SMS each
    const byContact = {};
    for (const task of tasks) {
      if (!task.contact_id) continue;
      (byContact[task.contact_id] = byContact[task.contact_id] || []).push(task);
    }

    let sent = 0;
    let failed = 0;
    for (const [contactId, list] of Object.entries(byContact)) {
      const lines = list.map(t => `• ${t.task}${t.due ? ` (due ${t.due})` : ''}`);
      const plural = list.length === 1 ? 'an open task' : `${list.length} open tasks`;
      const message =
        `Morning reminder - you have ${plural}:\n\n${lines.join('\n')}\n\n` +
        `Log in to the LexPro app to mark them complete.`;
      try {
        const ghlRes = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Version': '2021-04-15',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            type: 'SMS',
            contactId,
            message,
            fromNumber: INTERNAL_FROM,
          }),
        });
        if (ghlRes.ok) sent++;
        else {
          failed++;
          console.error(`GHL digest failed for ${contactId}:`, ghlRes.status, await ghlRes.text());
        }
      } catch (e) {
        failed++;
        console.error(`GHL digest error for ${contactId}:`, e);
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, sent, failed, people: Object.keys(byContact).length, totalOpen: tasks.length }),
    };
  } catch (err) {
    console.error('send-reminders error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};

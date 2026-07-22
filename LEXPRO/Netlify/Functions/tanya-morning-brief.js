// ============================================================
// tanya-morning-brief.js
// Pulls this week's events from GHL Transactions Calendar
// and recent unread GHL conversations, then returns a summary
// ============================================================

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const GHL_API_KEY = process.env.GHL_API_KEY;
    const GHL_LOCATION = process.env.GHL_LOCATION_ID || 'R5PobkV1CRO23kz95yYB';
    const CALENDAR_ID = '1VHA9skkdov7k2J2cja4';
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

    // ── Date range: today through end of week (Sunday) ──────
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const endOfWeek = new Date(now);
    const daysUntilSunday = 7 - endOfWeek.getDay();
    endOfWeek.setDate(endOfWeek.getDate() + daysUntilSunday);
    endOfWeek.setHours(23, 59, 59, 999);

    const startMs = startOfToday.getTime();
    const endMs = endOfWeek.getTime();

    // ── Pull calendar events ─────────────────────────────────
    let calendarEvents = [];
    try {
      const calRes = await fetch(
        `https://services.leadconnectorhq.com/calendars/events?locationId=${GHL_LOCATION}&calendarId=${CALENDAR_ID}&startTime=${startMs}&endTime=${endMs}&limit=50`,
        {
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Version': '2021-04-15'
          }
        }
      );
      const calData = await calRes.json();
      calendarEvents = calData.events || calData.data || [];
      console.log('Calendar events:', JSON.stringify(calendarEvents).slice(0, 500));
    } catch(e) {
      console.error('Calendar fetch error:', e);
    }

    // ── Pull recent GHL conversations ────────────────────────
    let conversations = [];
    try {
      const convRes = await fetch(
        `https://services.leadconnectorhq.com/conversations/search?locationId=${GHL_LOCATION}&limit=20&status=unread`,
        {
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Version': '2021-04-15'
          }
        }
      );
      const convData = await convRes.json();
      conversations = convData.conversations || [];
      console.log('Conversations:', conversations.length);
    } catch(e) {
      console.error('Conversations fetch error:', e);
    }

    // ── Format data for Claude ───────────────────────────────
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    const formatDate = (ts) => {
      const d = new Date(ts);
      return `${dayNames[d.getDay()]} ${monthNames[d.getMonth()]} ${d.getDate()} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
    };

    const eventsText = calendarEvents.length
      ? calendarEvents.map(e => {
          const start = e.startTime || e.start?.dateTime || e.startDate;
          const title = e.title || e.summary || e.name || 'Untitled';
          const contact = e.contactName || e.contact?.name || '';
          return `- ${title}${contact ? ' — ' + contact : ''}: ${start ? formatDate(new Date(start).getTime()) : 'Time TBD'}`;
        }).join('\n')
      : 'No events scheduled for the rest of the week.';

    const convoText = conversations.length
      ? conversations.slice(0, 10).map(c => {
          const name = c.contactName || c.fullName || 'Unknown';
          const last = c.lastMessage?.body || c.lastMessageBody || '';
          const type = c.lastMessage?.type || c.type || 'message';
          return `- ${name}: "${last.slice(0, 100)}${last.length > 100 ? '...' : ''}" (${type})`;
        }).join('\n')
      : 'No unread conversations.';

    const today = `${dayNames[now.getDay()]}, ${monthNames[now.getMonth()]} ${now.getDate()}`;

    // ── Ask Claude to summarize ──────────────────────────────
    const prompt = `You are Tanya's morning briefing assistant at LexPro Real Estate. Give her a warm, concise good morning brief. Today is ${today}.

CALENDAR EVENTS THIS WEEK:
${eventsText}

UNREAD GHL CONVERSATIONS NEEDING ATTENTION:
${convoText}

Write a natural, friendly morning brief for Tanya. Structure it as:
1. A warm good morning greeting
2. What's on the calendar TODAY specifically
3. What's coming up the REST OF THE WEEK
4. Any conversations that need her attention
5. A quick motivational close

Keep it conversational, like a smart assistant talking to her. Not bullet points — flowing sentences she can listen to. Under 300 words.`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const aiData = await aiRes.json();
    const brief = aiData.content?.[0]?.text || 'Good morning Tanya! I had trouble pulling your calendar today — try again in a moment.';

    return {
      statusCode: 200,
      body: JSON.stringify({
        brief,
        eventCount: calendarEvents.length,
        unreadCount: conversations.length
      })
    };

  } catch (err) {
    console.error('tanya-morning-brief error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server error', brief: 'Good morning Tanya! Had a hiccup pulling your brief — try again in a second.' })
    };
  }
};

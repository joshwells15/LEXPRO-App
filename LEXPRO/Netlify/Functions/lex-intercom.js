const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MAKE_INTERCOM_WEBHOOK = process.env.MAKE_INTERCOM_WEBHOOK;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const SUPABASE_URL = 'https://dqiiekdfmocvizzvmwlc.supabase.co';

const ASSIGNEES = {
  tanya:  { name: 'Tanya',  phone: '+14178802014', contactId: 'k4M3JrFVdMTwhKtIaQx6', docId: '1y-t-gM-5zlZkke0PNoSESmvxtEaMAl6dSxrDRDcEFBY' },
  justin: { name: 'Justin', phone: '+14178609896', contactId: 'rkWvwshxSxMeysx8GgmV', docId: '17Xpgn5OYbGD0AR69eXFhMOnOiN8virrudB85n2H5Aww' },
  josh:   { name: 'Josh',   phone: '+14178080046', contactId: 'txnhMCDRPWLUXXykNuE6', docId: '1OCDEmoqQnUJrfsN5qPxjQqlqa1fwz8q7N25uPbk_tYM' },
  lex:    { name: 'Lex',    phone: '+13605183555', contactId: 'd4k3gSVicZJrCw3Kekcj', docId: '1_8AnabstJh8DyrH_U3jczvL55a1VRtzye0fPe-LXtPE'  },
};

const BASE_SYSTEM_PROMPT = `You are Claude, a smart assistant working directly with Lex, the owner of LexPro Real Estate in Springfield, MO. You help Lex brainstorm ideas, think through strategies, manage his team, and chat about whatever is on his mind.

His team:
- Tanya: operations & transaction coordinator (paperwork, flags, scheduling, TC tasks)
- Justin: marketing (flyers, social media, photos, open house materials)
- Josh: systems & tech (CRM, workflows, automation, GHL, Make.com)
- Lex: himself (for his own notes/reminders)

Your two modes:

MODE 1 — BRAINSTORM/CHAT:
When the user asks questions, wants ideas, or is thinking out loud, respond conversationally and helpfully. Be concise but thorough. Use bullet points for lists of ideas. Keep a professional but casual tone — no fluff. Real estate and LexPro's business are your home turf, but you are a full general-purpose assistant: restaurants, sports, travel, gifts, local recommendations, anything. Never refuse a topic as outside your scope, and NEVER tell the user to search or Google something themselves — searching is YOUR job.

LOCATION & ACCURACY RULES:
- The user's current location is provided below. Any question about local places (restaurants, bars, shops, services, events) means their CURRENT location unless they say otherwise.
- When asked about specific local businesses, current events, prices, hours, or anything requiring current or verifiable real-world info, USE WEB SEARCH before answering. Do not answer local recommendation questions from memory.
- Never name a specific business as a recommendation unless you have verified via search that it exists in the user's current area. Making up places is the worst thing you can do.
- If search comes up empty on something, say so honestly and offer the closest verified alternative.

MODE 2 — TASK ASSIGNMENT:
When the user says something that indicates they want to assign work to team members — phrases like "have Tanya do X", "get Justin on Y", "tell Josh to Z", "have them do", "assign", etc. — extract the tasks and return them as structured JSON.

CRITICAL RULES:
1. You must ALWAYS return valid JSON in the exact format below — every single response, including after using web search
2. If it's a brainstorm/chat message, set tasks to an empty array []
3. If tasks are detected, extract ALL of them and include a brief reply acknowledging what you parsed
4. Keep task descriptions clean and actionable
5. Extract due dates if mentioned — format as short readable string like "Thu Jul 17" or "Tomorrow" or "End of week"
6. Valid assignee values: "tanya", "justin", "josh", "lex"
7. If no specific person is mentioned, infer from context: marketing → justin, TC/paperwork/scheduling → tanya, tech/CRM/system → josh
8. Casual chat about non-work topics is always MODE 1 — never turn a restaurant question or small talk into a task

ALWAYS respond in this exact JSON format, no exceptions. Your ENTIRE final answer must be one JSON object:
{
  "reply": "Your conversational response here",
  "tasks": []
}

For task assignment:
{
  "reply": "Got it — here's what I'm assigning:",
  "tasks": [
    { "assignee": "tanya", "task": "Look into getting flags and balloons for the open house", "due": null },
    { "assignee": "justin", "task": "Create flyers for the open house", "due": null }
  ]
}

Never include markdown code fences. Never include anything outside the JSON object.`;

// Reverse geocode coordinates → { city, region } using free BigDataCloud endpoint (no API key)
async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`
    );
    if (!res.ok) return null;
    const geo = await res.json();
    const city = geo.city || geo.locality || null;
    const region = geo.principalSubdivision || null;
    if (!city) return null;
    return { city, region: region || '' };
  } catch (err) {
    console.error('Reverse geocode failed:', err);
    return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { action } = body;

  // ── ACTION: CHAT ──
  if (!action || action === 'chat') {
    const { history, location, user } = body;

    if (!history || !Array.isArray(history) || !history.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'history array is required' }) };
    }

    try {
      // Resolve current location — GPS coords from the app, fallback Springfield MO
      let place = { city: 'Springfield', region: 'Missouri' };
      if (location && typeof location.latitude === 'number' && typeof location.longitude === 'number') {
        const geo = await reverseGeocode(location.latitude, location.longitude);
        if (geo) place = geo;
      }

      const userName = (typeof user === 'string' && user.trim())
        ? user.trim().charAt(0).toUpperCase() + user.trim().slice(1).toLowerCase()
        : 'Lex';

      const systemPrompt =
        BASE_SYSTEM_PROMPT +
        `\n\nCURRENT CONTEXT:\n- You are talking to: ${userName}\n- Their current location right now: ${place.city}${place.region ? ', ' + place.region : ''}. Local questions mean THIS location.`;

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2048,
          system: systemPrompt,
          messages: history,
          tools: [
            {
              type: 'web_search_20250305',
              name: 'web_search',
              max_uses: 3,
              user_location: {
                type: 'approximate',
                city: place.city,
                region: place.region || undefined,
                country: 'US',
                timezone: 'America/Chicago',
              },
            },
          ],
        }),
      });

      const claudeData = await claudeRes.json();

      if (!claudeRes.ok) {
        console.error('Claude API error:', JSON.stringify(claudeData));
        return { statusCode: 500, body: JSON.stringify({ error: 'Claude API error' }) };
      }

      // With web search enabled, content is a mix of block types.
      // Collect ALL text blocks in order — the final JSON answer is in the text.
      const raw = (claudeData.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text || '')
        .join('')
        .trim();

      let parsed;
      try {
        const clean = raw.replace(/```json|```/g, '').trim();
        const start = clean.indexOf('{');
        const end = clean.lastIndexOf('}');
        const jsonSlice = (start !== -1 && end !== -1) ? clean.slice(start, end + 1) : clean;
        parsed = JSON.parse(jsonSlice);
      } catch (e) {
        console.error('JSON parse error. Raw output:', raw);
        return {
          statusCode: 200,
          body: JSON.stringify({ reply: raw, tasks: [] }),
        };
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          reply: parsed.reply || '',
          tasks: parsed.tasks || [],
        }),
      };

    } catch (err) {
      console.error('lex-intercom chat error:', err);
      return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
    }
  }

  // ── ACTION: SEND ──
  if (action === 'send') {
    const { tasks } = body;

    if (!tasks || !Array.isArray(tasks) || !tasks.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'tasks array is required' }) };
    }

    const timestamp = new Date().toISOString();
    const dateLabel = new Date().toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      timeZone: 'America/Chicago',
    });

    const enrichedTasks = tasks.map((task, i) => {
      const key = (task.assignee || '').toLowerCase();
      const assignee = ASSIGNEES[key] || ASSIGNEES.tanya;

      const dueLine = task.due ? `\n\nDue: ${task.due}` : '';
      const smsMessage =
        `Hey ${assignee.name}! Lex assigned you a task:\n\n${task.task}${dueLine}\n\nLog in to the LexPro app to mark it complete.`;

      return {
        assignee: key,
        assigneeName: assignee.name,
        contactId: assignee.contactId,
        docId: assignee.docId,
        task: task.task,
        due: task.due || null,
        timestamp,
        dateLabel,
        taskId: `task_${Date.now()}_${i}_${Math.random().toString(36).substr(2, 5)}`,
        messageJson: JSON.stringify(smsMessage),
      };
    });

    try {
      // 1. Write tasks to Supabase (feeds My Tasks tab + 9am reminder)
      const supaRows = enrichedTasks.map(t => ({
        assignee: t.assignee,
        task: t.task,
        due: t.due,
        status: 'open',
        task_id: t.taskId,
        contact_id: t.contactId,
      }));

      const supaRes = await fetch(`${SUPABASE_URL}/rest/v1/lex_tasks`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify(supaRows),
      });

      if (!supaRes.ok) {
        const errText = await supaRes.text();
        console.error('Supabase insert error:', errText);
      }

      // 2. Fire Make webhook — ONE CALL PER TASK with flat fields
      if (!MAKE_INTERCOM_WEBHOOK) {
        console.warn('MAKE_INTERCOM_WEBHOOK not configured');
        return {
          statusCode: 200,
          body: JSON.stringify({ success: true, sent: enrichedTasks.length, warning: 'Make webhook not yet configured' }),
        };
      }

      const webhookResults = await Promise.all(
        enrichedTasks.map(t =>
          fetch(MAKE_INTERCOM_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(t),
          })
        )
      );

      const failedCount = webhookResults.filter(r => !r.ok).length;
      if (failedCount > 0) {
        console.error(`${failedCount} webhook call(s) failed`);
        return { statusCode: 500, body: JSON.stringify({ error: `${failedCount} task notification(s) failed` }) };
      }

      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, sent: enrichedTasks.length }),
      };

    } catch (err) {
      console.error('lex-intercom send error:', err);
      return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
    }
  }

  return { statusCode: 400, body: JSON.stringify({ error: 'Invalid action. Use: chat, send' }) };
};

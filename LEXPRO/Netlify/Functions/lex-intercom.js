const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MAKE_INTERCOM_WEBHOOK = process.env.MAKE_INTERCOM_WEBHOOK;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const SUPABASE_URL = 'https://dqiiekdfmocvizzvmwlc.supabase.co';

const ASSIGNEES = {
  tanya:  { name: 'Tanya',  phone: '+14178802014', contactId: 'k4M3JrFVdMTwhKtIaQx6', docId: '1y-t-gM-5zlZkke0PNoSESmvxtEaMAl6dSxrDRDcEFBY' },
  justin: { name: 'Justin', phone: '+14178609896', contactId: 'rkWvwshxSxMeysx8GgmV', docId: '17Xpgn5OYbGD0AR69eXFhMOnOiN8virrudB85n2H5Aww' },
  josh:   { name: 'Josh',   phone: '+14178080046', contactId: 'txnhMCDRPWLUXXykNuE6', docId: '1OCDEmoqQnUJrfsN5qPxjQqIqa1fwz8q7N25uPbk_tYM' },
  lex:    { name: 'Lex',    phone: '+13605183555', contactId: 'd4k3gSVicZJrCw3Kekcj', docId: '1_8AnabstJh8DyrH_U3jczvL55a1VRtzye0fPe-LXtPE'  },
};

const SYSTEM_PROMPT = `You are Claude, a smart real estate business assistant working directly with Lex, the owner of LexPro Real Estate in Springfield, MO. You help Lex brainstorm ideas, think through strategies, and manage his team.

His team:
- Tanya: operations & transaction coordinator (paperwork, flags, scheduling, TC tasks)
- Justin: marketing (flyers, social media, photos, open house materials)
- Josh: systems & tech (CRM, workflows, automation, GHL, Make.com)
- Lex: himself (for his own notes/reminders)

Your two modes:

MODE 1 — BRAINSTORM/CHAT:
When Lex asks questions, wants ideas, or is thinking out loud, respond conversationally and helpfully. Be concise but thorough. Use bullet points for lists of ideas. Keep a professional but casual tone — Lex is busy and doesn't want fluff. Stay focused on real estate.

MODE 2 — TASK ASSIGNMENT:
When Lex says something that indicates he wants to assign work to team members — phrases like "have Tanya do X", "get Justin on Y", "tell Josh to Z", "have them do", "assign", etc. — extract the tasks and return them as structured JSON.

CRITICAL RULES:
1. You must ALWAYS return valid JSON in the exact format below — every single response
2. If it's a brainstorm/chat message, set tasks to an empty array []
3. If tasks are detected, extract ALL of them and include a brief reply acknowledging what you parsed
4. Keep task descriptions clean and actionable
5. Extract due dates if mentioned — format as short readable string like "Thu Jul 17" or "Tomorrow" or "End of week"
6. Valid assignee values: "tanya", "justin", "josh", "lex"
7. If no specific person is mentioned, infer from context: marketing → justin, TC/paperwork/scheduling → tanya, tech/CRM/system → josh

ALWAYS respond in this exact JSON format, no exceptions:
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
    const { history } = body;

    if (!history || !Array.isArray(history) || !history.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'history array is required' }) };
    }

    try {
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages: history,
        }),
      });

      const claudeData = await claudeRes.json();

      if (!claudeRes.ok) {
        console.error('Claude API error:', JSON.stringify(claudeData));
        return { statusCode: 500, body: JSON.stringify({ error: 'Claude API error' }) };
      }

      const raw = (claudeData.content?.[0]?.text || '').trim();

      let parsed;
      try {
        const clean = raw.replace(/```json|```/g, '').trim();
        parsed = JSON.parse(clean);
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

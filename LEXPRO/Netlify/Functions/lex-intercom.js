const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MAKE_INTERCOM_WEBHOOK = process.env.MAKE_INTERCOM_WEBHOOK;

const ASSIGNEES = {
  tanya: { name: 'Tanya', phone: '+14178802014', docId: '1y-t-gM-5zlZkke0PNoSESmvxtEaMAl6dSxrDRDcEFBY' },
  justin: { name: 'Justin', phone: '+14178609896', docId: '17Xpgn5OYbGD0AR69eXFhMOnOiN8virrudB85n2H5Aww' },
  josh:   { name: 'Josh',   phone: '+14178080046', docId: '1OCDEmoqQnUJrfsN5qPxjQqIqa1fwz8q7N25uPbk_tYM' },
  lex:    { name: 'Lex',    phone: '+13605183555', docId: '1_8AnabstJh8DyrH_U3jczvL55a1VRtzye0fPe-LXtPE' },
};

const PARSE_SYSTEM_PROMPT = `You are a task parser for a real estate team. Your job is to read a natural language message from Lex (the team leader) and extract individual tasks assigned to specific team members.

Team members are: Tanya (operations/TC), Justin (marketing), Josh (systems/tech), Lex (himself, for his own notes).

Rules:
- Extract every distinct task mentioned
- Assign each task to the correct person based on context clues or explicit mentions
- If no person is mentioned for a task, use context (marketing tasks → Justin, transaction/paperwork → Tanya, tech/CRM/workflow → Josh)
- Keep task descriptions clear and actionable — rewrite vague language into a clean task
- Extract due dates if mentioned (e.g. "by Thursday", "tomorrow", "end of week") — format as a short readable string like "Thu Jul 17" or "Tomorrow"
- Return ONLY valid JSON, no explanation, no markdown, no backticks

Output format:
{
  "tasks": [
    {
      "assignee": "tanya",
      "task": "Pull flags on the 123 Main Street listing",
      "due": "Tomorrow"
    },
    {
      "assignee": "justin",
      "task": "Create flyers for the Main Street open house",
      "due": null
    }
  ]
}

Valid assignee values: "tanya", "justin", "josh", "lex"
If the message contains no actionable tasks, return: {"tasks": []}`;

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

  const { action, message, tasks, originalMessage } = body;

  // ── ACTION: PARSE ──
  // Parse the natural language message into structured tasks via Claude API
  if (!action || action === 'parse') {
    if (!message) {
      return { statusCode: 400, body: JSON.stringify({ error: 'message is required' }) };
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
          system: PARSE_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: message }],
        }),
      });

      const claudeData = await claudeRes.json();

      if (!claudeRes.ok) {
        console.error('Claude API error:', claudeData);
        return { statusCode: 500, body: JSON.stringify({ error: 'Claude API error' }) };
      }

      const raw = claudeData.content?.[0]?.text || '';

      let parsed;
      try {
        const clean = raw.replace(/```json|```/g, '').trim();
        parsed = JSON.parse(clean);
      } catch {
        console.error('JSON parse error from Claude output:', raw);
        return { statusCode: 500, body: JSON.stringify({ error: 'Could not parse Claude response as JSON' }) };
      }

      return {
        statusCode: 200,
        body: JSON.stringify({ tasks: parsed.tasks || [] }),
      };

    } catch (err) {
      console.error('lex-intercom parse error:', err);
      return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
    }
  }

  // ── ACTION: SEND ──
  // Fire the Make webhook with the confirmed task list
  if (action === 'send') {
    if (!tasks || !Array.isArray(tasks) || !tasks.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'tasks array is required' }) };
    }

    const timestamp = new Date().toISOString();
    const dateLabel = new Date().toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });

    // Enrich tasks with assignee details
    const enrichedTasks = tasks.map(task => {
      const key = (task.assignee || '').toLowerCase();
      const assignee = ASSIGNEES[key] || ASSIGNEES.tanya;
      return {
        assignee: key,
        assigneeName: assignee.name,
        assigneePhone: assignee.phone,
        docId: assignee.docId,
        task: task.task,
        due: task.due || null,
        timestamp,
        dateLabel,
        originalMessage: originalMessage || '',
        taskId: 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      };
    });

    try {
      if (!MAKE_INTERCOM_WEBHOOK) {
        console.warn('MAKE_INTERCOM_WEBHOOK not set — skipping Make call');
        return {
          statusCode: 200,
          body: JSON.stringify({ success: true, sent: enrichedTasks.length, warning: 'Make webhook not configured' }),
        };
      }

      const makeRes = await fetch(MAKE_INTERCOM_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tasks: enrichedTasks,
          taskCount: enrichedTasks.length,
          originalMessage: originalMessage || '',
          timestamp,
          dateLabel,
        }),
      });

      if (!makeRes.ok) {
        console.error('Make webhook error:', makeRes.status);
        return { statusCode: 500, body: JSON.stringify({ error: 'Make webhook failed' }) };
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

  return { statusCode: 400, body: JSON.stringify({ error: 'Invalid action' }) };
};

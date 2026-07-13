const SUPABASE_URL = 'https://dqiiekdfmocvizzvmwlc.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MAKE_COMPLETE_WEBHOOK = process.env.MAKE_COMPLETE_WEBHOOK;

const LEX_PHONE = '+13605183555';

const ASSIGNEE_NAMES = {
  tanya:  'Tanya',
  justin: 'Justin',
  josh:   'Josh',
  lex:    'Lex',
};

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

  const { taskId, assigneeKey, assigneeName } = body;

  if (!taskId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'taskId is required' }) };
  }

  const completedAt = new Date().toISOString();

  try {
    // 1. Fetch the task so we have the task text
    const fetchRes = await fetch(`${SUPABASE_URL}/rest/v1/lex_tasks?id=eq.${taskId}&select=*`, {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      }
    });

    const tasks = await fetchRes.json();
    const task = tasks?.[0];

    if (!task) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Task not found' }) };
    }

    // 2. Mark complete in Supabase
    const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/lex_tasks?id=eq.${taskId}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ status: 'complete', completed_at: completedAt }),
    });

    if (!updateRes.ok) {
      const errText = await updateRes.text();
      console.error('Supabase update error:', errText);
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not update task in database' }) };
    }

    // 3. Fire Make webhook to notify Lex via SMS
    if (MAKE_COMPLETE_WEBHOOK) {
      const name = assigneeName || ASSIGNEE_NAMES[assigneeKey] || assigneeKey || 'Your team';
      await fetch(MAKE_COMPLETE_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId,
          assigneeKey,
          assigneeName: name,
          taskText: task.task,
          completedAt,
          lexPhone: LEX_PHONE,
          message: `✅ ${name} completed a task: "${task.task}"`,
        }),
      });
    } else {
      console.warn('MAKE_COMPLETE_WEBHOOK not set — skipping Lex notification');
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, taskId, completedAt }),
    };

  } catch (err) {
    console.error('complete-task error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};

const SUPABASE_URL = 'https://dqiiekdfmocvizzvmwlc.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MAKE_COMPLETE_WEBHOOK = process.env.MAKE_COMPLETE_WEBHOOK;

const TEAM = {
  tanya:  { name: 'Tanya',  contactId: 'k4M3JrFVdMTwhKtIaQx6' },
  justin: { name: 'Justin', contactId: 'rkWvwshxSxMeysx8GgmV' },
  josh:   { name: 'Josh',   contactId: 'txnhMCDRPWLUXXykNuE6' },
  lex:    { name: 'Lex',    contactId: 'd4k3gSVicZJrCw3Kekcj' },
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
    // 1. Fetch the task (includes assigned_by)
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

    // 3. Notify whoever assigned the task (falls back to Lex for older tasks)
    const doneByKey = (task.assignee || assigneeKey || '').toLowerCase();
    const doneByName = assigneeName || TEAM[doneByKey]?.name || doneByKey || 'Your team';

    const assignerKey = (task.assigned_by || 'lex').toLowerCase();
    const assigner = TEAM[assignerKey] || TEAM.lex;

    const selfAssigned = assignerKey === doneByKey;

    if (!selfAssigned && MAKE_COMPLETE_WEBHOOK) {
      const message = `✅ ${doneByName} completed a task you assigned: "${task.task}"`;
      await fetch(MAKE_COMPLETE_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId,
          assigneeKey: doneByKey,
          assigneeName: doneByName,
          taskText: task.task,
          completedAt,
          notifyContactId: assigner.contactId,
          notifyName: assigner.name,
          messageJson: JSON.stringify(message),
        }),
      });
    } else if (!MAKE_COMPLETE_WEBHOOK) {
      console.warn('MAKE_COMPLETE_WEBHOOK not set — skipping notification');
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        taskId,
        completedAt,
        notified: selfAssigned ? null : assigner.name,
      }),
    };

  } catch (err) {
    console.error('complete-task error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};

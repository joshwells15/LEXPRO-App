const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_URL = 'https://dqiiekdfmocvizzvmwlc.supabase.co';

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

  const { username, currentHash, newHash } = body;

  if (!username || !currentHash || !newHash) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  try {
    // 1. Verify current password
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/users?username=eq.${encodeURIComponent(username.toLowerCase())}&password_hash=eq.${currentHash}&select=id`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );

    const matches = await checkRes.json();

    if (!Array.isArray(matches) || matches.length === 0) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Current password is incorrect.' }) };
    }

    // 2. Update to the new password hash
    const updateRes = await fetch(
      `${SUPABASE_URL}/rest/v1/users?username=eq.${encodeURIComponent(username.toLowerCase())}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ password_hash: newHash }),
      }
    );

    if (!updateRes.ok) {
      const errText = await updateRes.text();
      console.error('Password update failed:', errText);
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not update password.' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ success: true }) };

  } catch (err) {
    console.error('change-password error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};

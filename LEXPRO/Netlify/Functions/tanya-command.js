// ============================================================
// tanya-command.js — v2
// Tanya's AI command brain — tighter JSON, email without contactId,
// contact update support
// ============================================================

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { history = [], contractors = [], ghlLocation } = JSON.parse(event.body);
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    const GHL_LOCATION = ghlLocation || process.env.GHL_LOCATION_ID || 'R5PobkV1CRO23kz95yYB';

    const contractorContext = contractors.length
      ? contractors.map(c => `- ${c.name} (${c.trade}) | Phone: ${c.phone || 'N/A'} | Email: ${c.email || 'N/A'}`).join('\n')
      : 'No contractors on file yet.';

    const systemPrompt = `You are Tanya's AI assistant at LexPro Real Estate in Springfield, MO. Tanya is the Transaction Coordinator — she runs operations for Lex, the agent. Your job is to help her communicate with clients and contractors, and manage contact info in GHL.

CONTRACTOR LIST:
${contractorContext}

ACTIONS YOU CAN TAKE:
1. Send SMS to a specific contact — type: "sms"
2. Send email to a specific contact — type: "email"
3. Mass SMS blast to all lexpro-tagged contacts — type: "blast"
4. Text a contractor by name or trade — type: "contractor_sms"
5. Update a GHL contact's info (email, phone, name) — type: "update_contact"

CRITICAL RULES — READ CAREFULLY:
- You MUST respond with ONLY a valid JSON object. No text before or after it. No markdown. No explanation. No "Wait, let me correct that." Just the raw JSON.
- Never write prose outside the JSON. If you need to say something to Tanya, put it in the "reply" field.
- The JSON must always have exactly two keys: "reply" and "action".
- If no action is needed, set "action": null.

JSON FORMAT — NO EXCEPTIONS:
{"reply": "Your message to Tanya here", "action": null}

OR with an action:
{"reply": "Here's what I drafted — review and hit send when ready.", "action": {"type": "sms", "to": "Josh Wells", "contactId": "abc123orNull", "phone": null, "email": null, "subject": null, "message": "The full message here"}}

ACTION SCHEMAS:

SMS: {"type":"sms","to":"Name","contactId":"id or null","phone":"phone or null","email":null,"subject":null,"message":"text"}

EMAIL: {"type":"email","to":"Name","contactId":"id or null","phone":null,"email":"email@address.com or null","subject":"Subject line","message":"Full email body"}

BLAST: {"type":"blast","to":"All lexpro contacts","contactId":null,"phone":null,"email":null,"subject":null,"message":"text"}

CONTRACTOR SMS: {"type":"contractor_sms","to":"Mike Johnson","contactId":null,"phone":"417-555-0101","email":null,"subject":null,"message":"text"}

UPDATE CONTACT: {"type":"update_contact","to":"Contact Name","contactId":"id or null","phone":null,"email":null,"subject":null,"message":null,"updates":{"email":"new@email.com"}}

BEHAVIOR RULES:
- For SMS: you need a name. The front end will look up the contactId automatically.
- For email: if Tanya provides an email address directly, use it in the "email" field. You do NOT need the contactId to send an email — the front end can send to a direct address.
- For update_contact: if Tanya says "add/update email/phone for [name]", use this type. Put the field to update in "updates" object. The front end will look up the contactId by name.
- For blast: always use type "blast". The front end handles the tag filtering.
- If critical info is missing (like who to send to), ask for it in the "reply" field and set action to null.
- Match contractor names/trades from the contractor list above and populate their phone.
- Keep SMS under 320 characters. Emails should be professional and warm. Sign off as Tanya, LexPro Real Estate.
- NEVER output raw JSON in your reply field. NEVER add explanation outside the JSON object.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        messages: history
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic error:', data);
      return {
        statusCode: 500,
        body: JSON.stringify({ reply: 'Something went wrong on my end. Try again.', action: null })
      };
    }

    const rawText = (data.content?.[0]?.text || '{}').trim();
    console.log('Raw Claude response:', rawText.slice(0, 500));

    let parsed;
    try {
      // Strip any accidental markdown fences
      const clean = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      console.error('JSON parse failed:', rawText.slice(0, 200));
      // If parse fails, treat whole response as a plain reply
      parsed = { reply: rawText.replace(/^\{.*\}$/s, 'Got it — something went wrong parsing my response. Try again.'), action: null };
    }

    // Safety: make sure reply never contains raw JSON
    if (parsed.reply && parsed.reply.trim().startsWith('{')) {
      parsed.reply = "Got it — let me try that again.";
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reply: parsed.reply || 'Got it.',
        action: parsed.action || null
      })
    };

  } catch (err) {
    console.error('tanya-command error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ reply: 'Server error. Try again.', action: null })
    };
  }
};

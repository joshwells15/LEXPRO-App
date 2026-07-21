// ============================================================
// tanya-command.js
// Netlify function — Tanya's AI command brain
// Reads her message, returns { reply, action } where action
// is a structured object the front end uses to show a confirm card
// ============================================================

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { history = [], contractors = [], ghlLocation } = JSON.parse(event.body);

    const GHL_API_KEY = process.env.GHL_API_KEY;
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    const GHL_LOCATION = ghlLocation || process.env.GHL_LOCATION_ID || 'R5PobkV1CRO23kz95yYB';

    // Build contractor context string
    const contractorContext = contractors.length
      ? contractors.map(c => `- ${c.name} (${c.trade}) | Phone: ${c.phone || 'N/A'} | Email: ${c.email || 'N/A'}`).join('\n')
      : 'No contractors on file yet.';

    const systemPrompt = `You are Tanya's AI assistant at LexPro Real Estate in Springfield, MO. Tanya is the Transaction Coordinator (TC) — she runs the show behind the scenes for Lex, the agent.

Your job is to help Tanya communicate with clients, sellers, buyers, and contractors. You draft messages, she approves them, then they send. Nothing sends without her confirmation.

CONTRACTOR LIST (pulled live from database):
${contractorContext}

WHAT YOU CAN DO:
1. Draft and send SMS to a specific contact (type: "sms")
2. Draft and send email to a specific contact (type: "email")  
3. Send a mass SMS blast to all contacts tagged "lexpro" (type: "blast")
4. Text a contractor by name or trade (type: "contractor_sms")
5. Answer questions, give advice, help draft language — no action needed (type: null)

HOW TO RESPOND:
Always respond with valid JSON in this exact format:
{
  "reply": "Your conversational response to Tanya here",
  "action": null
}

OR if an action is needed:
{
  "reply": "Here's what I drafted — review and hit send when ready.",
  "action": {
    "type": "sms" | "email" | "blast" | "contractor_sms",
    "to": "Recipient name or 'All lexpro contacts'",
    "contactId": "GHL contact ID if known, otherwise null",
    "phone": "phone number if contractor or known, otherwise null",
    "email": "email address if known, otherwise null",
    "subject": "Email subject line (email only, otherwise null)",
    "message": "The full drafted message ready to send"
  }
}

TONE RULES:
- SMS messages: conversational, warm, concise. No more than 320 characters.
- Emails: professional but friendly. Real estate TC tone.
- Blast messages: upbeat, brief, on-brand for LexPro.
- Contractor texts: direct and professional.

IMPORTANT:
- If Tanya mentions a contractor by name or trade, match them from the contractor list above and populate phone/email.
- If she says "blast" or "mass text" or "everyone" — use type "blast".
- If she gives you a seller/buyer name but no contact ID, set contactId to null — the front end will look it up.
- If she just wants to chat, brainstorm, or ask a question — set action to null.
- Always ask for missing info before drafting if critical details are missing (like who the message is going to).
- ONLY return valid JSON. No markdown, no explanation outside the JSON.`;

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

    const rawText = data.content?.[0]?.text || '{}';

    // Parse JSON response from Claude
    let parsed;
    try {
      const clean = rawText.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      // If Claude didn't return valid JSON, treat it as a plain reply
      parsed = { reply: rawText, action: null };
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

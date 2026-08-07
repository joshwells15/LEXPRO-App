// LEXPRO :: enrich-listing.js
// Fills property_facts on registry listings using Claude + web search.
// The model searches the address (Zillow/Realtor/MLS echoes), extracts hard
// facts, and returns forced JSON. Anything not clearly found = null - never
// guessed. Donna's "let me check with the team" fallback covers every null.
//
// Usage:
//   POST {"listing_id": "<uuid>"}   -> enrich one listing
//   POST {"sweep": true}            -> enrich every active listing missing facts (max 5/run)
//   POST {"listing_id": "...", "force": true} -> re-enrich even if facts exist
//
// Wire-in: sync-listing calls this (fire-and-forget) after creating a new listing.
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

async function sb(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: prefer || 'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function researchFacts(addressFull) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
      messages: [{
        role: 'user',
        content:
`Research this real estate listing: ${addressFull}

Search for its current listing on Zillow, Realtor.com, or similar sites. Extract ONLY facts you actually find for THIS EXACT address - verify the address matches before trusting a page.

Then respond with ONLY this JSON (no other text after your research):
{
  "beds": number or null,
  "baths": number or null,
  "sqft": number or null,
  "acres": number or null,
  "year_built": number or null,
  "garage": "description like '2-car attached'" or null,
  "basement": "description like 'finished walkout'" or null,
  "style": "e.g. 'ranch', 'two-story'" or null,
  "list_price": number or null,
  "notable": "one short phrase of standout features, e.g. 'pool, 40x60 shop'" or null,
  "source": "site you found it on" or null,
  "match_confidence": "high" | "low"
}

Rules:
- null for anything not clearly stated for this exact address. NEVER estimate or infer.
- match_confidence "low" if you couldn't verify the exact address or found conflicting info.
- The final text of your response must be the JSON object alone.`
      }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // last text block contains the JSON (research/tool blocks precede it)
  const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
  const last = textBlocks[textBlocks.length - 1] || '';
  const jsonMatch = last.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('no JSON in research response');
  return JSON.parse(jsonMatch[0]);
}

function resp(code, obj) {
  return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(200, { ok: true, note: 'POST only' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { }

  try {
    let targets = [];
    if (body.listing_id) {
      const r = await sb(`listings?id=eq.${encodeURIComponent(body.listing_id)}&select=id,address_full,property_facts`);
      if (!r || !r[0]) return resp(404, { ok: false, error: 'listing not found' });
      if (r[0].property_facts && !body.force)
        return resp(200, { ok: true, skipped: 'facts already present (use force:true to redo)' });
      targets = [r[0]];
    } else if (body.sweep) {
      targets = await sb(
        `listings?status=eq.active&property_facts=is.null&select=id,address_full&limit=5`
      );
      if (!targets.length) return resp(200, { ok: true, note: 'nothing to enrich' });
    } else {
      return resp(400, { ok: false, error: 'listing_id or sweep:true required' });
    }

    const results = [];
    for (const t of targets) {
      try {
        const facts = await researchFacts(t.address_full);
        if (facts.match_confidence === 'low') {
          // store nothing on low confidence - a wrong house is worse than no facts
          results.push({ id: t.id, address: t.address_full, stored: false, reason: 'low confidence' });
          continue;
        }
        delete facts.match_confidence;
        facts.enriched_at = new Date().toISOString();
        await sb(`listings?id=eq.${t.id}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: { property_facts: facts }
        });
        results.push({ id: t.id, address: t.address_full, stored: true, facts });
      } catch (e) {
        console.error(`enrich failed for ${t.address_full}:`, e.message);
        results.push({ id: t.id, address: t.address_full, stored: false, reason: e.message });
      }
    }

    console.log('enrich-listing:', JSON.stringify(results.map(r => ({ a: r.address, ok: r.stored }))));
    return resp(200, { ok: true, results });
  } catch (err) {
    console.error('enrich-listing error:', err);
    return resp(500, { ok: false, error: err.message });
  }
};

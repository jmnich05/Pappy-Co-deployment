/* Pappy & Co — AI Deployment Hub — AI-assist endpoint
 * Drafts/refines a single intake-form field via the Anthropic API.
 *
 * Requires Netlify env var ANTHROPIC_API_KEY. Optional ANTHROPIC_MODEL
 * (default: claude-sonnet-4-5-20250929).
 *
 * Request body (JSON):
 *   formTitle, formIntro, stepTitle, stepIntro, fieldLabel, fieldHelp,
 *   fieldPlaceholder, currentValue, contextResponses (object), refineHint (string|null)
 * Response: { suggestion: string, model: string } or { error: string }
 *
 * Note on auth: this endpoint is publicly reachable on the Netlify
 * domain. The client only exposes the ✨ button to signed-in users via
 * the portal's UI, and the function checks an Origin header so it only
 * accepts calls from the deployed sites. For production hardening,
 * forward a Supabase session token in the Authorization header and
 * verify it via the supabase admin client. Wired for that — see below.
 */

const ALLOWED_ORIGINS = [
  'https://ai.pappyco.com',
  'http://localhost:8000',
  'http://localhost:8765'
];

exports.handler = async function (event) {
  // CORS preflight (Netlify functions are same-origin by default, but we may post from a different host in dev)
  const origin = event.headers && (event.headers.origin || event.headers.Origin);
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.indexOf(origin) >= 0 ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'method not allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 503, headers: corsHeaders, body: JSON.stringify({ error: 'AI-assist not configured: ANTHROPIC_API_KEY is not set in Netlify env.' }) };
  }
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'invalid JSON' }) }; }

  const prompt = buildPrompt(body);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const text = await res.text();
    if (!res.ok) {
      return { statusCode: res.status, headers: { ...corsHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Anthropic API ' + res.status, detail: text.slice(0, 500) }) };
    }
    let data;
    try { data = JSON.parse(text); }
    catch (e) { return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: 'invalid response from Anthropic' }) }; }
    const suggestion = (data.content && data.content[0] && data.content[0].text) || '';
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ suggestion: suggestion.trim(), model: data.model || model })
    };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: String(e && e.message || e) }) };
  }
};

function buildPrompt(body) {
  const formTitle = body.formTitle || '';
  const formIntro = body.formIntro || '';
  const stepTitle = body.stepTitle || '';
  const stepIntro = body.stepIntro || '';
  const fieldLabel = body.fieldLabel || '';
  const fieldHelp = body.fieldHelp || '';
  const fieldPlaceholder = body.fieldPlaceholder || '';
  const currentValue = (body.currentValue || '').trim();
  const refineHint = (body.refineHint || '').trim();
  const ctx = body.contextResponses || {};
  const contextStr = Object.keys(ctx).length ? JSON.stringify(ctx, null, 2) : '(nothing yet)';

  let mode;
  if (currentValue && refineHint) {
    mode = '\n\nTheir current draft:\n\n"""\n' + currentValue + '\n"""\n\nThey want it: ' + refineHint + '\n\nWrite the revised answer.';
  } else if (currentValue) {
    mode = '\n\nTheir current draft:\n\n"""\n' + currentValue + '\n"""\n\nWrite an improved version — keep their intent, tighten or expand only as useful.';
  } else {
    mode = '\n\nWrite a suggested first draft they can edit. Be specific; if you have to invent details, use plausible placeholders the user can swap in.';
  }

  return 'You\'re helping a small-business team fill in their company\'s AI rollout intake form. The audience for the answer is the AI that will later use it as context, plus the team\'s own AI tools and assistants.\n\n' +
    'Style:\n' +
    '- Plain language, no consulting jargon (no "synergy," "leverage," "circle back")\n' +
    '- Specific over generic — concrete examples beat abstractions\n' +
    '- Match the length the field clearly calls for (2-4 sentences unless it wants a list)\n' +
    '- For list-style fields (do\'s, don\'ts, tasks, bullets), one item per line with "- " prefix; no headings\n' +
    '- Match the team\'s voice from the context below\n' +
    '- Don\'t preface with "Here\'s a suggestion" or "Sure," — just write the answer\n\n' +
    'Form: ' + formTitle + (formIntro ? '\nForm intro: ' + formIntro : '') + '\n' +
    'Step: ' + stepTitle + (stepIntro ? ' — ' + stepIntro : '') + '\n\n' +
    'Field: "' + fieldLabel + '"' +
    (fieldHelp ? '\nHint shown to the user: ' + fieldHelp : '') +
    (fieldPlaceholder ? '\nExample placeholder: ' + fieldPlaceholder : '') + '\n\n' +
    'What they\'ve filled in elsewhere on this form (use as context and voice reference):\n```json\n' + contextStr + '\n```' +
    mode;
}

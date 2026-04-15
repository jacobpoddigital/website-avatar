import { parseHTML } from 'linkedom';
import * as jose from 'jose';
import { generateMagicToken, generateAuthToken, verifyJWT } from './src/auth.js';

// ── HELPER FUNCTIONS ─────────────────────────────
function generateAdminEmail({ name, phone, email, company, callSummary, callDuration }) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Website Avatar Lead</title>
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f4f3f7; }
    .container { max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(111, 96, 153, 0.1); }
    .header { background-color: #072138; padding: 32px 24px; text-align: center; border-radius: 12px 12px 0 0; }
    .header h1 { color: #ffffff; margin: 0; font-size: 24px; }
    .content { padding: 40px 24px; }
    .info-row { margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid #e5e7eb; }
    .info-row:last-child { border-bottom: none; }
    .label { font-size: 14px; color: #6b7280; font-weight: 500; }
    .value { font-size: 16px; color: #1f2937; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Website Avatar</h1>
      <p style="color: #e0e0e0; margin: 8px 0 0;">New Lead Received</p>
    </div>
    <div class="content">
      <div class="info-row"><div class="label">Full Name</div><div class="value">${name}</div></div>
      <div class="info-row"><div class="label">Phone Number</div><div class="value">${phone}</div></div>
      <div class="info-row"><div class="label">Email Address</div><div class="value">${email}</div></div>
      <div class="info-row"><div class="label">Company Name</div><div class="value">${company}</div></div>
      <div class="info-row"><div class="label">Call Summary</div><div class="value">${callSummary}</div></div>
      <div class="info-row"><div class="label">Call Duration</div><div class="value">${callDuration}</div></div>
    </div>
  </div>
</body>
</html>`;
}

function generateThankYouEmail({ name, businessName = 'our team' }) {
  const firstName = name.split(' ')[0];
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Thank You</title>
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f4f3f7; }
    .container { max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; }
    .header { background-color: #072138; padding: 32px 24px; text-align: center; border-radius: 12px 12px 0 0; }
    .header h1 { color: #ffffff; margin: 0; }
    .content { padding: 40px 24px; }
    .message { font-size: 16px; line-height: 1.6; color: #374151; margin-bottom: 24px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>Thank You!</h1></div>
    <div class="content">
      <p class="message">Hi ${firstName},</p>
      <p class="message">Thank you for getting in touch with us through our Website Avatar. We've received your information and one of our team members will be in contact with you shortly.</p>
      <p class="message">If you have any urgent questions in the meantime, please don't hesitate to reach out to us directly.</p>
      <p class="message">Best regards,<br><strong>The ${businessName} Team</strong></p>
    </div>
  </div>
</body>
</html>`;
}

async function sendEmail({ from, to, subject, html }, env) {
  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      personalizations: [{ to: (Array.isArray(to) ? to : [to]).map(email => ({ email })) }],
      from: { email: from, name: 'Website Avatar' },
      subject: subject,
      content: [{ type: 'text/html', value: html }]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Email failed: ${response.status} - ${errorText}`);
  }
  return response;
}

async function sendSMS({ to, body }, env) {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  const fromNumber = env.TWILIO_PHONE_NUMBER;

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${accountSid}:${authToken}`),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        To: to,
        From: fromNumber,
        Body: body
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SMS failed: ${response.status} - ${errorText}`);
  }

  return response;
}

async function appendToSheet(data, env) {
  try {
    // Parse service account JSON
    const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);

    // Import private key using jose
    const privateKey = await jose.importPKCS8(sa.private_key, 'RS256');

    // Create JWT with scope
    const jwt = await new jose.SignJWT({
      scope: 'https://www.googleapis.com/auth/spreadsheets'
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(sa.client_email)
      .setSubject(sa.client_email)
      .setAudience(sa.token_uri)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    // Get access token
    const tokenResp = await fetch(sa.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
    });

    if (!tokenResp.ok) {
      const errorText = await tokenResp.text();
      throw new Error(`Token request failed: ${tokenResp.status} - ${errorText}`);
    }

    const tokenData = await tokenResp.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      throw new Error('No access token received');
    }

    // Prepare row data
    const values = [[
      data.name,
      data.phone,
      data.email,
      data.company,
      data.callSummary,
      data.callDuration,
      new Date().toISOString()
    ]];

    // Append row to Google Sheet
    const sheetsResp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Sheet1!A:G:append?valueInputOption=RAW`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ values })
      }
    );

    if (!sheetsResp.ok) {
      const errorText = await sheetsResp.text();
      throw new Error(`Sheets API error: ${sheetsResp.status} - ${errorText}`);
    }

    const result = await sheetsResp.json();
    console.log('[Sheets] Successfully appended row:', result);
    
    return result;

  } catch (err) {
    console.error('[Sheets] Error:', err);
    throw err;
  }
}

// ── PROFILE HELPERS ──────────────────────────────────────────────────────────

/**
 * Upsert profile fields for an authenticated user.
 * Only fills blank/null columns — never overwrites existing data.
 * Returns true if any row was changed.
 */
async function upsertUserProfile(db, userId, clientId = '', { name, phone, company, job_title } = {}, overwrite = false) {
  // overwrite = false (profile edits): COALESCE — only fill null fields, never regress existing data
  // overwrite = true  (webhook data):  CASE    — update if incoming value is present, keep existing if not
  const nameExpr      = overwrite ? `CASE WHEN excluded.name      IS NOT NULL AND excluded.name      != '' THEN excluded.name      ELSE name      END` : `COALESCE(name,      CASE WHEN excluded.name      != '' THEN excluded.name      ELSE NULL END)`;
  const phoneExpr     = overwrite ? `CASE WHEN excluded.phone     IS NOT NULL AND excluded.phone     != '' THEN excluded.phone     ELSE phone     END` : `COALESCE(phone,     CASE WHEN excluded.phone     != '' THEN excluded.phone     ELSE NULL END)`;
  const companyExpr   = overwrite ? `CASE WHEN excluded.company   IS NOT NULL AND excluded.company   != '' THEN excluded.company   ELSE company   END` : `COALESCE(company,   CASE WHEN excluded.company   != '' THEN excluded.company   ELSE NULL END)`;
  const jobTitleExpr  = overwrite ? `CASE WHEN excluded.job_title IS NOT NULL AND excluded.job_title != '' THEN excluded.job_title ELSE job_title END` : `COALESCE(job_title, CASE WHEN excluded.job_title != '' THEN excluded.job_title ELSE NULL END)`;

  await db.prepare(`
    INSERT INTO user_profiles (user_id, client_id, name, phone, company, job_title, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(user_id, client_id) DO UPDATE SET
      name      = ${nameExpr},
      phone     = ${phoneExpr},
      company   = ${companyExpr},
      job_title = ${jobTitleExpr},
      updated_at = unixepoch()
  `).bind(
    userId,
    clientId  || '',
    name      || null,
    phone     || null,
    company   || null,
    job_title || null
  ).run();
}

/**
 * Generate (or refresh) the persona_summary for a user via OpenAI.
 * Pulls the profile + last 3 conversation transcripts for context.
 * Saves the result back to user_profiles.persona_summary.
 * Safe to call fire-and-forget via ctx.waitUntil().
 */
/**
 * Refresh the persona_summary for an authenticated user.
 *
 * Uses the transcript_summary from the webhook as the
 * new-conversation signal — it's already semantically compressed and far
 * better input than raw message snippets. The existing persona_summary is
 * passed back so OpenAI refines/accumulates rather than rewriting from scratch.
 *
 * No D1 transcript queries needed — all signal comes from the webhook payload
 * and the current profile row.
 *
 * @param {D1Database} db
 * @param {string} userId
 * @param {object} env
 * @param {string|null} transcriptSummary - analysis.transcript_summary from the Dialogue webhook
 */
// JSON schema passed to OpenAI on first persona creation.
// Kept minimal so the model doesn't hallucinate unknown fields.
const PERSONA_SCHEMA = {
  user: { name: '', role: '', age_range: '', location: '' },
  business: { name: '', industry: '', type: '', size: { employees: null, locations: null }, products_services: [] },
  communication: { style: '', preferences: [] },
  interests: [],
  context: { current_projects: [], goals: [], pain_points: [], past_interactions: [] },
  engagement_notes: [],
  contact: { email: '', phone: '', preferred_method: '' },
  metadata: { persona_created_at: '', last_updated_at: '' }
};

async function refreshPersonaSummary(db, userId, env, transcriptSummary = null, clientId = '') {
  if (!env.OPENAI_KEY) return;

  const profile = await db.prepare(
    'SELECT name, company, job_title, persona_summary FROM user_profiles WHERE user_id = ? AND client_id = ?'
  ).bind(userId, clientId || '').first();

  if (!profile) return;

  const knownFields = [profile.name, profile.company, profile.job_title].filter(Boolean);
  if (knownFields.length < 1) return;

  // Detect whether existing persona is JSON or a legacy paragraph string.
  // Legacy paragraphs are treated as first-time so they convert cleanly to JSON.
  let existingPersona = null;
  let isFirstTime = false;

  if (profile.persona_summary) {
    try {
      existingPersona = JSON.parse(profile.persona_summary);
    } catch {
      isFirstTime = true;
      console.log('[Profile] 🔍 Legacy paragraph detected — converting to JSON');
    }
  } else {
    isFirstTime = true;
  }

  const now = new Date().toISOString();
  const knownData = [
    profile.name      ? `Name: ${profile.name}`       : null,
    profile.company   ? `Company: ${profile.company}` : null,
    profile.job_title ? `Role: ${profile.job_title}`  : null,
  ].filter(Boolean).join(' | ');

  const schema = { ...PERSONA_SCHEMA, metadata: { persona_created_at: now, last_updated_at: now } };

  const prompt = isFirstTime
    ? `Generate a user persona JSON for an AI assistant. Only populate fields you can confidently infer from the data. Use null or empty arrays for unknown fields. Output valid JSON only — no markdown, no explanation.

Schema: ${JSON.stringify(schema)}

Known data: ${knownData}
${transcriptSummary ? `Conversation summary: ${transcriptSummary}` : ''}`

    : `Update this user persona JSON for an AI assistant. Merge new information from the conversation summary into the existing persona. Keep all existing data unless directly contradicted. Do not remove fields. Update last_updated_at to "${now}". Output the complete updated JSON only — no markdown, no explanation.

Existing persona: ${JSON.stringify(existingPersona)}

Known data: ${knownData}
${transcriptSummary ? `New conversation summary: ${transcriptSummary}` : ''}`;

  console.log('[Profile] 🔍 Persona refresh triggered | isFirstTime:', isFirstTime);
  console.log('[Profile] 🔍 transcriptSummary:', transcriptSummary || '(none)');
  console.log('[Profile] 🔍 existing persona:', existingPersona ? JSON.stringify(existingPersona).slice(0, 150) + '…' : '(none)');

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 600,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!resp.ok) {
      console.error('[Profile] ❌ OpenAI error:', resp.status, await resp.text());
      return;
    }

    const data = await resp.json();
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) return;

    // Validate before saving — don't persist malformed JSON
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error('[Profile] ❌ OpenAI returned invalid JSON:', raw.slice(0, 200));
      return;
    }

    const summary = JSON.stringify(parsed);
    console.log('[Profile] 🔍 new persona:', summary.slice(0, 300) + (summary.length > 300 ? '…' : ''));

    await db.prepare(`
      UPDATE user_profiles
      SET persona_summary = ?, persona_updated_at = unixepoch(), updated_at = unixepoch()
      WHERE user_id = ? AND client_id = ?
    `).bind(summary, userId, clientId || '').run();

    console.log('[Profile] ✅ Persona', isFirstTime ? 'created' : 'updated', 'for user:', userId);
    await logEvent(db, clientId, 'openai_persona');
  } catch (err) {
    console.error('[Profile] ❌ Persona generation error:', err.message);
  }
}

// ── ANALYTICS HELPER ─────────────────────────────────────────────────────────
// Fire-and-forget usage event logger. Errors are swallowed so failures never
// propagate to the caller. Use ctx.waitUntil(logEvent(...)) in request handlers
// or bare await inside already-detached functions (e.g. refreshPersonaSummary).
async function logEvent(db, clientId, eventType) {
  try {
    await db.prepare(
      'INSERT INTO usage_events (client_id, event_type) VALUES (?, ?)'
    ).bind(clientId || '', eventType).run();
  } catch (err) {
    console.warn('[Analytics] logEvent failed silently:', eventType, err?.message);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // ── CORS ─────────────────────────────────────────────────────────────────
    // Allowed origins are stored in KV under 'wa_cors_origins' as a JSON map
    // of { "https://domain.com": "acct_xxx" }, populated during client onboarding.
    // If the key doesn't exist yet (fresh deploy), fall back to permissive mode
    // with a warning so live sites aren't broken during rollout.
    const requestOrigin = request.headers.get('Origin') || '';

    let allowedOrigin = null;
    let corsOrigins = {}; // hoisted — reused by auth routes to validate redirect origins
    const rawCorsOrigins = await env.CONFIGS.get('wa_cors_origins');
    if (rawCorsOrigins) {
      corsOrigins = JSON.parse(rawCorsOrigins);
      if (requestOrigin && corsOrigins[requestOrigin]) {
        allowedOrigin = requestOrigin;
      }
    } else {
      // wa_cors_origins missing — fail closed rather than open
      console.error('[CORS] ❌ wa_cors_origins not set in KV — all requests blocked');
      return new Response(JSON.stringify({ error: 'Service unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Admin routes bypass client-origin CORS — they're secured by ADMIN_SECRET instead.
    const isAdminRoute = url.pathname === '/dashboard' || url.pathname === '/dashboard/ask';

    const cors = {
      'Access-Control-Allow-Origin':  isAdminRoute ? (requestOrigin || '*') : (allowedOrigin || 'null'),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': (allowedOrigin || isAdminRoute) ? 'true' : 'false',
      'Content-Type':                 'application/json'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: (allowedOrigin || isAdminRoute) ? 204 : 403, headers: cors });
    }

    // Block credentialed requests from unrecognised origins (admin routes exempt)
    if (requestOrigin && !allowedOrigin && !isAdminRoute) {
      console.warn('[CORS] ❌ Blocked request from unrecognised origin:', requestOrigin);
      return json({ error: 'Origin not allowed', code: 'ORIGIN_NOT_ALLOWED' }, 403, cors);
    }

    // ── GET /health ───────────────────────────────────────��───
    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ ok: true, ts: Date.now() }, 200, cors);
    }

    // ── GET /config?id=acct_xxx ─────────────────────────────
    if (url.pathname === '/config' && request.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'Missing id', code: 'MISSING_PARAMS' }, 400, cors);

      const raw = await env.CONFIGS.get(id);
      if (!raw) return json({ error: 'Account not found', code: 'NOT_FOUND' }, 404, cors);

      // Allowlist fields safe to expose to the frontend.
      // Anything not listed here (notifyEmails, notifyPhone, allowedOrigin, etc.) is never returned.
      const FRONTEND_FIELDS = [
        'agentName', 'businessName',
        'dialogueAgentId', 'voiceAgentId',
        'avatar_url', 'greetingMessage', 'primaryColor',
        'debug', 'loadingStyle', 'suggestedPrompts', 'greetingBullets',
        // Ecommerce — opt-in only; platform determines which provider loads
        'ecomEnabled', 'ecomPlatform',
        // Shopify only — public Storefront API token (never Admin API keys)
        'shopifyToken', 'shopifyStoreDomain',
      ];
      const raw_config = JSON.parse(raw);
      const config = Object.fromEntries(
        FRONTEND_FIELDS.filter(k => k in raw_config).map(k => [k, raw_config[k]])
      );
      return json(config, 200, cors);
    }

    // ── POST /config ───────────────────────────────────────
    if (url.pathname === '/config' && request.method === 'POST') {
      // Admin-only route — requires Authorization: Bearer <ADMIN_SECRET>
      if (!env.ADMIN_SECRET) {
        console.error('[Config] ❌ ADMIN_SECRET is not set — POST /config is disabled');
        return json({ error: 'Server misconfiguration', code: 'SERVER_MISCONFIGURATION' }, 500, cors);
      }
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (token !== env.ADMIN_SECRET) {
        console.warn('[Config] ❌ Unauthorised write attempt');
        return json({ error: 'Unauthorised', code: 'UNAUTHORISED' }, 401, cors);
      }

      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'Missing id', code: 'MISSING_PARAMS' }, 400, cors);

      let body;
      try { body = await request.json(); } catch(e) {
        return json({ error: 'Invalid JSON', code: 'INVALID_JSON' }, 400, cors);
      }

      const raw = await env.CONFIGS.get(id);
      const config = raw ? JSON.parse(raw) : {};
      const updated = { ...config, ...body };

      await env.CONFIGS.put(id, JSON.stringify(updated));

      // Keep the cors origins map in sync whenever allowedOrigin is set
      if (updated.allowedOrigin) {
        const rawCors = await env.CONFIGS.get('wa_cors_origins');
        const corsMap = rawCors ? JSON.parse(rawCors) : {};
        corsMap[updated.allowedOrigin] = id;
        await env.CONFIGS.put('wa_cors_origins', JSON.stringify(corsMap));
        console.log('[Config] ✅ CORS origins updated:', updated.allowedOrigin, '→', id);
      }

      return json(updated, 200, cors);
    }

    // ── POST /greeting ────────────────────────────────────────────────────────
    // Generates a personalised one-sentence greeting using the user's profile.
    // Designed for low token usage: ~50 in, 40 out.
    if (url.pathname === '/greeting' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch(e) {
        return json({ error: 'Invalid JSON', code: 'INVALID_JSON' }, 400, cors);
      }

      const { user_id, page_title, time_of_day, last_session_snippet } = body || {};
      if (!user_id) return json({ greeting: null }, 200, cors);
      if (!env.OPENAI_KEY) return json({ greeting: null }, 200, cors);

      // Require a valid auth JWT — greeting queries profile PII and triggers OpenAI spend
      const greetingAuthHeader = request.headers.get('Authorization') || '';
      const greetingToken = greetingAuthHeader.startsWith('Bearer ') ? greetingAuthHeader.slice(7) : '';
      const greetingPayload = greetingToken ? await verifyJWT(greetingToken, env.JWT_SECRET) : null;
      if (!greetingPayload || greetingPayload.type !== 'auth') {
        return json({ greeting: null }, 200, cors);
      }

      try {
        const clientId = corsOrigins[requestOrigin] || '';

        // ── Greeting cache: one call per user per time window ─────────────────
        // Use the time_of_day sent by the frontend (browser local time) so the
        // cache key and prompt both reflect the user's actual timezone.
        // Validate against known values to prevent cache key manipulation.
        const VALID_WINDOWS = ['early_morning', 'morning', 'afternoon', 'evening', 'night'];
        const greetingWindow = VALID_WINDOWS.includes(time_of_day) ? time_of_day : (() => {
          const h = new Date().getUTCHours(); // UTC fallback if frontend omits time_of_day
          if (h < 7)  return 'early_morning';
          if (h < 12) return 'morning';
          if (h < 17) return 'afternoon';
          if (h < 20) return 'evening';
          return 'night';
        })();
        const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const cacheKey = `greeting:${user_id}:${today}:${greetingWindow}`;
        const cached = await env.CONFIGS.get(cacheKey);
        if (cached) {
          console.log('[Greeting] ✅ Cache hit for:', user_id, '| window:', greetingWindow);
          return json({ greeting: cached }, 200, cors);
        }

        // Fetch client config to get the website's business name
        const rawClientConfig = clientId ? await env.CONFIGS.get(clientId) : null;
        const clientConfig = rawClientConfig ? JSON.parse(rawClientConfig) : {};
        const businessName = clientConfig.businessName || '';

        const profile = await env.website_avatar_db.prepare(
          'SELECT name, company, persona_summary FROM user_profiles WHERE user_id = ? AND client_id = ?'
        ).bind(user_id, clientId).first();

        const rawFirstName = profile?.name?.split(' ')[0];
        if (!rawFirstName) return json({ greeting: null }, 200, cors);
        // Treat [User] as an uncaptured name — omit from the greeting rather than saying "User"
        const firstName = rawFirstName === '[User]' ? null : rawFirstName;

        const countRow = await env.website_avatar_db.prepare(
          'SELECT COUNT(*) as n FROM conversations WHERE user_id = ? AND client_id = ?'
        ).bind(user_id, clientId).first();
        const visits = countRow?.n || 1;

        // Build a persona snippet — prefer JSON interests/goals, fall back to raw summary
        let personaHint = '';
        if (profile.persona_summary) {
          try {
            const p = JSON.parse(profile.persona_summary);
            const interests = [p.goals, p.pain_points, p.interests].flat().filter(Boolean).slice(0, 2).join(', ');
            if (interests) personaHint = interests;
          } catch {
            personaHint = profile.persona_summary.slice(0, 80);
          }
        }

        const context = [
          firstName                ? `Name: ${firstName}` : null,
          `Time of day: ${time_of_day || 'day'}`,
          `Page they landed on: ${page_title || 'Homepage'}`,
          `Number of past visits: ${visits}`,
          personaHint              ? `What we know about them: ${personaHint}` : null,
          last_session_snippet     ? `Last visit they asked about: "${last_session_snippet}"` : null,
        ].filter(Boolean).join('\n');

        const nameRule = firstName
          ? `Use their first name.`
          : `Their name is not known — do not use a name or placeholder. Address them warmly without one.`;

        const lines = [
          `You are a warm, intelligent assistant for ${businessName || 'our website'}. Write a single short greeting for a returning visitor based on the context below.`,
          ``,
          context,
          ``,
          `Rules: one sentence only. ${nameRule} Reference the time of day naturally. If you know something relevant about their interests or last visit, weave it in — but keep it light, never surveillance-like. No exclamation marks. No flattery. No dashes or colons. Sound like a knowledgeable person who's genuinely pleased to see them, not a chatbot. Be creative with phrasing but stay professional.`,
          ``,
          `Examples of the right tone (use [Name], [time], [interest/topic] as stand-ins for real data):`,
          `"Good [time] [Name], hope we can point you in the right direction today."`,
          `"[Name], glad you're back this [time] — let us know what you're thinking about."`,
          `"Good [time], hope we can help you find what you're looking for."`,
          `"Good to see you back this [time] — let us know if [interest] is still on your mind."`,
        ];

        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.OPENAI_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            max_tokens: 60,
            temperature: 0.8,
            messages: [{ role: 'user', content: lines.join('\n') }]
          })
        });

        if (!resp.ok) return json({ greeting: null }, 200, cors);
        const data = await resp.json();
        const greeting = data.choices?.[0]?.message?.content?.trim() || null;

        console.log('[Greeting] ✅ Generated for:', firstName, '|', greeting);
        // Cache for the remainder of the time window (rough TTL in seconds)
        const windowTTLs = { early_morning: 7*3600, morning: 5*3600, afternoon: 5*3600, evening: 3*3600, night: 4*3600 };
        const ttl = windowTTLs[greetingWindow] || 3600;
        ctx.waitUntil(env.CONFIGS.put(cacheKey, greeting, { expirationTtl: ttl }));
        ctx.waitUntil(logEvent(env.website_avatar_db, clientId, 'openai_greeting'));
        return json({ greeting }, 200, cors);

      } catch (err) {
        console.error('[Greeting] ❌ Error:', err.message);
        return json({ greeting: null }, 200, cors);
      }
    }

    // ── POST /classify ────────────────────────────────────
    if (url.pathname === '/classify' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch(e) {
        return json({ error: 'Invalid JSON', code: 'INVALID_JSON' }, 400, cors);
      }

      const { prompt, maxTokens } = body;
      if (!prompt) return json({ error: 'Missing prompt', code: 'MISSING_PARAMS' }, 400, cors);

      // Require a recognised browser origin — rejects server-side callers who omit Origin
      if (!corsOrigins[requestOrigin]) {
        console.warn('[Classify] ❌ Request from unrecognised or missing origin:', requestOrigin || '(none)');
        return json({ error: 'Unauthorised', code: 'UNAUTHORISED' }, 401, cors);
      }

      // Debug — log prompt structure without slicing
      console.log('[Classify] 📏 chars:', prompt.length, '| maxTokens requested:', maxTokens || 60, '| origin:', requestOrigin);
      console.log('[Classify] 📄 full prompt:', prompt);

      // Hard cap — reject prompts that are unreasonably large
      const MAX_PROMPT_CHARS = 10000;
      const MAX_TOKENS_CAP   = 200;
      if (prompt.length > MAX_PROMPT_CHARS) {
        console.warn('[Classify] ❌ Prompt too long:', prompt.length, 'chars');
        return json({ error: 'Prompt too long', code: 'PROMPT_TOO_LONG' }, 400, cors);
      }

      const apiKey = env.OPENAI_KEY;
      if (!apiKey) return json({ error: 'No API key configured', code: 'SERVER_MISCONFIGURATION' }, 500, cors);

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({
          model:       'gpt-4o-mini',
          max_tokens:  Math.min(maxTokens || 60, MAX_TOKENS_CAP),
          temperature: 0,
          messages:    [{ role: 'user', content: prompt }]
        })
      });

      if (!response.ok) {
        return json({ error: 'Upstream API error', code: 'UPSTREAM_ERROR' }, 502, cors);
      }

      const data    = await response.json();
      const content = data.choices?.[0]?.message?.content || '';
      ctx.waitUntil(logEvent(env.website_avatar_db, corsOrigins[requestOrigin] || '', 'openai_classify'));
      return json({ content }, 200, cors);
    }

    // ── GET /session ──────────────────────────────────────────────
    // Two modes based on query param:
    //   ?session_id=<id>  — retrieve full client session state from KV
    //   ?user_id=<id>     — retrieve conversation history from D1 (used by session-sync.js)
    if (url.pathname === '/session' && request.method === 'GET') {
      const sessionId = url.searchParams.get('session_id');
      const userId    = url.searchParams.get('user_id');

      if (sessionId) {
        // Client session state (KV) — keyed with prefix to avoid collisions with config keys
        const raw = await env.CONFIGS.get(`session_${sessionId}`);
        if (!raw) return json({ fresh: true }, 200, cors);
        return new Response(raw, { headers: cors });
      }

      if (userId) {
        // Conversation transcript history (D1) — used by session-sync.js loadSessionFromBackend
        // user_id is always set: visitor ID for anonymous, authenticated_users.id after sign-in
        // If an auth token is present, verify it matches the requested user_id before returning data.
        // Anonymous requests (no token) are allowed through — scoped by client_id only.
        const sessionGetAuth = request.headers.get('Authorization') || '';
        const sessionGetToken = sessionGetAuth.startsWith('Bearer ') ? sessionGetAuth.slice(7) : '';
        if (sessionGetToken) {
          const sessionGetPayload = await verifyJWT(sessionGetToken, env.JWT_SECRET);
          if (!sessionGetPayload || sessionGetPayload.type !== 'auth' || sessionGetPayload.sub !== userId) {
            console.warn('[Session] ❌ JWT mismatch on GET for user:', userId);
            return json({ error: 'Unauthorised', code: 'UNAUTHORISED' }, 401, cors);
          }
        }

        // client_id resolved from CORS origin map — never trusted from caller
        const clientIdFilter = corsOrigins[requestOrigin] || '';
        console.log('[Session] GET request for user:', userId, '| client:', clientIdFilter || '(none)');
        try {
          const result = clientIdFilter
            ? await env.website_avatar_db.prepare(`
                SELECT conversation_id, client_id, transcript, analysis, created_at
                FROM conversations
                WHERE user_id = ? AND client_id = ?
                ORDER BY created_at DESC
                LIMIT 50
              `).bind(userId, clientIdFilter).all()
            : await env.website_avatar_db.prepare(`
                SELECT conversation_id, client_id, transcript, analysis, created_at
                FROM conversations
                WHERE user_id = ?
                ORDER BY created_at DESC
                LIMIT 50
              `).bind(userId).all();

          console.log('[Session] Found', result.results?.length || 0, 'sessions');

          if (!result.results || result.results.length === 0) {
            return json([], 200, cors);
          }

          const sessions = result.results.map(row => ({
            conversation_id: row.conversation_id,
            client_id:       row.client_id || '',
            transcript: typeof row.transcript === 'string' ? JSON.parse(row.transcript) : row.transcript,
            analysis:   typeof row.analysis  === 'string' ? JSON.parse(row.analysis)  : row.analysis,
            created_at: row.created_at
          }));

          console.log('[Session] ✅ Returning', sessions.length, 'sessions');
          return json(sessions, 200, cors);
        } catch (err) {
          console.error('[Session] ❌ GET error:', err);
          return json({ error: 'Database error', code: 'DB_ERROR' }, 500, cors);
        }
      }

      return json({ error: 'Missing session_id or user_id', code: 'MISSING_PARAMS' }, 400, cors);
    }

    // ── POST /session (frontend save) ─────────────────────────────
    // Route A: body.session_id (no user_id) → save full client session state to KV
    // Route B: body.user_id + body.conversation_id → save transcript to D1 (existing)
    if (url.pathname === '/session' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch(e) {
        return json({ error: 'Invalid JSON', code: 'INVALID_JSON' }, 400, cors);
      }

      // Route A: client session state → KV (session_id present, no user_id required)
      if (body?.session_id && !body?.user_id) {
        const sessionId   = body.session_id;
        const sessionData = body.session_data || {};
        try {
          // 24-hour TTL auto-expires idle sessions from KV
          await env.CONFIGS.put(`session_${sessionId}`, JSON.stringify(sessionData), {
            expirationTtl: 86400
          });
          console.log('[Session] ✅ KV state saved:', sessionId);
          return json({ message: 'Session state saved', session_id: sessionId }, 200, cors);
        } catch(err) {
          console.error('[Session] ❌ KV error:', err);
          return json({ error: 'KV error', code: 'KV_ERROR' }, 500, cors);
        }
      }

      // Route B: transcript save → D1 (requires user_id + conversation_id)
      // user_id is always set: visitor ID for anonymous, authenticated_users.id after sign-in
      const userId         = body?.user_id;
      const conversationId = body?.conversation_id;
      // client_id resolved from CORS origin map — never trusted from caller
      const clientId       = corsOrigins[requestOrigin] || '';

      // If an auth token is present, verify it matches the user_id before writing.
      // Anonymous requests (no token) are allowed through — scoped by client_id only.
      const sessionPostAuth = request.headers.get('Authorization') || '';
      const sessionPostToken = sessionPostAuth.startsWith('Bearer ') ? sessionPostAuth.slice(7) : '';
      if (sessionPostToken) {
        const sessionPostPayload = await verifyJWT(sessionPostToken, env.JWT_SECRET);
        if (!sessionPostPayload || sessionPostPayload.type !== 'auth' || sessionPostPayload.sub !== userId) {
          console.warn('[Session] ❌ JWT mismatch on POST for user:', userId);
          return json({ error: 'Unauthorised', code: 'UNAUTHORISED' }, 401, cors);
        }
      }

      console.log('[Session] Frontend save:', { userId, clientId, conversationId, messageCount: body?.transcript?.length });

      if (!userId || !conversationId) return json({ error: 'Missing user_id or conversation_id', code: 'MISSING_PARAMS' }, 400, cors);

      // Guard against oversized payloads — D1 rows have a ~1MB limit
      const MAX_TRANSCRIPT_BYTES = 900_000; // 900KB ceiling, leaves headroom for analysis
      let transcriptMessages = body.transcript || [];
      if (JSON.stringify(transcriptMessages).length > MAX_TRANSCRIPT_BYTES) {
        // Trim to the most recent 100 messages and log a warning
        transcriptMessages = transcriptMessages.slice(-100);
        console.warn('[Session] ⚠️ Transcript oversized — trimmed to last 100 messages:', conversationId);
      }
      const transcript = JSON.stringify(transcriptMessages);
      const analysis   = JSON.stringify(body.analysis || {});

      try {
        await env.website_avatar_db.prepare(`
          INSERT INTO conversations (user_id, conversation_id, client_id, transcript, analysis)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(conversation_id)
          DO UPDATE SET
            user_id    = excluded.user_id,
            client_id  = excluded.client_id,
            transcript = excluded.transcript,
            analysis   = excluded.analysis,
            created_at = CURRENT_TIMESTAMP
        `)
        .bind(userId, conversationId, clientId, transcript, analysis)
        .run();

        console.log('[Session] ✅ Saved to DB:', conversationId, '| client:', clientId);
        ctx.waitUntil(logEvent(env.website_avatar_db, clientId, 'session_started'));
        return json({ message: 'Session saved', conversation_id: conversationId, client_id: clientId }, 200, cors);
      } catch (err) {
        console.error('[Session] ❌ DB error:', err);
        return json({ error: 'Database error', code: 'DB_ERROR' }, 500, cors);
      }
    }

    // ── GET /profile?user_id=xxx ──────────────────────────────────────────────
    if (url.pathname === '/profile' && request.method === 'GET') {
      const userId   = url.searchParams.get('user_id');
      const clientId = corsOrigins[requestOrigin] || ''; // resolved server-side, not from caller
      if (!userId) return json({ error: 'Missing user_id', code: 'MISSING_PARAMS' }, 400, cors);

      // Require a valid auth token — profile contains PII
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      const payload = token ? await verifyJWT(token, env.JWT_SECRET) : null;
      if (!payload || payload.type !== 'auth' || payload.sub !== userId) {
        console.warn('[Profile] ❌ Unauthorised GET for user:', userId);
        return json({ error: 'Unauthorised', code: 'UNAUTHORISED' }, 401, cors);
      }

      try {
        const profile = await env.website_avatar_db.prepare(
          'SELECT user_id, client_id, name, phone, company, job_title, persona_summary, persona_updated_at, created_at, updated_at FROM user_profiles WHERE user_id = ? AND client_id = ?'
        ).bind(userId, clientId).first();

        return json(profile || {}, 200, cors);
      } catch (err) {
        console.error('[Profile] ❌ GET error:', err);
        return json({ error: 'Database error', code: 'DB_ERROR' }, 500, cors);
      }
    }

    // ── POST /profile ──────────────────────────────────────────────────────────
    // Upserts profile fields for an authenticated user.
    // Only fills blank columns — never overwrites existing data.
    // Triggers a persona_summary refresh via OpenAI after saving.
    if (url.pathname === '/profile' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch(e) {
        return json({ error: 'Invalid JSON', code: 'INVALID_JSON' }, 400, cors);
      }

      const { user_id, name, phone, company, job_title } = body || {};
      const clientId = corsOrigins[requestOrigin] || ''; // resolved server-side, not from caller
      if (!user_id) return json({ error: 'Missing user_id', code: 'MISSING_PARAMS' }, 400, cors);

      // Require a valid auth token — only a user can write their own profile
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      const payload = token ? await verifyJWT(token, env.JWT_SECRET) : null;
      if (!payload || payload.type !== 'auth' || payload.sub !== user_id) {
        console.warn('[Profile] ❌ Unauthorised POST for user:', user_id);
        return json({ error: 'Unauthorised', code: 'UNAUTHORISED' }, 401, cors);
      }

      try {
        await upsertUserProfile(env.website_avatar_db, user_id, clientId, { name, phone, company, job_title });
        console.log('[Profile] ✅ Upserted for user:', user_id, '| client:', clientId || '(none)');

        // Refresh persona summary in the background — doesn't block response
        ctx.waitUntil(refreshPersonaSummary(env.website_avatar_db, user_id, env, null, clientId));

        return json({ success: true, user_id }, 200, cors);
      } catch (err) {
        console.error('[Profile] ❌ POST error:', err);
        return json({ error: 'Database error', code: 'DB_ERROR' }, 500, cors);
      }
    }

    // ── GET /semantic?url=xxx ─────────────────────────────
    if (url.pathname === '/semantic' && request.method === 'GET') {
      const pageUrl = url.searchParams.get('url');
      if (!pageUrl) return json({ error: 'Missing "url" parameter', code: 'MISSING_PARAMS' }, 400, cors);
    
      try {
        console.log('[Semantic] Start analyzing', pageUrl);
    
        const fetchRes = await fetch(pageUrl);
        if (!fetchRes.ok) throw new Error(`Failed to fetch ${pageUrl}: ${fetchRes.status}`);
        const html = await fetchRes.text();
        const { document } = parseHTML(html);
    
        const pageTitle = document.querySelector('title')?.textContent?.trim() || '';
    
        // ── Helpers ─────────────────────────────
        const estimateTokens = text => text ? Math.ceil(text.length / 4) : 0;
    
        const compressText = (text, maxTokens = 50) => {
          if (!text) return '';
          const words = text.trim().split(/\s+/);
          const target = Math.floor(maxTokens * 0.75);
          if (words.length <= target) return text;
          const half = Math.floor(target / 2);
          return words.slice(0, half).join(' ') + ' [...] ' + words.slice(-half).join(' ');
        };
    
        const extractKeywords = (text, limit = 8) => {
          if (!text) return [];
          const stopWords = new Set([
            'the','be','to','of','and','a','in','that','have','i','it','for','not','on','with','he',
            'as','you','do','at','this','but','his','by','from','they','we','say','her','she','or',
            'an','will','my','one','all','would','there','their','what','so','up','out','if','about',
            'who','get','which','go','me','when','make','can','like','time','no','just','him','know',
            'take','people','into','year','your','good','some','could','them','see','other','than',
            'then','now','look','only','come','its','over','think','also','back','after','use','two',
            'how','our','work','first','well','way','even','new','want','because','any','these','give',
            'day','most','us'
          ]);
          const words = text.toLowerCase().replace(/[^\w\s]/g,' ').split(/\s+/)
            .filter(w => w.length > 3 && !stopWords.has(w));
          const freq = {};
          words.forEach(w => freq[w] = (freq[w] || 0) + 1);
          return Object.entries(freq).sort((a,b) => b[1]-a[1]).slice(0, limit).map(([word]) => word);
        };
    
        const resolveHref = href => {
          if (!href) return href;
          try { return new URL(href, pageUrl).href; } catch { return href; }
        };
    
        const extractLinks = element => {
          const links = [];
          const seen = new Set();
          const SKIP = [/^tel:/, /^mailto:/, /^javascript:/,
                        /whatsapp\.com/, /facebook\.com/, /twitter\.com/, /linkedin\.com/,
                        /instagram\.com/, /youtube\.com/, /tiktok\.com/,
                        /google\.com\/maps\/reviews/, /terms/, /privacy/, /cookies/];
          element.querySelectorAll('a[href]').forEach(a => {
            const raw = a.getAttribute('href') || '';
            if (!raw || raw === '#' || raw.endsWith('/#') || SKIP.some(p => p.test(raw))) return;
            const href = resolveHref(raw);
            const title = (a.textContent || '').trim().slice(0, 100);
            if (href && title && !seen.has(href)) { seen.add(href); links.push({ title, href }); }
          });
          return links;
        };
    
        const extractTextContent = element => {
          const clone = element.cloneNode(true);
          clone.querySelectorAll('script, style, nav, footer, [role="navigation"]').forEach(el => el.remove());
          return (clone.textContent || '').replace(/\s+/g,' ').trim();
        };
    
        const detectSectionType = element => {
          const cls = (element.getAttribute('class')||'').toLowerCase();
          const id = (element.getAttribute('id')||'').toLowerCase();
          const combined = cls + ' ' + id;
          const snippet = (element.textContent||'').toLowerCase().slice(0,200);
    
          if (combined.includes('hero') || (element.tagName==='HEADER' && element.querySelector('h1'))) return 'hero';
          if (combined.includes('nav') || element.tagName==='NAV') return 'navigation';
          if (combined.includes('footer') || element.tagName==='FOOTER') return 'footer';
          if (combined.includes('faq') || snippet.includes('frequently asked')) return 'faq';
          if (combined.includes('testimonial') || combined.includes('review')) return 'testimonials';
          if (combined.includes('pricing') || combined.includes('plan')) return 'pricing';
          if (combined.includes('feature')) return 'features';
          if (combined.includes('about')) return 'about';
          if (combined.includes('contact')) return 'contact';
          if (combined.includes('cta') || combined.includes('call-to-action')) return 'cta';
          if (element.querySelector('article') || combined.includes('blog') || combined.includes('post')) return 'article';
          if (element.querySelectorAll('li').length > 5 || combined.includes('list')) return 'listing';
          return 'content';
        };
    
        const discoverSubsections = (element, depth = 0, parentSectionId = '') => {
          if (depth > 2) return [];
          const subsections = [];
          const candidates = element.querySelectorAll('section, article, .article, div[class*="section"], div[class*="block"], div[class*="card"], li');
          const processed = new Set();

          candidates.forEach(candidate => {
            if (processed.has(candidate)) return;
            const textLength = (candidate.textContent || '').trim().length;
            if (textLength < 50) return;
            if (candidate === element) return;

            processed.add(candidate);
            candidate.querySelectorAll('*').forEach(c => processed.add(c));

            const heading = candidate.querySelector('h1, h2, h3, h4, h5, h6');
            const title = heading ? heading.textContent.trim() : '';
            const text = extractTextContent(candidate);

            if (text.length > 50) {
              const compressed = compressText(text, 30);
              const subId = candidate.id || `${parentSectionId}-sub-${subsections.length}`;
              subsections.push({
                id: subId,
                type: detectSectionType(candidate),
                title: title.slice(0, 100),
                summary: compressed,
                keywords: extractKeywords(text, 5),
                tokenCountOriginal: estimateTokens(text),
                tokenCountCompressed: estimateTokens(compressed),
                links: extractLinks(candidate)
              });
            }
          });

          return subsections;
        };
    
        // ── Section discovery ─────────────────────────
        const sections = [];
        const sectionCandidates = Array.from(document.querySelectorAll(
          'main section, main article, main > div, body > section, body > .section, body > article, [role="main"] > *'
        ));
    
        sectionCandidates.forEach((el,index) => {
          const text = extractTextContent(el);
          if (text.length < 100) return;
          const heading = el.querySelector('h1,h2,h3,h4,h5,h6');
          sections.push({
            id: el.getAttribute('id') || `section-${index}`,
            type: detectSectionType(el),
            title: heading ? heading.textContent.trim().slice(0,150) : '',
            summary: compressText(text,100),
            keywords: extractKeywords(text,8),
            tokenCountOriginal: estimateTokens(text),
            tokenCountCompressed: estimateTokens(compressText(text,100)),
            links: extractLinks(el),
            subsections: discoverSubsections(el, 0, el.getAttribute('id') || `section-${index}`),
            weight: 1.0
          });
        });
    
        const discovery = { page: { title: pageTitle, url: pageUrl, sections } };
        console.log('[Semantic] Total top-level sections:', sections.length);
        return json(discovery, 200, cors);
    
      } catch (err) {
        console.error('[Semantic] ❌ Error:', err);
        return json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500, cors);
      }
    }

    // ── GET /all-pages?url=xxx ─────────────────────────────
    if (url.pathname === '/all-pages' && request.method === 'GET') {
      const sitemapUrl = url.searchParams.get('url');
      if (!sitemapUrl) return json({ error: 'Missing "url" parameter', code: 'MISSING_PARAMS' }, 400, cors);

      try {
        console.log('[All-Pages] Fetching sitemap:', sitemapUrl);
        const allPages = await fetchSitemapUrls(sitemapUrl);

        return json({
          sitemap: sitemapUrl,
          totalUrls: allPages.length,
          urls: allPages
        }, 200, cors);

      } catch (err) {
        console.error('[All-Pages] ❌ Error:', err);
        return json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500, cors);
      }
    }

    // ── SHARED SITEMAP FETCHING FUNCTION ─────────────────────────────
    async function fetchSitemapUrls(sitemapUrl) {
      const seenUrls = new Set();

      async function fetchSitemap(u) {
        const res = await fetch(u);
        if (!res.ok) throw new Error(`Failed to fetch ${u}`);
        const xmlText = await res.text();
        const { document: doc } = parseHTML(xmlText);

        const urls = [];

        // Check if it's a sitemap index
        const sitemapIndex = doc.querySelectorAll('sitemap > loc');
        if (sitemapIndex.length > 0) {
          for (const locEl of sitemapIndex) {
            const loc = locEl.textContent.trim();
            if (!seenUrls.has(loc)) {
              seenUrls.add(loc);
              const nested = await fetchSitemap(loc);
              urls.push(...nested);
            }
          }
          return urls;
        }

        // Otherwise, assume it's a urlset
        const urlEls = doc.querySelectorAll('url > loc');
        for (const locEl of urlEls) {
          const loc = locEl.textContent.trim();
          if (loc && !seenUrls.has(loc)) {
            seenUrls.add(loc);
            urls.push(loc);
          }
        }

        return urls;
      }

      return await fetchSitemap(sitemapUrl);
    }

    // ── GET /semantic-sitemap?url=xxx ─────────────────────────────
    if (url.pathname === '/semantic-sitemap' && request.method === 'GET') {
      const sitemapUrl = url.searchParams.get('url');
      const limit = parseInt(url.searchParams.get('limit')) || 5;

      if (!sitemapUrl) return json({ error: 'Missing "url" parameter', code: 'MISSING_PARAMS' }, 400, cors);

      try {
        console.log('[Semantic-Sitemap] Fetching sitemap:', sitemapUrl);
        const allPages = await fetchSitemapUrls(sitemapUrl);
        
        console.log(`[Semantic-Sitemap] Found ${allPages.length} URLs, analyzing first ${limit}...`);
        const pagesToAnalyze = allPages.slice(0, limit);
        
        // ── Helpers (same as /semantic endpoint) ─────────────────────────────
        const estimateTokens = text => text ? Math.ceil(text.length / 4) : 0;

        const compressText = (text, maxTokens = 50) => {
          if (!text) return '';
          const words = text.trim().split(/\s+/);
          const target = Math.floor(maxTokens * 0.75);
          if (words.length <= target) return text;
          const half = Math.floor(target / 2);
          return words.slice(0, half).join(' ') + ' [...] ' + words.slice(-half).join(' ');
        };

        const extractKeywords = (text, limit = 8) => {
          if (!text) return [];
          const stopWords = new Set([
            'the','be','to','of','and','a','in','that','have','i','it','for','not','on','with','he',
            'as','you','do','at','this','but','his','by','from','they','we','say','her','she','or',
            'an','will','my','one','all','would','there','their','what','so','up','out','if','about',
            'who','get','which','go','me','when','make','can','like','time','no','just','him','know',
            'take','people','into','year','your','good','some','could','them','see','other','than',
            'then','now','look','only','come','its','over','think','also','back','after','use','two',
            'how','our','work','first','well','way','even','new','want','because','any','these','give',
            'day','most','us'
          ]);
          const words = text.toLowerCase().replace(/[^\w\s]/g,' ').split(/\s+/)
            .filter(w => w.length > 3 && !stopWords.has(w));
          const freq = {};
          words.forEach(w => freq[w] = (freq[w] || 0) + 1);
          return Object.entries(freq).sort((a,b) => b[1]-a[1]).slice(0, limit).map(([word]) => word);
        };

        const resolveHref = (href, baseUrl) => {
          if (!href) return href;
          try { return new URL(href, baseUrl).href; } catch { return href; }
        };

        const extractLinks = (element, baseUrl) => {
          const links = [];
          const seen = new Set();
          const SKIP = [/^tel:/, /^mailto:/, /^javascript:/,
                        /whatsapp\.com/, /facebook\.com/, /twitter\.com/, /linkedin\.com/,
                        /instagram\.com/, /youtube\.com/, /tiktok\.com/,
                        /google\.com\/maps\/reviews/, /terms/, /privacy/, /cookies/];
          element.querySelectorAll('a[href]').forEach(a => {
            const raw = a.getAttribute('href') || '';
            if (!raw || raw === '#' || raw.endsWith('/#') || SKIP.some(p => p.test(raw))) return;
            const href = resolveHref(raw, baseUrl);
            const title = (a.textContent || '').trim().slice(0, 100);
            if (href && title && !seen.has(href)) { seen.add(href); links.push({ title, href }); }
          });
          return links;
        };

        const extractTextContent = element => {
          const clone = element.cloneNode(true);
          clone.querySelectorAll('script, style, nav, footer, [role="navigation"]').forEach(el => el.remove());
          return (clone.textContent || '').replace(/\s+/g,' ').trim();
        };

        const detectSectionType = element => {
          const cls = (element.getAttribute('class')||'').toLowerCase();
          const id = (element.getAttribute('id')||'').toLowerCase();
          const combined = cls + ' ' + id;
          const snippet = (element.textContent||'').toLowerCase().slice(0,200);

          if (combined.includes('hero') || (element.tagName==='HEADER' && element.querySelector('h1'))) return 'hero';
          if (combined.includes('nav') || element.tagName==='NAV') return 'navigation';
          if (combined.includes('footer') || element.tagName==='FOOTER') return 'footer';
          if (combined.includes('faq') || snippet.includes('frequently asked')) return 'faq';
          if (combined.includes('testimonial') || combined.includes('review')) return 'testimonials';
          if (combined.includes('pricing') || combined.includes('plan')) return 'pricing';
          if (combined.includes('feature')) return 'features';
          if (combined.includes('about')) return 'about';
          if (combined.includes('contact')) return 'contact';
          if (combined.includes('cta') || combined.includes('call-to-action')) return 'cta';
          if (element.querySelector('article') || combined.includes('blog') || combined.includes('post')) return 'article';
          if (element.querySelectorAll('li').length > 5 || combined.includes('list')) return 'listing';
          return 'content';
        };

        const discoverSubsections = (element, baseUrl, depth = 0) => {
          if (depth > 2) return [];
          const subsections = [];
          let candidates;
          try { candidates = Array.from(element.querySelectorAll('section, article, .article, div[class*="section"], div[class*="block"], div[class*="card"], li')); } catch { return []; }
          const processed = new Set();

          candidates.forEach((candidate, idx) => {
            if (processed.has(candidate) || candidate===element || (candidate.textContent||'').trim().length < 50) return;
            processed.add(candidate); candidate.querySelectorAll('*')?.forEach(c => processed.add(c));

            const heading = candidate.querySelector('h1,h2,h3,h4,h5,h6');
            const title = heading ? heading.textContent.trim() : '';
            const text = extractTextContent(candidate);
            if (text.length <= 50) return;

            subsections.push({
              id: candidate.getAttribute('id') || `subsection-${idx}`,
              type: detectSectionType(candidate),
              title: title.slice(0,100),
              summary: compressText(text,30),
              keywords: extractKeywords(text,5),
              tokenCountOriginal: estimateTokens(text),
              tokenCountCompressed: estimateTokens(compressText(text,30)),
              links: extractLinks(candidate, baseUrl)
            });
          });

          return subsections;
        };

        const analyzedPages = [];
        
        for (const pageUrl of pagesToAnalyze) {
          try {
            console.log(`[Semantic-Sitemap] Analyzing: ${pageUrl}`);
            
            const fetchRes = await fetch(pageUrl);
            if (!fetchRes.ok) throw new Error(`Failed to fetch ${pageUrl}: ${fetchRes.status}`);
            const html = await fetchRes.text();
            const { document } = parseHTML(html);

            const pageTitle = document.querySelector('title')?.textContent?.trim() || '';

            // ── Section discovery ─────────────────────────
            const sections = [];
            
            // Try multiple strategies to find content sections
            let sectionCandidates = Array.from(document.querySelectorAll(
              'main section, main article, main > div, body > section, body > article, [role="main"] > *, article, .content, .post, .entry-content'
            ));
            
            // Fallback: if nothing found, look for any divs with substantial content
            if (sectionCandidates.length === 0) {
              sectionCandidates = Array.from(document.querySelectorAll('body > div, body section, body article'));
            }
            
            // Another fallback: find elements with headings
            if (sectionCandidates.length === 0) {
              const headings = Array.from(document.querySelectorAll('h1, h2, h3'));
              sectionCandidates = headings.map(h => h.parentElement).filter(Boolean);
            }

            const processedElements = new Set();
            
            sectionCandidates.forEach((el,index) => {
              // Skip if already processed or is a child of a processed element
              if (processedElements.has(el)) return;
              
              const text = extractTextContent(el);
              if (text.length < 100) return;
              
              // Mark this element and all its children as processed
              processedElements.add(el);
              el.querySelectorAll('*').forEach(child => processedElements.add(child));
              
              const heading = el.querySelector('h1,h2,h3,h4,h5,h6');
              sections.push({
                id: el.getAttribute('id') || `section-${index}`,
                type: detectSectionType(el),
                title: heading ? heading.textContent.trim().slice(0,150) : '',
                summary: compressText(text,100),
                keywords: extractKeywords(text,8),
                tokenCountOriginal: estimateTokens(text),
                tokenCountCompressed: estimateTokens(compressText(text,100)),
                links: extractLinks(el, pageUrl),
                subsections: discoverSubsections(el, pageUrl),
                weight: 1.0
              });
            });

            analyzedPages.push({
              page: {
                title: pageTitle,
                url: pageUrl,
                sections
              }
            });
            
            console.log(`[Semantic-Sitemap] ✓ ${pageUrl}: ${sections.length} sections`);
            
          } catch (pageErr) {
            console.error(`[Semantic-Sitemap] Failed to analyze ${pageUrl}:`, pageErr.message);
            analyzedPages.push({
              page: {
                title: '',
                url: pageUrl,
                sections: [],
                error: pageErr.message
              }
            });
          }
        }

        return json({
          sitemap: sitemapUrl,
          totalUrls: allPages.length,
          analyzedCount: analyzedPages.length,
          pages: analyzedPages
        }, 200, cors);

      } catch (err) {
        console.error('[Semantic-Sitemap] ❌ Error:', err);
        return json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500, cors);
      }
    }
    
    // ── POST /consent ─────────────────────────────────────────────
    if (url.pathname === '/consent' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) {
        return json({ error: 'Invalid JSON', code: 'INVALID_JSON' }, 400, cors);
      }

      const { visitor_id, consent_given } = body;
      const consentClientId = corsOrigins[requestOrigin] || ''; // resolved server-side, not from caller

      if (typeof visitor_id !== 'string' || visitor_id.trim() === '') {
        return json({ error: 'Missing or invalid visitor_id', code: 'MISSING_PARAMS' }, 400, cors);
      }
      if (typeof consent_given !== 'boolean') {
        return json({ error: 'consent_given must be a boolean', code: 'INVALID_PARAMS' }, 400, cors);
      }

      try {
        const result = await env.website_avatar_db
          .prepare(`INSERT INTO consent (visitor_id, consent_given, client_id) VALUES (?, ?, ?)`)
          .bind(visitor_id.trim(), consent_given ? 1 : 0, consentClientId)
          .run();

        return json({ success: true, id: result.meta.last_row_id }, 200, cors);
      } catch (e) {
        console.error('[Consent] DB error:', e.message);
        return json({ error: 'Database error', code: 'DB_ERROR' }, 500, cors);
      }
    }

    // ── POST /webhook/call-complete ─────────────────────────────
    if (url.pathname === '/webhook/call-complete' && request.method === 'POST') {
      // Read raw body first — signature verification must happen before JSON parsing
      // as request.json() consumes the stream.
      let rawBody;
      try { rawBody = await request.text(); } catch (e) {
        return json({ error: 'Failed to read request body', code: 'INVALID_REQUEST' }, 400, cors);
      }

      // ── Webhook signature verification ─────────────────────────────────────
      // Header format: ElevenLabs-Signature: t=<unix_ts>,v0=<hmac_sha256_hex>
      // Signed string: "<timestamp>.<raw_body>"
      if (!env.ELEVENLABS_WEBHOOK_SECRET) {
        console.error('[Webhook] ❌ ELEVENLABS_WEBHOOK_SECRET is not set — webhook disabled');
        return json({ error: 'Server misconfiguration', code: 'SERVER_MISCONFIGURATION' }, 500, cors);
      }

      const sigHeader = request.headers.get('ElevenLabs-Signature') || '';
      const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
      const timestamp = parts['t'];
      const signature = parts['v0'];

      if (!timestamp || !signature) {
        console.warn('[Webhook] ❌ Missing or malformed signature header');
        return json({ error: 'Missing signature', code: 'UNAUTHORISED' }, 401, cors);
      }

      // Reject requests older than 5 minutes to block replay attacks
      const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
      if (age > 300) {
        console.warn('[Webhook] ❌ Signature too old:', Math.round(age), 'seconds');
        return json({ error: 'Request too old', code: 'UNAUTHORISED' }, 401, cors);
      }

      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(env.ELEVENLABS_WEBHOOK_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`));
      const expected = Array.from(new Uint8Array(mac))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      if (expected !== signature) {
        console.warn('[Webhook] ❌ Signature mismatch');
        return json({ error: 'Invalid signature', code: 'UNAUTHORISED' }, 401, cors);
      }

      console.log('[Webhook] ✅ Signature verified');

      try {
        const callData = JSON.parse(rawBody);
        const convId = callData.data?.conversation_id || 'unknown';
        console.log('[Webhook] Received call data | conv:', convId);

        // Idempotency guard — ElevenLabs may retry if the first request times out.
        // Write the processed key before doing any work so retries are blocked even
        // if the Worker crashes partway through (a skipped notification is better
        // than a duplicate lead firing to the client).
        const idempotencyKey = `webhook_processed_${convId}`;
        const alreadyProcessed = await env.CONFIGS.get(idempotencyKey);
        if (alreadyProcessed) {
          console.log('[Webhook] ⚠️ Duplicate webhook detected — already processed:', convId);
          return json({ message: 'Already processed' }, 200, cors);
        }
        await env.CONFIGS.put(idempotencyKey, '1', { expirationTtl: 86400 }); // 24h TTL

        const analysis = callData.data.analysis || {};
        const metadata = callData.data.metadata || {};

        // Only process successful calls
        if (analysis.call_successful !== 'success') {
          console.log('[Webhook] Skipping - call not successful | conv:', convId);
          return json({ message: 'Call not successful, skipping notifications' }, 200, cors);
        }
        const collectedData = analysis.data_collection_results || {};

        // Extract data
        const name = collectedData['Name']?.value || 'Unknown';
        const phone = collectedData['Phone Number']?.value || 'Not provided';
        const email = collectedData['Email Address']?.value || 'Not provided';
        const company = collectedData['Company Name']?.value || 'Not provided';
        const callSummary = analysis.call_summary_title || 'No summary';
        const transcriptSummary = analysis.transcript_summary || null;
        const callDuration = metadata?.call_duration_secs
          ? `${Math.floor(metadata.call_duration_secs / 60)}m ${metadata.call_duration_secs % 60}s`
          : 'Unknown';

        // ── Resolve authenticated user ──────────────────────────────────────
        // Done first — before any hasValidData gate — so that persona refresh
        // runs for every successful call from a signed-in user, regardless of
        // whether contact details were spoken. We already have their data.
        // Resolve the authenticated user via three paths (in priority order):
        //
        // 1. authenticated_user_id dynamic variable — set explicitly by the
        //    client at session start (null for guests, UUID for signed-in users).
        //    Most reliable: works even if the user never speaks their email.
        //
        // 2. user_id dynamic variable — legacy/fallback, may be a wc_visitor ID
        //    or an authenticated UUID depending on auth state at connect time.
        //    UUID format check distinguishes them.
        //
        // 3. Spoken email from data_collection_results — last resort, fragile
        //    (speech-to-text errors, user may give a different address).
        const dynVars = callData.data?.conversation_initiation_client_data?.dynamic_variables || {};

        // ── Resolve client_id early — dynVar may be missing if session raced ahead ──
        let resolvedClientId = dynVars.client_id || '';
        if (!resolvedClientId && conversationId) {
          try {
            const convRow = await env.website_avatar_db.prepare(
              'SELECT client_id FROM conversations WHERE conversation_id = ? LIMIT 1'
            ).bind(conversationId).first();
            if (convRow?.client_id) {
              resolvedClientId = convRow.client_id;
              console.log('[Webhook] 🔍 Resolved client_id from DB fallback:', resolvedClientId);
            }
          } catch (e) {
            console.warn('[Webhook] ⚠️ DB fallback for client_id failed:', e.message);
          }
        }

        try {

          // ── DEBUG: log everything we received so we can trace resolution ──
          console.log('[Webhook] 🔍 DEBUG conversation:', convId);
          console.log('[Webhook] 🔍 authenticated_user_id (dynVar):', dynVars.authenticated_user_id ?? '(missing)');
          console.log('[Webhook] 🔍 user_id (dynVar):', dynVars.user_id ?? '(missing)');
          console.log('[Webhook] 🔍 spoken email:', email);
          console.log('[Webhook] 🔍 spoken name:', name);
          console.log('[Webhook] 🔍 transcript_summary:', transcriptSummary || '(none)');

          let authUserId = null;
          let resolvedVia = null;

          // Path 1: dedicated authenticated_user_id variable (explicit, preferred)
          const explicitId = dynVars.authenticated_user_id;
          if (explicitId && typeof explicitId === 'string' && explicitId !== 'null') {
            const row = await env.website_avatar_db
              .prepare('SELECT id FROM authenticated_users WHERE id = ?')
              .bind(explicitId)
              .first();
            if (row) { authUserId = row.id; resolvedVia = 'authenticated_user_id dynVar'; }
          }

          // Path 2: user_id variable — only if it looks like a UUID (not wc_visitor)
          if (!authUserId) {
            const sessionUserId = dynVars.user_id;
            const isUuid = typeof sessionUserId === 'string' &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionUserId);
            if (isUuid) {
              const row = await env.website_avatar_db
                .prepare('SELECT id FROM authenticated_users WHERE id = ?')
                .bind(sessionUserId)
                .first();
              if (row) { authUserId = row.id; resolvedVia = 'user_id dynVar (UUID match)'; }
            }
          }

          // Path 3: spoken email from data_collection_results
          if (!authUserId && email !== 'Not provided' && email.includes('@')) {
            const row = await env.website_avatar_db
              .prepare('SELECT id FROM authenticated_users WHERE email = ?')
              .bind(email)
              .first();
            if (row) { authUserId = row.id; resolvedVia = 'spoken email match'; }
          }

          console.log('[Webhook] 🔍 Resolved user:', authUserId ?? 'NONE', '| via:', resolvedVia ?? 'no path matched');

          if (authUserId) {
            // Always upsert any new contact fields collected this call.
            // overwrite=true: webhook data from a verified call should update existing fields.
            await upsertUserProfile(env.website_avatar_db, authUserId, resolvedClientId, {
              name:    name    !== 'Unknown'      ? name    : null,
              phone:   phone   !== 'Not provided' ? phone   : null,
              company: company !== 'Not provided' ? company : null,
            }, true);
            console.log('[Webhook] ✅ Profile upserted for user:', authUserId, '| client:', resolvedClientId || '(none)');
            // Only refresh persona if the call had enough substance to improve it
            const callDurationSecs = callData.data?.metadata?.call_duration_secs || 0;
            const agentTurns = dynVars.system__agent_turns || 0;
            const hasSubstance = callDurationSecs >= 60 && agentTurns >= 3;
            if (hasSubstance) {
              ctx.waitUntil(refreshPersonaSummary(env.website_avatar_db, authUserId, env, transcriptSummary, resolvedClientId));
            } else {
              console.log('[Webhook] ⏭️ Skipping persona refresh — low substance call | duration:', callDurationSecs + 's', '| turns:', agentTurns);
            }
          } else {
            console.log('[Webhook] ℹ️ No authenticated user resolved — guest call, skipping profile update');
          }
        } catch (profileErr) {
          console.error('[Webhook] ❌ Profile upsert error:', profileErr.message);
        }

        // ── Resolve client config for per-client notification routing ──────────
        const clientId = resolvedClientId;
        let clientConfig = {};
        if (clientId) {
          try {
            const raw = await env.CONFIGS.get(clientId);
            if (raw) clientConfig = JSON.parse(raw);
          } catch (e) {
            console.warn('[Webhook] ⚠️ Could not load client config for:', clientId);
          }
        }
        // Notification values — per-client config with Pod Digital as fallback
        const notifyEmails  = clientConfig.notifyEmails  || ['jacob@poddigital.co.uk', 'mike@poddigital.co.uk'];
        const notifyPhone   = clientConfig.notifyPhone   || '+447468621246';
        const businessName  = clientConfig.businessName  || 'Pod Digital';
        console.log('[Webhook] 📋 Routing notifications | client:', clientId || '(none)', '| brand:', businessName);

        // ── Lead notifications ─────────────────────────────────────────────
        // Only fire when the user spoke their name and email — these go to
        // Google Sheet, admin email/SMS, and a thank-you to the user.
        // Persona refresh above is intentionally separate and always runs.
        const hasValidData = (name !== 'Unknown') && (email !== 'Not provided' && email.includes('@'));

        // ── Persist transcript_summary to the conversations row ──────────────
        // Runs for every successful call. Merges into the existing row if the
        // frontend has already saved it, or creates a placeholder if not yet.
        const summary = transcriptSummary || analysis.call_summary_title || null;
        if (summary) {
          ctx.waitUntil((async () => {
            try {
              const existing = await env.website_avatar_db.prepare(
                'SELECT analysis FROM conversations WHERE conversation_id = ? LIMIT 1'
              ).bind(convId).first();

              if (existing) {
                let analysisObj = {};
                try { analysisObj = JSON.parse(existing.analysis || '{}'); } catch { /* ignore */ }
                analysisObj.transcript_summary = summary;
                if (analysis.call_summary_title) analysisObj.call_summary_title = analysis.call_summary_title;
                await env.website_avatar_db.prepare(
                  'UPDATE conversations SET analysis = ? WHERE conversation_id = ?'
                ).bind(JSON.stringify(analysisObj), convId).run();
                console.log('[Webhook] ✅ transcript_summary saved:', summary);
              } else {
                // Row not yet created by frontend — insert placeholder so summary isn't lost
                const placeholderUserId = dynVars.authenticated_user_id || dynVars.user_id || 'unknown';
                await env.website_avatar_db.prepare(`
                  INSERT INTO conversations (user_id, conversation_id, client_id, transcript, analysis)
                  VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(conversation_id) DO UPDATE SET analysis = excluded.analysis
                `).bind(
                  placeholderUserId, convId, resolvedClientId || '', '[]',
                  JSON.stringify({ transcript_summary: summary, call_summary_title: analysis.call_summary_title || null })
                ).run();
                console.log('[Webhook] ✅ Placeholder row created with summary');
              }
            } catch (err) {
              console.warn('[Webhook] ⚠️ Failed to save transcript_summary:', err.message);
            }
          })());
        }

        if (!hasValidData) {
          console.log('[Webhook] ℹ️ No contact data spoken — skipping lead notifications');
          ctx.waitUntil(logEvent(env.website_avatar_db, clientId, 'webhook_call_complete'));
          return json({ message: 'Webhook processed — persona updated, no lead notifications' }, 200, cors);
        }

        console.log('[Webhook] Processing lead notifications for:', name);

        try {
          await appendToSheet({ name, phone, email, company, callSummary, callDuration }, env);
          console.log('[Webhook] ✅ Lead written to Google Sheet');
        } catch (sheetErr) {
          console.error('[Webhook] ❌ Sheet error:', sheetErr.message);
        }

        try {
          const adminEmailHtml = generateAdminEmail({ name, phone, email, company, callSummary, callDuration });
          await sendEmail({
            from: env.FROM_EMAIL || 'mail@websiteavatar.co.uk',
            to: notifyEmails,
            subject: `New Website Avatar Lead: ${name}`,
            html: adminEmailHtml
          }, env);
          console.log('[Webhook] ✅ Admin email sent to:', notifyEmails);
        } catch (emailErr) {
          console.error('[Webhook] ❌ Admin email error:', emailErr.message);
        }

        try {
          const smsBody = `New Website Avatar Lead!\nName: ${name}\nCompany: ${company}\nPhone: ${phone}\nEmail: ${email}\nSummary: ${callSummary}`;
          if (env.ADMIN_PHONE_NUMBER) await sendSMS({ to: env.ADMIN_PHONE_NUMBER, body: smsBody }, env);
          await sendSMS({ to: notifyPhone, body: smsBody }, env);
          console.log('[Webhook] ✅ Admin SMS sent');
        } catch (smsErr) {
          console.error('[Webhook] ❌ Admin SMS error:', smsErr.message);
        }

        try {
          const thankYouHtml = generateThankYouEmail({ name, businessName });
          await sendEmail({
            from: env.FROM_EMAIL || 'mail@websiteavatar.co.uk',
            to: email,
            subject: `Thank you for contacting ${businessName}`,
            html: thankYouHtml
          }, env);
          console.log('[Webhook] ✅ Thank you email sent to:', email);
        } catch (thankYouErr) {
          console.error('[Webhook] ❌ Thank you email error:', thankYouErr.message);
        }

        ctx.waitUntil(logEvent(env.website_avatar_db, clientId, 'webhook_call_complete'));
        return json({
          message: 'Webhook processed successfully',
          client: clientId,
          adminEmails: notifyEmails,
          adminSMS: notifyPhone,
          userEmail: email
        }, 200, cors);

      } catch (err) {
        console.error('[Webhook] ❌ Critical error:', err);
        return json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500, cors);
      }
    }
    
    // ── POST /auth/magic-link ──────────────────────────────────────
    if (url.pathname === '/auth/magic-link' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) {
        return json({ error: 'Invalid JSON', code: 'INVALID_JSON' }, 400, cors);
      }

      const { email, visitor_id, conversation_id, origin } = body;

      if (!email || !email.includes('@')) return json({ error: 'Invalid email', code: 'INVALID_PARAMS' }, 400, cors);
      if (!visitor_id) return json({ error: 'Missing visitor_id', code: 'MISSING_PARAMS' }, 400, cors);
      if (!env.JWT_SECRET) return json({ error: 'Server misconfiguration', code: 'SERVER_MISCONFIGURATION' }, 500, cors);

      // Validate origin against known client domains before embedding in JWT.
      // Prevents an attacker crafting a magic link request with a malicious redirect URL.
      // The frontend sends window.location.href (full URL) so we extract its origin for
      // comparison, but embed the full URL so the user lands back on the exact page.
      const knownOrigins = Object.keys(corsOrigins);
      const originHost = (() => { try { return new URL(origin).origin; } catch { return null; } })();
      const safeOrigin = (originHost && knownOrigins.includes(originHost)) ? origin : (env.APP_URL || null);
      if (!safeOrigin) {
        console.warn('[Auth] ❌ Magic link request with unrecognised origin:', origin);
        return json({ error: 'Unrecognised origin', code: 'ORIGIN_NOT_ALLOWED' }, 400, cors);
      }

      const appUrl = env.APP_URL || safeOrigin;
      const fromEmail = env.FROM_EMAIL || 'mail@websiteavatar.co.uk';

      try {
        const token = await generateMagicToken(email, conversation_id || '', visitor_id, safeOrigin, env.JWT_SECRET);
        const magicUrl = `${new URL('/auth/verify', request.url).href}?token=${token}`;

        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Sign in to Website Avatar</title>
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f4f3f7; }
    .container { max-width: 600px; margin: 40px auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
    .header { background-color: #072138; padding: 32px 24px; text-align: center; border-radius: 12px 12px 0 0; }
    .header h1 { color: #ffffff; margin: 0; font-size: 24px; }
    .content { padding: 40px 24px; }
    .message { font-size: 16px; line-height: 1.6; color: #374151; margin-bottom: 24px; }
    .btn { display: inline-block; background-color: #3C82F6; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-size: 16px; font-weight: 600; }
    .note { font-size: 13px; color: #9ca3af; margin-top: 24px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>Website Avatar</h1></div>
    <div class="content">
      <p class="message">Click the button below to sign in and save your conversation. This link expires in 1 hour.</p>
      <a href="${magicUrl}" class="btn">Sign in &amp; save conversation</a>
      <p class="note">If you didn't request this, you can safely ignore this email.</p>
    </div>
  </div>
</body>
</html>`;

        await sendEmail({
          from: fromEmail,
          to: email,
          subject: 'Your sign-in link for Website Avatar',
          html
        }, env);

        console.log('[Auth] Magic link sent to:', email);
        return json({ success: true }, 200, cors);
      } catch (err) {
        console.error('[Auth] Magic link error:', err);
        return json({ error: 'Failed to send email', code: 'UPSTREAM_ERROR' }, 500, cors);
      }
    }

    // ── GET /auth/verify?token=xxx ─────────────────────────────────
    if (url.pathname === '/auth/verify' && request.method === 'GET') {
      const token = url.searchParams.get('token');
      if (!token) return new Response('Missing token', { status: 400 });
      if (!env.JWT_SECRET) return new Response('Server misconfigured', { status: 500 });

      const payload = await verifyJWT(token, env.JWT_SECRET);
      if (!payload || payload.type !== 'magic') {
        return new Response(errorPage('This sign-in link is invalid or has expired. Please request a new one.'), {
          status: 400,
          headers: { 'Content-Type': 'text/html' }
        });
      }

      const { email, visitorId, origin } = payload;

      try {
        // Create or find authenticated user
        const userId = crypto.randomUUID();
        const now = Date.now();

        // visitor_id is only stored on first sign-in — it's the bridge to the consent table.
        // On subsequent sign-ins we only update last_login; visitor_id stays as originally set.
        await env.website_avatar_db.prepare(`
          INSERT INTO authenticated_users (id, email, created_at, last_login, visitor_id)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(email) DO UPDATE SET last_login = ?
        `).bind(userId, email, now, now, visitorId || null, now).run();

        // Get actual user ID (may differ if user already existed)
        const userRow = await env.website_avatar_db.prepare(
          `SELECT id FROM authenticated_users WHERE email = ?`
        ).bind(email).first();
        const authUserId = userRow?.id || userId;

        // Migrate all anonymous sessions for this visitor to the authenticated user.
        // user_id currently holds the wc_visitor value for anonymous sessions —
        // replace it with the permanent authenticated user ID.
        if (visitorId) {
          await env.website_avatar_db.prepare(`
            UPDATE conversations
            SET user_id = ?, visitor_id = user_id
            WHERE user_id = ?
          `).bind(authUserId, visitorId).run();
          console.log('[Auth] Migrated sessions for visitor:', visitorId, '→ user:', authUserId);
        }

        // Generate 30-day auth token
        const authToken = await generateAuthToken(authUserId, email, env.JWT_SECRET);

        // Validate the redirect origin from the JWT payload against known client domains.
        // The origin was already validated when the magic link was issued, but we
        // re-check here as a second line of defence in case of token reuse or tampering.
        // Extract the host from the full URL for comparison, but redirect to the full URL.
        const knownOrigins = Object.keys(corsOrigins);
        const originHost = (() => { try { return new URL(origin).origin; } catch { return null; } })();
        const verifiedOrigin = (originHost && knownOrigins.includes(originHost))
          ? origin
          : (env.APP_URL || null);
        if (!verifiedOrigin) {
          console.warn('[Auth] ❌ Unrecognised redirect origin in JWT payload:', origin);
          return new Response(errorPage('Invalid sign-in link. Please request a new one.'), {
            status: 400,
            headers: { 'Content-Type': 'text/html' }
          });
        }

        // Redirect back to origin with auth token in hash
        const redirectBase = verifiedOrigin.split('#')[0];
        const redirectUrl = `${redirectBase}#wa_auth=${authToken}`;

        console.log('[Auth] User authenticated:', email, '| Redirecting to origin');
        return Response.redirect(redirectUrl, 302);

      } catch (err) {
        console.error('[Auth] Verify error:', err);
        return new Response(errorPage('Something went wrong. Please try again.'), {
          status: 500,
          headers: { 'Content-Type': 'text/html' }
        });
      }
    }

    // ── GET /dashboard ────────────────────────────────────────────────────────
    // Admin-only usage analytics for a single client account.
    // Query params:
    //   client_id (required) — the acct_xxx identifier
    //   days      (optional, default 30, max 365) — lookback window
    if (url.pathname === '/dashboard' && request.method === 'GET') {
      if (!env.ADMIN_SECRET) {
        return json({ error: 'Server misconfiguration', code: 'SERVER_MISCONFIGURATION' }, 500, cors);
      }
      const dashAuthHeader = request.headers.get('Authorization') || '';
      const dashToken = dashAuthHeader.startsWith('Bearer ') ? dashAuthHeader.slice(7) : '';
      if (dashToken !== env.ADMIN_SECRET) {
        return json({ error: 'Unauthorised', code: 'UNAUTHORISED' }, 401, cors);
      }

      const dashClientId = url.searchParams.get('client_id');
      if (!dashClientId) {
        return json({ error: 'Missing client_id', code: 'MISSING_PARAMS' }, 400, cors);
      }

      const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10), 1), 365);
      const sinceEpoch = Math.floor(Date.now() / 1000) - (days * 86400);

      try {
        const [
          summaryResult,
          dailyResult,
          sessionResult,
          dailySessionsResult,
          leadsResult,
          recentConvsResult,
          leadQualityResult,
          returningResult,
        ] = await Promise.all([
          // Event totals from usage_events
          env.website_avatar_db.prepare(`
            SELECT event_type, COUNT(*) AS total
            FROM usage_events
            WHERE client_id = ? AND created_at >= ?
            GROUP BY event_type
          `).bind(dashClientId, sinceEpoch).all(),

          // Daily event breakdown from usage_events
          env.website_avatar_db.prepare(`
            SELECT date(created_at, 'unixepoch') AS day, event_type, COUNT(*) AS count
            FROM usage_events
            WHERE client_id = ? AND created_at >= ?
            GROUP BY day, event_type
            ORDER BY day ASC
          `).bind(dashClientId, sinceEpoch).all(),

          // Session/visitor totals from conversations (authoritative source)
          env.website_avatar_db.prepare(`
            SELECT COUNT(*) AS total_sessions, COUNT(DISTINCT user_id) AS unique_visitors
            FROM conversations
            WHERE client_id = ? AND created_at >= datetime(?, 'unixepoch')
          `).bind(dashClientId, sinceEpoch).first(),

          // Daily session breakdown from conversations
          env.website_avatar_db.prepare(`
            SELECT date(created_at) AS day, COUNT(*) AS sessions, COUNT(DISTINCT user_id) AS visitors
            FROM conversations
            WHERE client_id = ? AND created_at >= datetime(?, 'unixepoch')
            GROUP BY day
            ORDER BY day ASC
          `).bind(dashClientId, sinceEpoch).all(),

          // Panel A — Known leads: profiles with at least a name or email
          env.website_avatar_db.prepare(`
            SELECT p.user_id, p.name, p.company, p.job_title, p.phone,
                   u.email, u.last_login,
                   MAX(c.created_at) AS last_seen,
                   COUNT(c.id) AS total_sessions
            FROM user_profiles p
            LEFT JOIN authenticated_users u ON u.id = p.user_id
            LEFT JOIN conversations c ON c.user_id = p.user_id AND c.client_id = p.client_id
            WHERE p.client_id = ?
              AND (p.name IS NOT NULL OR u.email IS NOT NULL)
            GROUP BY p.user_id
            ORDER BY last_seen DESC
            LIMIT 50
          `).bind(dashClientId).all(),

          // Panel B — Recent conversations with summary
          env.website_avatar_db.prepare(`
            SELECT c.id, c.user_id, c.created_at, c.analysis,
                   p.name AS user_name, u.email AS user_email
            FROM conversations c
            LEFT JOIN user_profiles p ON p.user_id = c.user_id AND p.client_id = c.client_id
            LEFT JOIN authenticated_users u ON u.id = c.user_id
            WHERE c.client_id = ?
            ORDER BY c.created_at DESC
            LIMIT 30
          `).bind(dashClientId).all(),

          // Panel C — Lead quality: how many profiles have each contact field
          env.website_avatar_db.prepare(`
            SELECT
              COUNT(*) AS total_profiles,
              SUM(CASE WHEN u.email IS NOT NULL THEN 1 ELSE 0 END) AS has_email,
              SUM(CASE WHEN p.phone IS NOT NULL AND p.phone != '' THEN 1 ELSE 0 END) AS has_phone,
              SUM(CASE WHEN p.company IS NOT NULL AND p.company != '' THEN 1 ELSE 0 END) AS has_company,
              SUM(CASE WHEN p.name IS NOT NULL AND p.name != '' THEN 1 ELSE 0 END) AS has_name,
              SUM(CASE WHEN p.persona_summary IS NOT NULL THEN 1 ELSE 0 END) AS has_persona
            FROM user_profiles p
            LEFT JOIN authenticated_users u ON u.id = p.user_id
            WHERE p.client_id = ?
          `).bind(dashClientId).first(),

          // Panel F — Returning vs new: users with >1 conversation in the window
          env.website_avatar_db.prepare(`
            SELECT
              COUNT(DISTINCT user_id) AS total_visitors,
              SUM(CASE WHEN session_count > 1 THEN 1 ELSE 0 END) AS returning_visitors,
              SUM(CASE WHEN session_count = 1 THEN 1 ELSE 0 END) AS new_visitors
            FROM (
              SELECT user_id, COUNT(*) AS session_count
              FROM conversations
              WHERE client_id = ? AND created_at >= datetime(?, 'unixepoch')
              GROUP BY user_id
            )
          `).bind(dashClientId, sinceEpoch).first(),
        ]);

        const summary = {};
        for (const row of (summaryResult.results || [])) {
          summary[row.event_type] = row.total;
        }

        // Parse analysis JSON for recent conversations
        const recentConvs = (recentConvsResult.results || []).map(c => {
          let conv_summary = null;
          let msg_count = null;
          try {
            const a = JSON.parse(c.analysis || '{}');
            conv_summary = a.transcript_summary || a.call_summary_title || null;
            msg_count = a.messageCount || null;
          } catch { /* ignore */ }
          return {
            id:           c.id,
            user_id:      c.user_id,
            user_name:    c.user_name || null,
            user_email:   c.user_email || null,
            created_at:   c.created_at,
            conv_summary,
            msg_count,
          };
        });

        return json({
          client_id:      dashClientId,
          days,
          summary,
          daily_events:   dailyResult.results    || [],
          sessions: {
            total:  sessionResult?.total_sessions  || 0,
            unique: sessionResult?.unique_visitors || 0,
          },
          daily_sessions:  dailySessionsResult.results || [],
          leads:           leadsResult.results || [],
          recent_convs:    recentConvs,
          lead_quality:    leadQualityResult || {},
          returning: {
            total:     returningResult?.total_visitors    || 0,
            returning: returningResult?.returning_visitors || 0,
            new:       returningResult?.new_visitors       || 0,
          },
        }, 200, cors);

      } catch (err) {
        console.error('[Dashboard] ❌ Error:', err);
        return json({ error: 'Database error', code: 'DB_ERROR' }, 500, cors);
      }
    }

    // ── POST /dashboard/ask ───────────────────────────────────────────────────
    // LLM query over pre-aggregated client data (Option B).
    // Runs multiple targeted D1 queries to build a rich analytics context,
    // then asks gpt-4o-mini to answer the question against that context.
    if (url.pathname === '/dashboard/ask' && request.method === 'POST') {
      if (!env.ADMIN_SECRET || !env.OPENAI_KEY) {
        return json({ error: 'Server misconfiguration' }, 500, cors);
      }
      const askAuth = request.headers.get('Authorization') || '';
      if (askAuth.slice(7) !== env.ADMIN_SECRET) {
        return json({ error: 'Unauthorised' }, 401, cors);
      }

      const { client_id, question, days: askDays = 30 } = await request.json().catch(() => ({}));
      if (!client_id || !question?.trim()) {
        return json({ error: 'Missing client_id or question' }, 400, cors);
      }

      const lookback = Math.min(Math.max(parseInt(askDays, 10) || 30, 1), 90);
      const sinceEpoch = Math.floor(Date.now() / 1000) - (lookback * 86400);

      // ── Parallel D1 queries ───────────────────────────────────────────────
      const PERSONA_FIELDS = ['pain_points', 'interests', 'goals', 'needs', 'budget_signals'];

      const [profileRows, convRows, usageRows, engagementRow, leadQualRow, returningRow] = await Promise.all([
        // Profiles — raised cap to 50, include session count per user
        env.website_avatar_db.prepare(`
          SELECT p.user_id, p.name, p.phone, p.company, p.job_title, p.persona_summary,
                 u.email,
                 COUNT(c.id) AS session_count,
                 MAX(c.created_at) AS last_seen
          FROM user_profiles p
          LEFT JOIN authenticated_users u ON u.id = p.user_id
          LEFT JOIN conversations c ON c.user_id = p.user_id AND c.client_id = p.client_id
          WHERE p.client_id = ?
          GROUP BY p.user_id
          ORDER BY last_seen DESC
          LIMIT 50
        `).bind(client_id).all(),

        // Conversations — raised cap to 30, include message count
        env.website_avatar_db.prepare(`
          SELECT user_id, created_at, analysis
          FROM conversations
          WHERE client_id = ?
          ORDER BY created_at DESC
          LIMIT 30
        `).bind(client_id).all(),

        // Usage event totals
        env.website_avatar_db.prepare(`
          SELECT event_type, COUNT(*) AS total
          FROM usage_events
          WHERE client_id = ? AND created_at >= ?
          GROUP BY event_type
        `).bind(client_id, sinceEpoch).all(),

        // Session engagement: avg messages, % with >3 msgs
        env.website_avatar_db.prepare(`
          SELECT
            COUNT(*) AS total_sessions,
            AVG(CAST(json_extract(analysis, '$.messageCount') AS INTEGER)) AS avg_messages,
            SUM(CASE WHEN CAST(json_extract(analysis, '$.messageCount') AS INTEGER) > 3 THEN 1 ELSE 0 END) AS engaged_sessions
          FROM conversations
          WHERE client_id = ? AND created_at >= datetime(?, 'unixepoch')
        `).bind(client_id, sinceEpoch).first(),

        // Lead quality: capture rates
        env.website_avatar_db.prepare(`
          SELECT
            COUNT(*) AS total_profiles,
            SUM(CASE WHEN u.email IS NOT NULL THEN 1 ELSE 0 END) AS has_email,
            SUM(CASE WHEN p.phone IS NOT NULL AND p.phone != '' THEN 1 ELSE 0 END) AS has_phone,
            SUM(CASE WHEN p.company IS NOT NULL AND p.company != '' THEN 1 ELSE 0 END) AS has_company,
            SUM(CASE WHEN p.persona_summary IS NOT NULL THEN 1 ELSE 0 END) AS has_persona
          FROM user_profiles p
          LEFT JOIN authenticated_users u ON u.id = p.user_id
          WHERE p.client_id = ?
        `).bind(client_id).first(),

        // Returning vs new visitors
        env.website_avatar_db.prepare(`
          SELECT
            COUNT(DISTINCT user_id) AS total_visitors,
            SUM(CASE WHEN session_count > 1 THEN 1 ELSE 0 END) AS returning_visitors
          FROM (
            SELECT user_id, COUNT(*) AS session_count
            FROM conversations
            WHERE client_id = ? AND created_at >= datetime(?, 'unixepoch')
            GROUP BY user_id
          )
        `).bind(client_id, sinceEpoch).first(),
      ]);

      // ── Build pre-aggregated context ──────────────────────────────────────

      // Usage summary
      const usageMap = {};
      for (const r of (usageRows.results || [])) usageMap[r.event_type] = r.total;
      const totalSessions = engagementRow?.total_sessions || 0;
      const avgMsgs = engagementRow?.avg_messages ? Math.round(engagementRow.avg_messages * 10) / 10 : 0;
      const engagedPct = totalSessions > 0
        ? Math.round((engagementRow.engaged_sessions / totalSessions) * 100)
        : 0;

      const usageBlock = [
        `Period: last ${lookback} days`,
        `Sessions: ${usageMap.session_started || 0}`,
        `Voice calls completed: ${usageMap.webhook_call_complete || 0}`,
        `Persona updates: ${usageMap.openai_persona || 0}`,
        `Avg messages/session: ${avgMsgs}`,
        `Engaged sessions (>3 msgs): ${engagedPct}%`,
        `Returning visitors: ${returningRow?.returning_visitors || 0} of ${returningRow?.total_visitors || 0}`,
      ].join(' | ');

      // Lead quality block
      const lq = leadQualRow || {};
      const total = lq.total_profiles || 0;
      const pct = n => total > 0 ? ` (${Math.round((n / total) * 100)}%)` : '';
      const leadBlock = total > 0 ? [
        `Total profiles: ${total}`,
        `Email captured: ${lq.has_email || 0}${pct(lq.has_email)}`,
        `Phone captured: ${lq.has_phone || 0}${pct(lq.has_phone)}`,
        `Company captured: ${lq.has_company || 0}${pct(lq.has_company)}`,
        `Persona built: ${lq.has_persona || 0}${pct(lq.has_persona)}`,
      ].join(' | ') : 'No profiles yet';

      // User profiles with persona signals
      const userBlocks = (profileRows.results || []).map(p => {
        const contact = [
          p.email     ? `email: ${p.email}`         : null,
          p.phone     ? `phone: ${p.phone}`         : null,
          p.company   ? `company: ${p.company}`     : null,
          p.job_title ? `role: ${p.job_title}`       : null,
          p.session_count > 1 ? `sessions: ${p.session_count}` : null,
          p.last_seen ? `last seen: ${p.last_seen?.slice(0, 10)}` : null,
        ].filter(Boolean).join(' | ');

        let personaLines = '';
        if (p.persona_summary) {
          try {
            const ps = JSON.parse(p.persona_summary);
            personaLines = PERSONA_FIELDS
              .filter(f => ps[f] && (Array.isArray(ps[f]) ? ps[f].length : ps[f]))
              .map(f => `  ${f}: ${Array.isArray(ps[f]) ? ps[f].join(', ') : ps[f]}`)
              .join('\n');
          } catch { personaLines = '  (legacy persona)'; }
        }
        const header = `User: ${p.name || '(unnamed)'}${contact ? `  [${contact}]` : ''}`;
        return `${header}\n${personaLines || '  (no persona yet)'}`;
      }).join('\n\n');

      // Recent conversation summaries with message counts
      const convBlocks = (convRows.results || []).map(c => {
        let summary = '(no summary)';
        let msgCount = '';
        try {
          const a = JSON.parse(c.analysis || '{}');
          summary = a.transcript_summary || a.call_summary_title || '(no summary)';
          if (a.messageCount) msgCount = ` [${a.messageCount} msgs]`;
        } catch { /* ignore */ }
        const date = c.created_at?.slice(0, 10) || '?';
        return `[${date}${msgCount}] ${summary}`;
      }).join('\n');

      const context = `CLIENT: ${client_id}
ENGAGEMENT (${lookback} days): ${usageBlock}
LEAD CAPTURE: ${leadBlock}

KNOWN USERS (${(profileRows.results || []).length} profiles, most recent first):
${userBlocks || '(none)'}

RECENT CONVERSATIONS (${(convRows.results || []).length}, newest first):
${convBlocks || '(none)'}`;

      // ── Call gpt-4o-mini ──────────────────────────────────────────────────
      const systemPrompt = 'You are an analytics assistant for Website Avatar, an AI chat widget. Answer concisely and accurately using only the data provided. If data is insufficient, say so briefly. Where relevant, name specific users or highlight actionable signals.';
      const userPrompt   = `Data:\n${context}\n\nQuestion: ${question.trim()}`;

      console.log('[Ask] ── OUTBOUND ─────────────────────────────────');
      console.log('[Ask] Question:', question.trim());
      console.log('[Ask] Context length:', context.length, 'chars');
      console.log('[Ask] Context breakdown:',
        `profiles=${profileRows.results?.length || 0}`,
        `convs=${convRows.results?.length || 0}`,
        `lookback=${lookback}d`
      );
      console.log('[Ask] Full context sent:\n', context);

      const aiResp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.OPENAI_KEY}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 500,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt   }
          ]
        })
      });

      if (!aiResp.ok) {
        console.error('[Ask] OpenAI error:', aiResp.status, await aiResp.text());
        return json({ error: 'OpenAI request failed' }, 502, cors);
      }
      const aiData = await aiResp.json();
      const answer     = aiData.choices?.[0]?.message?.content?.trim() || 'No answer returned.';
      const tokensUsed = aiData.usage?.total_tokens    || 0;
      const promptTok  = aiData.usage?.prompt_tokens   || 0;
      const completionTok = aiData.usage?.completion_tokens || 0;

      console.log('[Ask] ── INBOUND ──────────────────────────────────');
      console.log('[Ask] Answer:', answer);
      console.log('[Ask] Tokens — prompt:', promptTok, '| completion:', completionTok, '| total:', tokensUsed);
      console.log('[Ask] ─────────────────────────────────────────────');

      return json({ answer, tokens_used: tokensUsed, prompt_tokens: promptTok, completion_tokens: completionTok }, 200, cors);
    }

    return json({ error: 'Not found', code: 'NOT_FOUND' }, 404, cors);
  }
};

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function errorPage(message) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Sign-in Error</title>
  <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f4f3f7;}
  .box{background:#fff;padding:40px;border-radius:12px;text-align:center;max-width:400px;box-shadow:0 4px 6px rgba(0,0,0,0.1);}
  h2{color:#c84b2f;margin-top:0;}p{color:#374151;line-height:1.6;}</style>
  </head><body><div class="box"><h2>Sign-in Failed</h2><p>${escapeHtml(message)}</p></div></body></html>`;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}
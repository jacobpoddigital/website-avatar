import { parseHTML } from 'linkedom';
import * as jose from 'jose';

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

function generateThankYouEmail({ name }) {
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
      <p class="message">Best regards,<br><strong>The Pod Digital Team</strong></p>
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
      personalizations: [{ to: [{ email: to }] }],
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Get origin from request for CORS
    const origin = request.headers.get('Origin') || '*';

    const cors = {
      'Access-Control-Allow-Origin':  origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Credentials': 'true',
      'Content-Type':                 'application/json'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    // ── GET /config?id=acct_xxx ─────────────────────────────
    if (url.pathname === '/config' && request.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'Missing id' }, 400, cors);

      const raw = await env.CONFIGS.get(id);
      if (!raw) return json({ error: 'Account not found' }, 404, cors);

      return new Response(raw, { headers: cors });
    }

    // ── POST /config ───────────────────────────────────────
    if (url.pathname === '/config' && request.method === 'POST') {
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'Missing id' }, 400, cors);

      let body;
      try { body = await request.json(); } catch(e) {
        return json({ error: 'Invalid JSON' }, 400, cors);
      }

      const raw = await env.CONFIGS.get(id);
      const config = raw ? JSON.parse(raw) : {};
      const updated = { ...config, ...body };

      await env.CONFIGS.put(id, JSON.stringify(updated));

      return json(updated, 200, cors);
    }

    // ── POST /classify ────────────────────────────────────
    if (url.pathname === '/classify' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch(e) {
        return json({ error: 'Invalid JSON' }, 400, cors);
      }

      const { prompt, maxTokens } = body;
      if (!prompt) return json({ error: 'Missing prompt' }, 400, cors);

      const apiKey = env.OPENAI_KEY;
      if (!apiKey) return json({ error: 'No API key configured' }, 500, cors);

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({
          model:       'gpt-4o-mini',
          max_tokens:  maxTokens || 60,
          temperature: 0,
          messages:    [{ role: 'user', content: prompt }]
        })
      });

      if (!response.ok) {
        return json({ error: `OpenAI error: ${response.status}` }, 502, cors);
      }

      const data    = await response.json();
      const content = data.choices?.[0]?.message?.content || '';
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
        console.log('[Session] GET request for user:', userId);
        try {
          const result = await env.website_avatar_db.prepare(`
            SELECT conversation_id, transcript, analysis, created_at
            FROM conversations
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT 10
          `)
          .bind(userId)
          .all();

          console.log('[Session] Found', result.results?.length || 0, 'sessions');

          if (!result.results || result.results.length === 0) {
            return json([], 200, cors);
          }

          const sessions = result.results.map(row => ({
            conversation_id: row.conversation_id,
            transcript: typeof row.transcript === 'string' ? JSON.parse(row.transcript) : row.transcript,
            analysis: typeof row.analysis === 'string' ? JSON.parse(row.analysis) : row.analysis,
            created_at: row.created_at
          }));

          console.log('[Session] ✅ Returning', sessions.length, 'sessions');
          return json(sessions, 200, cors);
        } catch (err) {
          console.error('[Session] ❌ GET error:', err);
          return json({ error: 'Database error' }, 500, cors);
        }
      }

      return json({ error: 'Missing session_id or user_id' }, 400, cors);
    }

    // ── POST /session (frontend save) ─────────────────────────────
    // Route A: body.session_id (no user_id) → save full client session state to KV
    // Route B: body.user_id + body.conversation_id → save transcript to D1 (existing)
    if (url.pathname === '/session' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch(e) {
        return json({ error: 'Invalid JSON' }, 400, cors);
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
          return json({ error: 'KV error' }, 500, cors);
        }
      }

      // Route B: transcript save → D1 (requires user_id + conversation_id)
      const userId = body?.user_id;
      const conversationId = body?.conversation_id;

      console.log('[Session] Frontend save:', { userId, conversationId, messageCount: body?.transcript?.length });

      if (!userId || !conversationId) return json({ error: 'Missing user_id or conversation_id' }, 400, cors);

      const transcript = JSON.stringify(body.transcript || []);
      const analysis   = JSON.stringify(body.analysis || {});

      try {
        await env.website_avatar_db.prepare(`
          INSERT INTO conversations (user_id, conversation_id, transcript, analysis)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(conversation_id)
          DO UPDATE SET
            transcript = excluded.transcript,
            analysis = excluded.analysis,
            created_at = CURRENT_TIMESTAMP
        `)
        .bind(userId, conversationId, transcript, analysis)
        .run();

        console.log('[Session] ✅ Saved to DB:', conversationId);
        return json({ message: 'Session saved', conversation_id: conversationId }, 200, cors);
      } catch (err) {
        console.error('[Session] ❌ DB error:', err);
        return json({ error: 'Database error' }, 500, cors);
      }
    }

    // ── SHARED SEMANTIC ANALYSIS FUNCTION ─────────────────────────────
    async function analyzePageSemantics(pageUrl) {
      // Fetch HTML
      const response = await fetch(pageUrl);
      if (!response.ok) throw new Error(`Failed to fetch ${pageUrl}`);
      const html = await response.text();

      // Parse
      const { document } = parseHTML(html);

      // Remove junk
      document.querySelectorAll('head, header, footer, script, style, nav')
        .forEach(el => el.remove());

      // Helpers
      const LIGHT_STOPWORDS = new Set([
        "the","a","an","and","but","or","so","to","of","in","on","at",
        "for","with","is","are","was","were","be","been","being","have",
        "has","had","do","does","did","will","would","could","should",
        "may","might","must","can","that","this","these","those"
      ]);

      const summarise = (text) => {
        if (!text || text.length < 50) return text;
        const first = text.split(/[.!?]+/)[0].trim();
        return first
          .split(/\s+/)
          .filter(w => !LIGHT_STOPWORDS.has(w.toLowerCase()))
          .join(' ')
          .trim();
      };

      function extractSubsections(headingEl) {
        const subsections = [];
        const subsectionElements = [];
        let currentEl = headingEl.nextElementSibling;
        const parentLevel = parseInt(headingEl.tagName[1]);

        while (currentEl) {
          if (currentEl.tagName && currentEl.tagName.match(/^H[1-6]$/)) {
            const level = parseInt(currentEl.tagName[1]);
            if (level <= parentLevel) break;
          }

          const containers = currentEl.matches?.('li, .box-list-item, .swiper-slide')
            ? [currentEl]
            : currentEl.querySelectorAll?.('li, .box-list-item, .swiper-slide') || [];

          containers.forEach(container => {
            const heading = container.querySelector('h3, h4, h5, h6');
            if (!heading) return;

            const title = heading.textContent.trim();
            if (!title || title.length < 3) return;

            const paragraphs = container.querySelectorAll('p');
            const text = Array.from(paragraphs)
              .map(p => p.textContent.trim())
              .filter(t => t.length > 20)
              .join(' ');

            if (!text) return;

            const summary = summarise(text);

            subsections.push({
              title,
              description: summary,
              tokens: Math.ceil(summary.length / 4)
            });

            subsectionElements.push(heading);
          });

          currentEl = currentEl.nextElementSibling;
        }

        const seen = new Set();
        const deduped = subsections.filter(s => {
          if (seen.has(s.title)) return false;
          seen.add(s.title);
          return true;
        });

        return { subsections: deduped, subsectionElements };
      }

      // Pre-identify subsection headings
      const allHeadings = Array.from(document.body.querySelectorAll('h1, h2, h3, h4, h5, h6'));
      const subsectionHeadingSet = new Set();

      allHeadings.forEach((heading) => {
        const { subsectionElements } = extractSubsections(heading);
        subsectionElements.forEach(el => subsectionHeadingSet.add(el));
      });

      // Build sections
      const elements = Array.from(document.body.querySelectorAll('h1,h2,h3,h4,h5,h6,p'));
      const sections = [];
      let currentSection = null;

      elements.forEach((el) => {
        if (el.closest('header, footer, nav')) return;

        if (el.tagName.match(/^H[1-6]$/)) {
          if (subsectionHeadingSet.has(el)) return;

          if (currentSection) {
            sections.push(currentSection);
          }

          currentSection = {
            heading: el.textContent.trim(),
            level: parseInt(el.tagName[1]),
            content: [],
            element: el
          };
        } else if (el.tagName === 'P' && currentSection) {
          const text = el.textContent.trim();
          if (text.length > 40) {
            currentSection.content.push(text);
          }
        }
      });

      if (currentSection) {
        sections.push(currentSection);
      }

      // Process sections
      const processedSections = [];
      const seenHeadings = new Set();

      sections.forEach((sec) => {
        const combined = sec.content.join(' ');
        const summary = summarise(combined);
        const { subsections } = extractSubsections(sec.element);

        if ((!summary || summary.length < 10) && subsections.length === 0) {
          return;
        }

        const headingKey = sec.heading.toLowerCase().trim();
        if (seenHeadings.has(headingKey)) return;
        seenHeadings.add(headingKey);

        processedSections.push({
          heading: sec.heading,
          level: sec.level,
          summary,
          content: sec.content,
          subsections
        });
      });

      // Extra discovery
      const forms = [];
      document.querySelectorAll('form').forEach((form, i) => {
        const fields = Array.from(form.querySelectorAll('input, textarea, select')).map(f => ({
          name: f.name || null,
          id: f.id || null,
          type: f.type || f.tagName.toLowerCase(),
          required: f.required || f.getAttribute('aria-required') === 'true'
        }));
        if (fields.length > 0) forms.push({ index: i, fields });
      });

      const ctas = [];
      document.querySelectorAll('a, button').forEach(el => {
        const text = el.textContent.trim();
        if (text && text.length > 2 && text.length < 60) {
          ctas.push({ text, tag: el.tagName });
        }
      });

      const media = [];
      document.querySelectorAll('img[alt], video, iframe').forEach(el => {
        if (el.tagName === 'IMG') {
          media.push({ type: 'image', alt: el.alt.trim() });
        } else if (el.tagName === 'VIDEO') {
          media.push({ type: 'video' });
        } else if (el.tagName === 'IFRAME') {
          media.push({ type: 'iframe', src: el.src });
        }
      });

      const contacts = [];
      document.querySelectorAll('a[href^="tel:"], a[href^="mailto:"]').forEach(el => {
        if (el.href.startsWith('tel:')) {
          contacts.push({ type: 'phone', number: el.href.replace('tel:', '') });
        }
        if (el.href.startsWith('mailto:')) {
          contacts.push({ type: 'email', email: el.href.replace('mailto:', '') });
        }
      });

      return {
        url: pageUrl,
        sections: processedSections,
        forms,
        ctas,
        media,
        contacts
      };
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

    // ── GET /semantic?url=xxx ─────────────────────────────
    if (url.pathname === '/semantic' && request.method === 'GET') {
      const pageUrl = url.searchParams.get('url');
      if (!pageUrl) return json({ error: 'Missing "url" parameter' }, 400, cors);

      try {
        console.log('[Semantic] Start analyzing', pageUrl);
        const result = await analyzePageSemantics(pageUrl);
        console.log('[Semantic] Total top-level sections:', result.sections.length);
        return json(result, 200, cors);
      } catch (err) {
        console.error('[Semantic] ❌ Error:', err);
        return json({ error: err.message }, 500, cors);
      }
    }

    // ── GET /all-pages?url=xxx ─────────────────────────────
    if (url.pathname === '/all-pages' && request.method === 'GET') {
      const sitemapUrl = url.searchParams.get('url');
      if (!sitemapUrl) return json({ error: 'Missing "url" parameter' }, 400, cors);

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
        return json({ error: err.message }, 500, cors);
      }
    }

    // ── GET /semantic-sitemap?url=xxx ─────────────────────────────
    if (url.pathname === '/semantic-sitemap' && request.method === 'GET') {
      const sitemapUrl = url.searchParams.get('url');
      const limit = parseInt(url.searchParams.get('limit')) || 5;
      
      if (!sitemapUrl) return json({ error: 'Missing "url" parameter' }, 400, cors);

      try {
        console.log('[Semantic-Sitemap] Fetching sitemap:', sitemapUrl);
        
        // Get all URLs from sitemap
        const allUrls = await fetchSitemapUrls(sitemapUrl);
        console.log(`[Semantic-Sitemap] Found ${allUrls.length} URLs, processing first ${limit}...`);

        // Process each URL (limited)
        const results = [];
        const urlsToProcess = allUrls.slice(0, limit);

        for (let i = 0; i < urlsToProcess.length; i++) {
          const pageUrl = urlsToProcess[i];
          console.log(`[Semantic-Sitemap] Processing ${i + 1}/${urlsToProcess.length}: ${pageUrl}`);

          try {
            const semanticResult = await analyzePageSemantics(pageUrl);
            
            console.log(`[Semantic-Sitemap] ✅ ${pageUrl} → ${semanticResult.sections.length} sections`);

            results.push({
              url: pageUrl,
              sections: semanticResult.sections,
              sectionCount: semanticResult.sections.length
            });

          } catch (err) {
            console.error(`[Semantic-Sitemap] ❌ Error processing ${pageUrl}:`, err);
            results.push({ url: pageUrl, error: err.message });
          }
        }

        return json({
          sitemap: sitemapUrl,
          totalUrlsInSitemap: allUrls.length,
          processedCount: results.length,
          limit,
          results
        }, 200, cors);

      } catch (err) {
        console.error('[Semantic-Sitemap] ❌ Error:', err);
        return json({ error: err.message }, 500, cors);
      }
    }
    
    // ── POST /webhook/call-complete ─────────────────────────────
    if (url.pathname === '/webhook/call-complete' && request.method === 'POST') {
      try {
        const callData = await request.json();
        console.log('[Webhook] Received call data');

        // Only process successful calls
        if (callData?.data?.analysis?.call_successful !== 'success') {
          console.log('[Webhook] Skipping - call not successful');
          return json({ message: 'Call not successful, skipping notifications' }, 200, cors);
        }

        const analysis = callData.data.analysis;
        const metadata = callData.data.metadata;
        const collectedData = analysis.data_collection_results || {};

        // Extract data
        const name = collectedData['Name']?.value || 'Unknown';
        const phone = collectedData['Phone Number']?.value || 'Not provided';
        const email = collectedData['Email Address']?.value || 'Not provided';
        const company = collectedData['Company Name']?.value || 'Not provided';
        const callSummary = analysis.call_summary_title || 'No summary';
        const callDuration = metadata?.call_duration_secs
          ? `${Math.floor(metadata.call_duration_secs / 60)}m ${metadata.call_duration_secs % 60}s`
          : 'Unknown';

        // Validation: require name AND valid email
        const hasValidData = (name !== 'Unknown') && (email !== 'Not provided' && email.includes('@'));
        
        if (!hasValidData) {
          console.log('[Webhook] Skipping - missing required contact information (name or email)');
          return json({ message: 'Required contact information missing, skipping notifications' }, 200, cors);
        }

        console.log('[Webhook] Processing call from:', name);

        // Write to Google Sheet
        try {
          await appendToSheet({ name, phone, email, company, callSummary, callDuration }, env);
          console.log('[Webhook] ✅ Lead written to Google Sheet');
        } catch (sheetErr) {
          console.error('[Webhook] ❌ Sheet error:', sheetErr.message);
          // Continue with other notifications even if sheet fails
        }

        // Send admin email
        try {
          const adminEmailHtml = generateAdminEmail({ name, phone, email, company, callSummary, callDuration });
          await sendEmail({
            from: 'mail@websiteavatar.co.uk',
            to: 'jacob@poddigital.co.uk',
            subject: `New Website Avatar Lead: ${name}`,
            html: adminEmailHtml
          }, env);
          console.log('[Webhook] ✅ Admin email sent');
        } catch (emailErr) {
          console.error('[Webhook] ❌ Admin email error:', emailErr.message);
        }

        // Send admin SMS
        try {
          const smsBody = `New Website Avatar Lead!
Name: ${name}
Company: ${company}
Phone: ${phone}
Email: ${email}
Summary: ${callSummary}`;
          await sendSMS({ to: env.ADMIN_PHONE_NUMBER, body: smsBody }, env);
          console.log('[Webhook] ✅ Admin SMS sent');
        } catch (smsErr) {
          console.error('[Webhook] ❌ Admin SMS error:', smsErr.message);
        }

        // Send thank you email to user
        try {
          const thankYouHtml = generateThankYouEmail({ name });
          await sendEmail({
            from: 'mail@websiteavatar.co.uk',
            to: email,
            subject: 'Thank you for contacting Pod Digital',
            html: thankYouHtml
          }, env);
          console.log('[Webhook] ✅ Thank you email sent to:', email);
        } catch (thankYouErr) {
          console.error('[Webhook] ❌ Thank you email error:', thankYouErr.message);
        }

        return json({
          message: 'Webhook processed successfully',
          adminEmail: 'jacob@poddigital.co.uk',
          adminSMS: env.ADMIN_PHONE_NUMBER,
          userEmail: email
        }, 200, cors);

      } catch (err) {
        console.error('[Webhook] ❌ Critical error:', err);
        return json({ error: err.message }, 500, cors);
      }
    }
    
    return json({ error: 'Not found' }, 404, cors);
  }
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}
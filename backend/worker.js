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
            client_id:       row.client_id || '',
            transcript: typeof row.transcript === 'string' ? JSON.parse(row.transcript) : row.transcript,
            analysis:   typeof row.analysis  === 'string' ? JSON.parse(row.analysis)  : row.analysis,
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
      const userId         = body?.user_id;
      const conversationId = body?.conversation_id;
      // client_id identifies which account (data-account-id) owns this conversation.
      // Empty string is stored when not provided so existing rows are not broken.
      const clientId       = body?.client_id || '';

      console.log('[Session] Frontend save:', { userId, clientId, conversationId, messageCount: body?.transcript?.length });

      if (!userId || !conversationId) return json({ error: 'Missing user_id or conversation_id' }, 400, cors);

      const transcript = JSON.stringify(body.transcript || []);
      const analysis   = JSON.stringify(body.analysis || {});

      try {
        await env.website_avatar_db.prepare(`
          INSERT INTO conversations (user_id, conversation_id, client_id, transcript, analysis)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(conversation_id)
          DO UPDATE SET
            client_id  = excluded.client_id,
            transcript = excluded.transcript,
            analysis   = excluded.analysis,
            created_at = CURRENT_TIMESTAMP
        `)
        .bind(userId, conversationId, clientId, transcript, analysis)
        .run();

        console.log('[Session] ✅ Saved to DB:', conversationId, '| client:', clientId);
        return json({ message: 'Session saved', conversation_id: conversationId, client_id: clientId }, 200, cors);
      } catch (err) {
        console.error('[Session] ❌ DB error:', err);
        return json({ error: 'Database error' }, 500, cors);
      }
    }

    // ── GET /semantic?url=xxx ─────────────────────────────
    if (url.pathname === '/semantic' && request.method === 'GET') {
      const pageUrl = url.searchParams.get('url');
      if (!pageUrl) return json({ error: 'Missing "url" parameter' }, 400, cors);
    
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

      if (!sitemapUrl) return json({ error: 'Missing "url" parameter' }, 400, cors);

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
        return json({ error: err.message }, 500, cors);
      }
    }
    
    // ── POST /consent ─────────────────────────────────────────────
    if (url.pathname === '/consent' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) {
        return json({ error: 'Invalid JSON' }, 400, cors);
      }

      const { visitor_id, consent_given } = body;

      if (typeof visitor_id !== 'string' || visitor_id.trim() === '') {
        return json({ error: 'Missing or invalid visitor_id' }, 400, cors);
      }
      if (typeof consent_given !== 'boolean') {
        return json({ error: 'consent_given must be a boolean' }, 400, cors);
      }

      try {
        const result = await env.website_avatar_db
          .prepare(`INSERT INTO consent (visitor_id, consent_given) VALUES (?, ?)`)
          .bind(visitor_id.trim(), consent_given ? 1 : 0)
          .run();

        return json({ success: true, id: result.meta.last_row_id }, 200, cors);
      } catch (e) {
        console.error('[Consent] DB error:', e.message);
        return json({ error: 'Database error' }, 500, cors);
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
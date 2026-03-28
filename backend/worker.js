import { parseHTML } from 'linkedom';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Get origin from request for CORS
    const origin = request.headers.get('Origin') || '*';

    const cors = {
      'Access-Control-Allow-Origin':  origin,  // Use actual origin instead of wildcard
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Credentials': 'true',  // Allow credentials for sendBeacon
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

    // ── POST /session (frontend save) ─────────────────────
    if (url.pathname === '/session' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch(e) {
        return json({ error: 'Invalid JSON' }, 400, cors);
      }

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

    // ── GET /session?user_id=xxx ─────────────────────────
    if (url.pathname === '/session' && request.method === 'GET') {
      const userId = url.searchParams.get('user_id');
      if (!userId) return json({ error: 'Missing user_id' }, 400, cors);

      try {
        const { results } = await env.website_avatar_db.prepare(`
          SELECT * FROM conversations
          WHERE user_id = ?
          ORDER BY created_at DESC
        `)
        .bind(userId)
        .all();

        console.log('[Session] GET for user:', userId, '| found:', results.length);
        return json(results, 200, cors);
      } catch (err) {
        console.error('[Session] GET DB error:', err);
        return json({ error: 'Database error' }, 500, cors);
      }
    }

    // ── GET /semantic?url=xxx ─────────────────────────────
    if (url.pathname === '/semantic' && request.method === 'GET') {
      const pageUrl = url.searchParams.get('url');
      if (!pageUrl) return json({ error: 'Missing "url" parameter' }, 400, cors);

      try {
        // 1️⃣ Fetch the page HTML
        const response = await fetch(pageUrl);
        if (!response.ok) throw new Error(`Failed to fetch ${pageUrl}`);
        const html = await response.text();

        // 2️⃣ Parse the HTML using linkedom
        const { document } = parseHTML(html);

        // 3️⃣ Remove non-content elements
        const ignoreSelectors = 'head, header, footer, script, style, nav';
        document.querySelectorAll(ignoreSelectors).forEach(el => el.remove());

        // 4️⃣ Extract semantic sections
        const elements = Array.from(document.body.querySelectorAll('h1, h2, h3, h4, h5, h6, p'));
        const sections = [];
        let currentSection = null;

        elements.forEach(el => {
          if (el.tagName.match(/^H[1-6]$/)) {
            if (currentSection) sections.push(currentSection);
            currentSection = { heading: el.textContent.trim(), level: parseInt(el.tagName[1]), content: [] };
          } else if (el.tagName === 'P' && currentSection) {
            const text = el.textContent.trim();
            if (text.length > 30) currentSection.content.push(text);
          }
        });

        if (currentSection) sections.push(currentSection);

        // 5️⃣ Summarize each section (simple first sentence + light compression)
        const summarise = (text) => text.split(/[.!?]+/)[0].trim();
        const output = sections.map(sec => ({
          heading: sec.heading,
          level: sec.level,
          summary: summarise(sec.content.join(' ')),
          content: sec.content
        }));

        return json({ url: pageUrl, sections: output }, 200, cors);

      } catch (err) {
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
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const cors = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
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

    // ── POST /webhook/elevenlabs ──────────────────────────
    if (url.pathname === '/webhook/elevenlabs' && request.method === 'POST') {
      console.log('[Webhook] 🔔 ElevenLabs webhook received');
      console.log('[Webhook] Headers:', Object.fromEntries(request.headers));
      
      const bodyText = await request.text();
      console.log('[Webhook] Body length:', bodyText.length, 'bytes');
      console.log('[Webhook] Body preview:', bodyText.slice(0, 500));
    
      // Parse JSON
      let body;
      try { 
        body = JSON.parse(bodyText); 
      } catch(e) {
        console.error('[Webhook] ❌ Invalid JSON:', e.message);
        return json({ error: 'Invalid JSON' }, 400, cors);
      }
      
      console.log('[Webhook] 📦 Parsed payload:', {
        conversation_id: body?.conversation_id,
        event_type: body?.type,
        has_transcript: !!body?.transcript,
        transcript_length: body?.transcript?.length,
        has_analysis: !!body?.analysis,
        has_user_id: !!body?.user_id,
        dynamic_vars: body?.conversation_initiation_client_data?.dynamic_variables
      });
    
      // Extract data - support both simple and nested formats
      const userId = body?.user_id || body?.conversation_initiation_client_data?.dynamic_variables?.user_id;
      const conversationId = body?.conversation_id;
    
      console.log('[Webhook] Extracted:', { userId, conversationId });
    
      if (!userId || !conversationId) {
        console.error('[Webhook] ❌ Missing user_id or conversation_id');
        console.log('[Webhook] Full body:', JSON.stringify(body, null, 2));
        return json({ error: 'Missing user_id or conversation_id' }, 400, cors);
      }
    
      const transcript = JSON.stringify(body.transcript || []);
      const analysis = JSON.stringify(body.analysis || {});
    
      try {
        await env.website_avatar_db.prepare(`
          INSERT INTO conversations (user_id, conversation_id, transcript, analysis)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(conversation_id) 
          DO UPDATE SET 
            transcript = excluded.transcript,
            analysis = excluded.analysis,
            created_at = CURRENT_TIMESTAMP
        `).bind(userId, conversationId, transcript, analysis).run();
    
        console.log('[Webhook] ✅ Session saved:', conversationId);
        return json({ message: 'Session saved', conversation_id: conversationId }, 200, cors);
      } catch(err) {
        console.error('[Webhook] ❌ DB error:', err);
        return json({ error: 'Database error' }, 500, cors);
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
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
    
    return json({ error: 'Not found' }, 404, cors);
  }
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}
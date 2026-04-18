/**
 * content/providers/wordpress.js — WordPress REST API content search provider
 *
 * Implements the normalised content search interface for WordPress.
 * Uses the WP REST API Search endpoint (/wp-json/wp/v2/search) with subtype=any
 * so all public registered post types (pages, posts, custom types) are searched.
 *
 * Search is performed against post_title and post_content via standard WP_Query.
 * Page builder content (Gutenberg, Elementor) embeds readable text in post_content
 * so keyword search works. ACF fields stored in postmeta are not searched here —
 * that requires a custom WP endpoint (future enhancement).
 *
 * No authentication required for public content.
 *
 * Activation: set { "cmsPlatform": "wordpress" } in client KV config.
 */

(function () {
  'use strict';

  const WA   = window.WebsiteAvatar || (window.WebsiteAvatar = {});
  const _log  = (...a) => WA.DEBUG && console.log('[WA:WordPress]', ...a);
  const _warn = (...a) => console.warn('[WA:WordPress]', ...a);

  // ── PROVIDER ───────────────────────────────────────────────────────────────

  class WordPressProvider {
    get platformName() { return 'wordpress'; }

    /**
     * WordPress REST API is available if the origin looks like a WP site.
     * We do a lightweight check against the REST discovery endpoint.
     * Callers should handle the async result — this is best-effort.
     */
    isAvailable() {
      // Optimistic: assume available. The fetch in search() will surface errors.
      return true;
    }

    _apiBase() {
      return `${window.location.origin}/wp-json`;
    }

    /**
     * Shared fetch wrapper. No auth needed for public content.
     */
    async _fetch(path) {
      const url  = `${this._apiBase()}${path}`;
      _log('GET', path);
      const resp = await fetch(url, { method: 'GET', credentials: 'same-origin' });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => resp.statusText);
        throw new Error(`WP REST ${path} → ${resp.status}: ${errText}`);
      }
      const data = await resp.json();
      _log(`← ${path.split('?')[0]} returned`, Array.isArray(data) ? `${data.length} results` : typeof data, data);
      return data;
    }

    // ── NORMALISATION ────────────────────────────────────────────────────────

    /**
     * Map a WP REST Search result to the normalised ContentResult shape.
     * /wp/v2/search returns: { id, title, url, type, subtype }
     */
    _normaliseSearchResult(r) {
      return {
        title:   this._decodeEntities(r.title   || r.title?.rendered || ''),
        url:     r.url   || r.link || '',
        excerpt: this._decodeEntities(r.excerpt?.rendered || r.excerpt || ''),
        type:    this._friendlyType(r.subtype || r.type || 'page'),
      };
    }

    /**
     * Map a WP REST post/page object (from /wp/v2/posts or /wp/v2/pages) to ContentResult.
     * Used as a supplementary search path when the search endpoint yields nothing.
     */
    _normalisePost(p) {
      return {
        title:   this._decodeEntities(p.title?.rendered || p.title || ''),
        url:     p.link || '',
        excerpt: this._stripTags(this._decodeEntities(p.excerpt?.rendered || '')),
        type:    this._friendlyType(p.type || 'post'),
      };
    }

    /**
     * Convert a WP post type slug to a human-readable label for the UI badge.
     * Covers common custom post types used by popular page builders / themes.
     */
    _friendlyType(subtype) {
      const map = {
        post:              'Post',
        page:              'Page',
        product:           'Product',
        service:           'Service',
        case_study:        'Case Study',
        project:           'Project',
        portfolio:         'Portfolio',
        team:              'Team',
        testimonial:       'Testimonial',
        faq:               'FAQ',
        event:             'Event',
        tribe_events:      'Event',
        location:          'Location',
        job_listing:       'Job',
      };
      return map[subtype] || _titleCase(subtype.replace(/_/g, ' '));
    }

    _decodeEntities(str) {
      if (!str) return '';
      const txt = document.createElement('textarea');
      txt.innerHTML = str;
      return txt.value;
    }

    _stripTags(str) {
      return str.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    // ── INTERFACE ────────────────────────────────────────────────────────────

    /**
     * Resolve a known page/post title to a confirmed URL.
     * Used by find_pages — the agent already knows the title exists, we just need the URL.
     * Strips punctuation (handles "PPC in 2026: What You Need to Know" style titles),
     * searches pages and posts in parallel, returns the first match.
     */
    async resolve(title) {
      // Preserve hyphens (e.g. "Short-Form") — WP matches them as tokens.
      // Strip everything else that could break the query (colons, question marks, etc.)
      const q = title.replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!q) return null;

      _log('resolve:', q);
      const fields  = 'id,title,link,type,excerpt';
      const _search = (searchQ) => {
        const p = new URLSearchParams({ search: searchQ, per_page: '10', _fields: fields, status: 'publish' });
        return Promise.allSettled([
          this._fetch(`/wp/v2/pages?${p}`),
          this._fetch(`/wp/v2/posts?${p}`)
        ]);
      };

      const _collect = ([pR, poR]) => {
        const pg = pR.status  === 'fulfilled' && Array.isArray(pR.value)  ? pR.value  : [];
        const po = poR.status === 'fulfilled' && Array.isArray(poR.value) ? poR.value : [];
        return [...pg, ...po];
      };

      let all = _collect(await _search(q));

      // Score against the original title — WP relevance ranking isn't reliable
      const needle      = q.toLowerCase().trim();
      const needleWords = needle.split(/\s+/).filter(w => w.length > 2);
      const _score = (r) => {
        const rTitle = this._decodeEntities(r.title?.rendered || r.title || '').toLowerCase().trim();
        if (rTitle === needle) return 100;
        if (rTitle.includes(needle) || needle.includes(rTitle)) return 80;
        const matched = needleWords.filter(w => rTitle.includes(w)).length;
        return needleWords.length ? (matched / needleWords.length) * 60 : 0;
      };

      // If 0 results or best match score is weak, retry with sig words —
      // long generic titles can return unrelated posts at the top
      const bestOf = (arr) => arr.length ? arr.reduce((b, r) => _score(r) >= _score(b) ? r : b, arr[0]) : null;
      let hit = bestOf(all);

      if (!hit || _score(hit) < 40) {
        const sigQ = this._significantWords(q).join(' ');
        if (sigQ) {
          _log(`resolve: score ${hit ? _score(hit) : 0} below threshold, retrying with sig words:`, sigQ);
          const sigAll = _collect(await _search(sigQ));
          // Merge both result sets and re-score
          const merged = [...all, ...sigAll].filter((r, i, a) => a.findIndex(x => x.id === r.id) === i);
          const sigHit = bestOf(merged);
          if (sigHit && _score(sigHit) > (hit ? _score(hit) : 0)) hit = sigHit;
        }
      }

      if (!hit || _score(hit) < 40) {
        _log('resolve: no confident match found, skipping');
        return null;
      }
      _log('resolve hit:', this._decodeEntities(hit.title?.rendered || hit.title || ''), `(score ${_score(hit)})`);
      return this._normalisePost(hit);
    }

    /**
     * Query-aware search strategy:
     *
     * Pages + custom post types are always searched — they answer navigational queries.
     * Pages use an incremental keyword-reduction chain: all sig words → N-1 → … → 1 word →
     * original phrase. The chain stops as soon as any step returns results, so a query like
     * "seo services" that returns 0 pages will retry with just "seo" before giving up.
     * Posts are only searched when:
     *   (a) the query is informational/long-tail (question words, 4+ sig words, guide/tips/etc.), OR
     *   (b) the entire pages chain + custom types returned 0 results.
     */
    async search(query, { limit = 10 } = {}) {
      _log('search:', query, `limit: ${limit}`);

      const per      = String(limit);
      const sigWords = this._significantWords(query);
      const sigQuery = sigWords.join(' ') || query;
      const longTail = this._isLongTailQuery(query, sigWords);

      _log(`query type: ${longTail ? 'long-tail' : 'navigational'}, sigQuery: "${sigQuery}"`);

      const fields       = 'id,title,link,type,excerpt';
      const customFields = 'id,title,url,type,subtype';

      const makePageUrl   = (q) => `/wp/v2/pages?${new URLSearchParams({ search: q, per_page: per, _fields: fields, status: 'publish' })}`;
      const makePostUrl   = (q) => `/wp/v2/posts?${new URLSearchParams({ search: q, per_page: per, _fields: fields, status: 'publish' })}`;
      const makeCustomUrl = (q) => `/wp/v2/search?${new URLSearchParams({ search: q, type: 'post', per_page: per, _fields: customFields })}`;

      // Build the incremental keyword chain: all words → N-1 → … → 1 → original phrase
      const _buildChain = (words, original) => {
        const chain = [];
        for (let n = words.length; n >= 1; n--) {
          const q = words.slice(0, n).join(' ');
          if (q && !chain.includes(q)) chain.push(q);
        }
        if (original && !chain.includes(original)) chain.push(original);
        return chain;
      };

      const seen = new Set();
      const norm  = (r) => this._normalisePost(r);
      const normS = (r) => this._normaliseSearchResult(r);

      const _collect = (raw, normFn, typeFilter = null) =>
        (Array.isArray(raw) ? raw : [])
          .map(r => normFn(r))
          .filter(r => {
            if (!r.url) return false;
            if (typeFilter && !typeFilter(r)) return false;
            if (seen.has(r.url)) return false;
            seen.add(r.url);
            return true;
          });

      // ── Phase 1a: pages — walk the chain, stop at first hit ───────────────
      const pageChain = _buildChain(sigWords, sigQuery !== query ? query : null);
      let pages = [];
      for (const q of pageChain) {
        _log(`trying pages: "${q}"`);
        const raw = await this._fetch(makePageUrl(q)).catch(e => { _warn(e.message); return []; });
        const hits = _collect(raw, norm);
        if (hits.length > 0) {
          pages = hits;
          _log(`pages hit (${hits.length}) with "${q}"`);
          break;
        }
      }

      // ── Phase 1b: custom post types — single broad query ──────────────────
      const customRaw  = await this._fetch(makeCustomUrl(sigQuery)).catch(e => { _warn(e.message); return []; });
      const customTypes = _collect(customRaw, normS, r => r.type !== 'Post' && r.type !== 'Page');

      // ── Phase 2: posts — only if long-tail OR pages + custom types empty ──
      let posts = [];
      if (longTail || (pages.length + customTypes.length === 0)) {
        _log(`fetching posts (reason: ${longTail ? 'long-tail' : 'no pages/custom found'})`);
        const postChain = _buildChain(sigWords, sigQuery !== query ? query : null);
        for (const q of postChain) {
          _log(`trying posts: "${q}"`);
          const raw  = await this._fetch(makePostUrl(q)).catch(e => { _warn(e.message); return []; });
          const hits = _collect(raw, norm);
          if (hits.length > 0) {
            posts = hits;
            _log(`posts hit (${hits.length}) with "${q}"`);
            break;
          }
        }
      }

      const results = [...pages, ...customTypes, ...posts];
      _log(`search results: ${results.length} (pages: ${pages.length}, custom: ${customTypes.length}, posts: ${posts.length})`);
      return results;
    }

    /**
     * Returns true when the query signals informational intent — blog posts are likely relevant.
     * Navigational queries (service pages, contact, pricing) return false.
     */
    _isLongTailQuery(query, sigWords) {
      const q = query.toLowerCase();
      if (/\b(how|why|what|when|which|where|who)\b/.test(q)) return true;
      if (sigWords.length >= 4) return true;
      if (/\b(guide|guides|article|articles|blog|blogs|post|posts|news|resource|resources|tips|tutorial|tutorials|advice|ideas|examples|best|vs|versus|comparison|review|reviews|help|learn|understand|difference|pros|cons)\b/.test(q)) return true;
      return false;
    }

    _significantWords(query) {
      const STOP = new Set([
        'a','an','the','and','or','for','in','on','at','to','of','is','it',
        'with','that','this','be','as','are','was','were','have','has','had',
        'do','does','did','will','would','could','should','may','might','can',
        'not','but','from','by','so','if','about','into','up','out','i','me',
        'my','we','you','your','our','get','what','some','any','find','look',
        'search','want','need','where','how','tell','page','pages','info',
        'information','more','main','top','best','great','good','latest',
        'new','show','have','got','got','give','see','know','like','just',
        'also','even','still','well','back','could','would','should','use',
        'using','used','us','let','yes','no','hey','hi','hello','ok','okay'
      ]);
      return query.trim().toLowerCase().split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
    }
  }

  // ── HELPERS ────────────────────────────────────────────────────────────────

  function _titleCase(str) {
    return str.replace(/\b\w/g, c => c.toUpperCase());
  }

  // ── SELF-REGISTER ──────────────────────────────────────────────────────────

  if (WA.ContentSearchFactory) {
    WA.ContentSearchFactory.registerProvider('wordpress', WordPressProvider);
  } else {
    _warn('WA.ContentSearchFactory not found — content/index.js must load before providers');
  }

})();

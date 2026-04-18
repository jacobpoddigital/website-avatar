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
     * Query-aware search strategy:
     *
     * Pages + custom post types are always searched — they answer navigational queries.
     * Posts are only searched when:
     *   (a) the query is informational/long-tail (question words, 4+ sig words, guide/tips/etc.), OR
     *   (b) the page search returned 0 results.
     *
     * This keeps results tight for "where is your SEO page?" style queries while
     * still surfacing blog content for "how to choose the best WordPress theme".
     *
     * Stop words stripped client-side so WP AND-matches meaningful terms in title/content.
     * If sig-word query yields nothing, full original phrase is tried as a fallback.
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

      const seen   = new Set();
      const addAll = (res, normalise, typeFilter = null) => {
        if (res.status === 'rejected') {
          _warn('Search fetch failed:', res.reason?.message || res.reason);
          return [];
        }
        const arr = Array.isArray(res.value) ? res.value : [];
        return arr
          .map(r => normalise(r))
          .filter(r => {
            if (!r.url) return false;
            if (typeFilter && !typeFilter(r)) return false;
            if (seen.has(r.url)) return false;
            seen.add(r.url);
            return true;
          });
      };

      const norm  = (r) => this._normalisePost(r);
      const normS = (r) => this._normaliseSearchResult(r);

      // ── Phase 1: pages + custom types (always) ─────────────────────────────
      const [sigPageRes, sigCustomRes, phrasePageRes] = await Promise.allSettled([
        this._fetch(makePageUrl(sigQuery)),
        this._fetch(makeCustomUrl(sigQuery)),
        sigQuery !== query ? this._fetch(makePageUrl(query)) : Promise.resolve([]),
      ]);

      const pages       = addAll(sigPageRes,    norm);
      const customTypes = addAll(sigCustomRes,  normS, r => r.type !== 'Post' && r.type !== 'Page');
      const phrasePages = addAll(phrasePageRes, norm);

      const pageCount = pages.length + phrasePages.length;

      // ── Phase 2: posts — only if long-tail query OR no pages found ─────────
      let posts = [], phrasePosts = [];

      if (longTail || pageCount === 0) {
        _log(`fetching posts (reason: ${longTail ? 'long-tail' : 'no pages found'})`);
        const [sigPostRes, phrasePostRes] = await Promise.allSettled([
          this._fetch(makePostUrl(sigQuery)),
          sigQuery !== query ? this._fetch(makePostUrl(query)) : Promise.resolve([]),
        ]);
        posts       = addAll(sigPostRes,    norm);
        phrasePosts = addAll(phrasePostRes, norm);
      }

      const results = [...pages, ...customTypes, ...phrasePages, ...posts, ...phrasePosts];

      _log(`search results: ${results.length} (pages: ${pages.length}, phrasePages: ${phrasePages.length}, custom: ${customTypes.length}, posts: ${posts.length + phrasePosts.length})`);
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
      if (/\b(guide|tips|tutorial|advice|ideas|examples|best|vs|versus|comparison|review|help|learn|understand|difference|pros|cons)\b/.test(q)) return true;
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

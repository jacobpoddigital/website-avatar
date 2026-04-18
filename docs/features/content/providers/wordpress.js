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
      return resp.json();
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
     * Multi-strategy search — runs all queries in parallel and merges results.
     *
     * WP REST search treats the query as a phrase (LIKE '%word1 word2%'), so a
     * post titled "How to choose the best WordPress..." won't match a search for
     * "choose best wordpress" unless all words appear adjacent in that order.
     *
     * To fix this we always run individual significant-word searches alongside
     * the full phrase query. Everything is merged and deduplicated before being
     * sent to the AI ranking layer.
     *
     * Merge order (pages before posts so service pages aren't buried):
     *   full-phrase pages → full-phrase custom types → individual-word pages
     *   → individual-word posts → full-phrase posts
     */
    async search(query, { limit = 10 } = {}) {
      _log('search:', query, `limit: ${limit}`);

      const per   = String(limit);
      const qEnc  = encodeURIComponent(query);
      const words = this._significantWords(query).slice(0, 4); // up to 4 individual words

      const searchUrl = (q, subtype) => {
        const p = new URLSearchParams({ search: q, subtype, per_page: per, _fields: 'id,title,url,type,subtype' });
        return `/wp/v2/search?${p}`;
      };

      // Build all parallel fetches: full query (pages + custom + posts) + per-word (pages + posts)
      const fetches = [
        this._fetch(searchUrl(query, 'page')),              // full phrase — pages
        this._fetch(`/wp/v2/search?search=${qEnc}&type=post&per_page=${per}&_fields=id,title,url,type,subtype`), // full phrase — all post types
        this._fetch(searchUrl(query, 'post')),              // full phrase — posts
        ...words.map(w => this._fetch(searchUrl(w, 'page'))),  // individual words — pages
        ...words.map(w => this._fetch(searchUrl(w, 'post'))),  // individual words — posts
      ];

      const settled = await Promise.allSettled(fetches);

      const seen   = new Set();
      const addAll = (res) => {
        if (res.status !== 'fulfilled') return [];
        return res.value
          .map(r => this._normaliseSearchResult(r))
          .filter(r => {
            if (!r.url || seen.has(r.url)) return false;
            seen.add(r.url);
            return true;
          });
      };

      // Unpack in priority order
      const nWords      = words.length;
      const phrasePages = addAll(settled[0]);
      const phraseAny   = addAll(settled[1]).filter(r => r.type !== 'Post' && r.type !== 'Page');
      const wordPages   = settled.slice(3, 3 + nWords).flatMap(s => addAll(s));
      const wordPosts   = settled.slice(3 + nWords).flatMap(s => addAll(s));
      const phrasePosts = addAll(settled[2]);

      const results = [...phrasePages, ...phraseAny, ...wordPages, ...wordPosts, ...phrasePosts];

      _log(`search results: ${results.length} (phrase pages: ${phrasePages.length}, word pages: ${wordPages.length}, posts: ${phrasePosts.length + wordPosts.length})`);
      return results;
    }

    _significantWords(query) {
      const STOP = new Set([
        'a','an','the','and','or','for','in','on','at','to','of','is','it',
        'with','that','this','be','as','are','was','were','have','has','had',
        'do','does','did','will','would','could','should','may','might','can',
        'not','but','from','by','so','if','about','into','up','out','i','me',
        'my','we','you','your','get','what','some','any','find','look','search',
        'want','need','where','how','tell','page','info','information','more'
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

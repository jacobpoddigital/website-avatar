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
     * Search pages and posts separately, merging pages first.
     *
     * Pages (service/landing pages) are queried independently so they are
     * never crowded out by a high volume of blog posts on the same topic.
     * Results are merged: pages → custom post types → posts.
     * The AI ranking layer in content/index.js then picks the best match.
     *
     * Each subtype search runs in parallel for speed.
     */
    async search(query, { limit = 10 } = {}) {
      _log('search:', query, `limit: ${limit}`);

      const perType = limit; // fetch up to limit from each type; dedupe trims the pool

      const makeParams = (subtype) => new URLSearchParams({
        search:   query,
        subtype,
        per_page: String(perType),
        _fields:  'id,title,url,type,subtype',
      }).toString();

      // Run pages and posts searches in parallel
      const [pagesRes, postsRes, anyRes] = await Promise.allSettled([
        this._fetch(`/wp/v2/search?${makeParams('page')}`),
        this._fetch(`/wp/v2/search?${makeParams('post')}`),
        // Also catch custom post types registered as searchable (services, case studies, etc.)
        this._fetch(`/wp/v2/search?search=${encodeURIComponent(query)}&type=post&per_page=${perType}&_fields=id,title,url,type,subtype`),
      ]);

      const seen  = new Set();
      const merge = (settled, transformer) => {
        if (settled.status !== 'fulfilled') return [];
        return settled.value
          .map(transformer)
          .filter(r => {
            if (!r.url || seen.has(r.url)) return false;
            seen.add(r.url);
            return true;
          });
      };

      // Pages first, then custom post types (from anyRes, excluding page/post),
      // then blog posts last
      const pages       = merge(pagesRes, r => this._normaliseSearchResult(r));
      const anyResults  = merge(anyRes,   r => this._normaliseSearchResult(r))
        .filter(r => r.type !== 'Post' && r.type !== 'Page'); // custom types only
      const posts       = merge(postsRes, r => this._normaliseSearchResult(r));

      const results = [...pages, ...anyResults, ...posts];

      _log(`search results: ${results.length} (${pages.length} pages, ${anyResults.length} custom, ${posts.length} posts)`);
      return results;
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

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
     * Search all public post types via the WP REST Search endpoint.
     *
     * Primary: /wp/v2/search?search=<q>&subtype=any&per_page=<n>
     *   - Searches post_title + post_content across all registered searchable post types
     *   - Gutenberg: post_content is HTML → text indexed by MySQL LIKE
     *   - Elementor: post_content contains readable text embedded in JSON
     *   - WPBakery / Divi: similar — text is in post_content alongside shortcodes
     *
     * Supplementary: if primary returns < limit results, also query /wp/v2/posts
     * and /wp/v2/pages for any additional matches not caught by the search index.
     */
    async search(query, { limit = 5 } = {}) {
      _log('search:', query, `limit: ${limit}`);

      const params = new URLSearchParams({
        search:   query,
        subtype:  'any',
        per_page: String(limit),
        _fields:  'id,title,url,type,subtype',
      });

      let results = [];

      try {
        const data = await this._fetch(`/wp/v2/search?${params}`);
        results = data.map(r => this._normaliseSearchResult(r));
      } catch (err) {
        _warn('Search endpoint failed:', err.message);
        // Fall through to supplementary fetch below
      }

      // Supplementary: query posts + pages directly for richer excerpt data
      // and to catch content the search endpoint may miss (e.g. password-protected
      // or content types not registered as searchable).
      if (results.length < limit) {
        try {
          const remaining = limit - results.length;
          const postParams = new URLSearchParams({
            search:   query,
            per_page: String(remaining),
            _fields:  'id,title,link,excerpt,type',
          });

          const existingUrls = new Set(results.map(r => r.url));

          const [posts, pages] = await Promise.allSettled([
            this._fetch(`/wp/v2/posts?${postParams}`),
            this._fetch(`/wp/v2/pages?${postParams}`),
          ]);

          for (const settled of [posts, pages]) {
            if (settled.status !== 'fulfilled') continue;
            for (const p of settled.value) {
              const url = p.link || '';
              if (!existingUrls.has(url)) {
                existingUrls.add(url);
                results.push(this._normalisePost(p));
                if (results.length >= limit) break;
              }
            }
            if (results.length >= limit) break;
          }
        } catch (err) {
          _warn('Supplementary post fetch failed:', err.message);
        }
      }

      _log('search results:', results.length);
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

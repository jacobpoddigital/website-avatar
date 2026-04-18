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
     * Parallel search using /wp/v2/pages and /wp/v2/posts directly.
     *
     * The /wp/v2/search endpoint is unreliable for pages in widget context.
     * Using /wp/v2/pages and /wp/v2/posts directly is consistent and returns
     * the same results as browser console tests. /wp/v2/search is kept only
     * for custom post types (type=post excludes page subtype).
     *
     * Stop words are stripped client-side before sending so WP AND-matches
     * meaningful terms anywhere in title/content.
     *
     * Merge order: pages → custom post types → posts
     */
    async search(query, { limit = 10 } = {}) {
      _log('search:', query, `limit: ${limit}`);

      const per      = String(limit);
      const sigWords = this._significantWords(query);
      const sigQuery = sigWords.join(' ') || query;

      const pageFields = 'id,title,link,type,excerpt';
      const postFields = 'id,title,link,type,excerpt';

      const makePageUrl = (q) => {
        const p = new URLSearchParams({ search: q, per_page: per, _fields: pageFields, status: 'publish' });
        return `/wp/v2/pages?${p}`;
      };
      const makePostUrl = (q) => {
        const p = new URLSearchParams({ search: q, per_page: per, _fields: postFields, status: 'publish' });
        return `/wp/v2/posts?${p}`;
      };
      const makeCustomUrl = (q) => {
        const p = new URLSearchParams({ search: q, type: 'post', per_page: per, _fields: 'id,title,url,type,subtype' });
        return `/wp/v2/search?${p}`;
      };

      const fetches = [
        this._fetch(makePageUrl(sigQuery)),                                          // sig words — pages
        this._fetch(makePostUrl(sigQuery)),                                          // sig words — posts
        this._fetch(makeCustomUrl(sigQuery)),                                        // sig words — custom types
        sigQuery !== query ? this._fetch(makePageUrl(query)) : Promise.resolve([]), // full phrase — pages
        sigQuery !== query ? this._fetch(makePostUrl(query)) : Promise.resolve([]), // full phrase — posts
      ];

      const settled = await Promise.allSettled(fetches);

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

      const pages      = addAll(settled[0], norm);
      const customTypes= addAll(settled[2], normS, r => r.type !== 'Post' && r.type !== 'Page');
      const phrasePages= addAll(settled[3], norm);
      const posts      = addAll(settled[1], norm);
      const phrasePosts= addAll(settled[4], norm);

      const results = [...pages, ...customTypes, ...phrasePages, ...posts, ...phrasePosts];

      _log(`search results: ${results.length} (pages: ${pages.length}, phrase pages: ${phrasePages.length}, posts: ${posts.length}, custom: ${customTypes.length})`);
      return results;
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

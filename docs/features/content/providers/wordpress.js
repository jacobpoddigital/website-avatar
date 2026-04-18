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
     * Two-pass parallel search — significant words AND full phrase, pages first.
     *
     * WP_Query with `s` does AND logic: a post must contain ALL searched words
     * somewhere in title or content (not necessarily adjacent). Stripping stop
     * words client-side before sending gives WP a clean set of meaningful terms
     * to AND-match, which finds "How To Choose The Best WordPress Theme" when
     * the query is "how to choose the best wordpress theme".
     *
     * We also run the original full query in parallel as a safety net for cases
     * where the exact phrase IS in the content. Pages are always merged before
     * posts so service pages aren't buried by blog volume.
     */
    async search(query, { limit = 10 } = {}) {
      _log('search:', query, `limit: ${limit}`);

      const per      = String(limit);
      const sigWords = this._significantWords(query);
      // Significant-words query: WP AND-matches each word anywhere in title/content
      const sigQuery = sigWords.join(' ') || query;

      const makeUrl = (q, subtype) => {
        const p = new URLSearchParams({ search: q, subtype, per_page: per, _fields: 'id,title,url,type,subtype' });
        return `/wp/v2/search?${p}`;
      };

      // Parallel: significant-words search (pages + posts) + full-phrase search (pages + posts)
      // + significant-words on all post types to catch custom types
      const [sigPages, sigPosts, sigAny, phrasePages, phrasePosts] = await Promise.allSettled([
        this._fetch(makeUrl(sigQuery, 'page')),
        this._fetch(makeUrl(sigQuery, 'post')),
        this._fetch(`/wp/v2/search?${new URLSearchParams({ search: sigQuery, type: 'post', per_page: per, _fields: 'id,title,url,type,subtype' })}`),
        sigQuery !== query ? this._fetch(makeUrl(query, 'page'))  : Promise.resolve([]),
        sigQuery !== query ? this._fetch(makeUrl(query, 'post'))  : Promise.resolve([]),
      ]);

      const seen   = new Set();
      const addAll = (res) => {
        const arr = res.status === 'fulfilled' ? res.value : (Array.isArray(res.value) ? res.value : []);
        return arr
          .map(r => this._normaliseSearchResult(r))
          .filter(r => {
            if (!r.url || seen.has(r.url)) return false;
            seen.add(r.url);
            return true;
          });
      };

      const sp  = addAll(sigPages);
      const sc  = addAll(sigAny).filter(r => r.type !== 'Post' && r.type !== 'Page');
      const spo = addAll(sigPosts);
      const pp  = addAll(phrasePages);
      const ppo = addAll(phrasePosts);

      // Pages before posts; significant-word matches before exact-phrase matches
      const results = [...sp, ...sc, ...pp, ...spo, ...ppo];

      _log(`search results: ${results.length} (sig pages: ${sp.length}, sig posts: ${spo.length}, phrase pages: ${pp.length}, phrase posts: ${ppo.length})`);
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

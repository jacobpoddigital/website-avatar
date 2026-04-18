/**
 * content/index.js — Content search action layer
 *
 * Platform-agnostic site content search for Website Avatar.
 * Detects the active CMS from WA_CONFIG and loads the appropriate provider.
 *
 * After fetching results from the CMS, an AI call to /classify picks the most
 * relevant result for the visitor's query. All results are shown in the card,
 * with the AI-recommended one badged as "Best match" and pinned first.
 *
 * Config-driven — never auto-detects from window globals.
 * Client KV config must include: { "cmsPlatform": "wordpress" }
 *
 * Self-registers content_search action via WA.registerAction() — actions.js is never edited.
 *
 * Load order: after actions.js, before wa-agent.js
 */

(function () {
  'use strict';

  const WA   = window.WebsiteAvatar || (window.WebsiteAvatar = {});
  const _log  = (...a) => WA.DEBUG && console.log('[WA:Content]', ...a);
  const _warn = (...a) => console.warn('[WA:Content]', ...a);

  const SEARCH_LIMIT = 100;

  // ── PROVIDER REGISTRY ──────────────────────────────────────────────────────

  const _providers = {};

  const ContentSearchFactory = {
    registerProvider(name, ProviderClass) {
      _providers[name] = ProviderClass;
      _log(`Provider registered: "${name}"`);
    },

    getProvider() {
      const config   = window.WA_CONFIG || {};
      const platform = config.cmsPlatform;
      if (!platform) {
        _log('cmsPlatform not set in config — content search disabled');
        return null;
      }
      const ProviderClass = _providers[platform];
      if (!ProviderClass) {
        _warn(`No provider registered for platform: "${platform}"`);
        return null;
      }
      _log(`Using provider: "${platform}"`);
      return new ProviderClass();
    }
  };

  WA.ContentSearchFactory = ContentSearchFactory;

  // ── ACTIVE PROVIDER ────────────────────────────────────────────────────────

  let _provider = null;

  function _getProvider() {
    if (!_provider) _provider = ContentSearchFactory.getProvider();
    return _provider;
  }

  // ── STOP WORDS ─────────────────────────────────────────────────────────────

  const STOP_WORDS = new Set([
    'a','an','the','and','or','for','in','on','at','to','of','is','it',
    'with','that','this','be','as','are','was','were','have','has','had',
    'do','does','did','will','would','could','should','may','might','can',
    'not','but','from','by','so','if','about','into','up','out','i','me',
    'my','we','you','your','get','what','some','any','give','show',
    'find','look','search','want','need','looking','something','anything',
    'where','how','tell','page','info','information','details','more'
  ]);

  function _significantWords(query) {
    return query.trim().toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  }

  // ── ACTION REGISTRATION ────────────────────────────────────────────────────

  function _registerActions() {
    if (!WA.registerAction) {
      _warn('WA.registerAction not available — actions.js must load before content/index.js');
      return;
    }

    WA.registerAction({
      type: 'content_search',
      execute: async function (action) {
        const provider = _getProvider();
        if (!provider) return { error: 'Content search not available on this site' };
        if (!provider.isAvailable()) return { error: `${provider.platformName} REST API is not reachable` };

        const { query } = action.payload || {};
        if (!query) return { error: 'query is required' };

        _log('Content search:', query, `(limit: ${SEARCH_LIMIT})`);

        try {
          // Primary: full query
          let results = await provider.search(query, { limit: SEARCH_LIMIT });

          // Fallback chain: stop-word stripped → top 3 words → individual words
          if (!results.length && query.trim().includes(' ')) {
            const words = _significantWords(query);

            if (words.length) {
              const shortQuery = words.slice(0, 3).join(' ');
              _log('Search fallback (3 words):', shortQuery);
              results = await provider.search(shortQuery, { limit: SEARCH_LIMIT });
            }

            if (!results.length && words.length) {
              const seen = new Set();
              for (const word of words.slice(0, 3)) {
                _log('Search fallback (single word):', word);
                const hits = await provider.search(word, { limit: SEARCH_LIMIT });
                for (const r of hits) {
                  if (!seen.has(r.url)) {
                    seen.add(r.url);
                    results.push(r);
                  }
                }
                if (results.length >= SEARCH_LIMIT) break;
              }
              results = results.slice(0, SEARCH_LIMIT);
            }
          }

          if (!results.length) {
            return { shown: 0 };
          }

          _queueContentResults(results.slice(0, 5));

          if (typeof WA.renderPendingContentCard === 'function') {
            WA.renderPendingContentCard();
          }

          return { shown: Math.min(results.length, 5) };

        } catch (err) {
          _warn('content_search threw:', err.message);
          return { error: err.message };
        }
      }
    });

    _log('content_search action registered');
  }

  // ── RESULTS QUEUE ──────────────────────────────────────────────────────────

  function _queueContentResults(results) {
    if (!results || !results.length) return;
    WA._pendingContentResults = results;
    _log('Content results queued —', results.length, 'items');
  }

  // ── INIT ───────────────────────────────────────────────────────────────────

  _registerActions();

  const platform = (window.WA_CONFIG || {}).cmsPlatform || 'none';
  _log(`Loaded — platform: "${platform}"`);

})();

/**
 * content/index.js — Content search action layer
 *
 * Platform-agnostic site content search for Website Avatar.
 * Detects the active CMS from WA_CONFIG and loads the appropriate provider.
 *
 * The agent calls content_search immediately when the user asks about content,
 * guides, or pages — same pattern as ecom_product_search. The provider handles
 * all search strategy (incremental keyword reduction, long-tail detection, etc.).
 * This layer stays thin: call provider, queue results, return titles to agent.
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

        _log('Content search:', query);

        try {
          const results = await provider.search(query);

          if (!results.length) {
            return { results: [], shown: 0 };
          }

          const top = results.slice(0, 5);
          _queueContentResults(top);

          // Return titles + types so the agent can reference what was found,
          // but no URLs or excerpts that would invite verbatim narration.
          return {
            results: top.map(r => ({ title: r.title, type: r.type })),
            shown:   top.length
          };

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

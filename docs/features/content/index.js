/**
 * content/index.js — find_pages action layer
 *
 * Registers the find_pages client tool for Website Avatar.
 * The agent answers from knowledge first, then calls find_pages with a
 * comma-separated list of the specific page/post titles it just mentioned.
 * This layer resolves each item to a confirmed URL via the CMS provider
 * and renders a clickable card below the agent's message.
 *
 * Config-driven — never auto-detects from window globals.
 * Client KV config must include: { "cmsPlatform": "wordpress" }
 *
 * Self-registers find_pages action via WA.registerAction() — actions.js is never edited.
 *
 * Load order: after actions.js, before wa-agent.js
 */

(function () {
  'use strict';

  const WA    = window.WebsiteAvatar || (window.WebsiteAvatar = {});
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
        _log('cmsPlatform not set in config — find_pages disabled');
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
      type: 'find_pages',
      execute: async function (action) {
        const provider = _getProvider();
        if (!provider) return { error: 'Content search not available on this site' };
        if (!provider.isAvailable()) return { error: `${provider.platformName} REST API is not reachable` };

        // ElevenLabs passes a comma-separated string — parse into individual items
        const raw   = action.payload?.items || '';
        const items = raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);
        if (!items.length) return { error: 'items is required' };

        _log('find_pages:', items);

        try {
          const seen    = new Set();
          const results = [];

          for (const item of items) {
            const hit = await provider.resolve(item);
            if (hit && !seen.has(hit.url)) {
              seen.add(hit.url);
              results.push(hit);
            }
          }

          if (!results.length) {
            return { results: [], shown: 0 };
          }

          _queueContentResults(results);

          // Agent answers first then calls this tool — render card immediately
          if (typeof WA.renderPendingContentCard === 'function') {
            WA.renderPendingContentCard();
          }

          return {
            results: results.map(r => ({ title: r.title, type: r.type })),
            shown:   results.length
          };

        } catch (err) {
          _warn('find_pages threw:', err.message);
          return { error: err.message };
        }
      }
    });

    _log('find_pages action registered');
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

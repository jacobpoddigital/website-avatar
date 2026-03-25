/**
 * website-avatar.js — Website Avatar by AdVelocity
 * Single script tag deployment. Loads modular architecture.
 *
 * Usage:
 * <script src="https://jacobpoddigital.github.io/website-avatar/website-avatar.js"
 *         data-account-id="acct_poddigital">
 * </script>
 */

(function () {

  // ── GUARD AGAINST DOUBLE LOADING ────────────────────────────────────────
  if (window._waLoaded) {
    console.warn('[WA] website-avatar.js loaded twice — ignoring duplicate');
    return;
  }
  window._waLoaded = true;

  const thisScript = document.currentScript;
  const BASE_URL   = thisScript.src.replace('/website-avatar.js', '');
  const accountId  = thisScript.getAttribute('data-account-id') || '';

  const CONFIG_URL = 'https://backend.jacob-e87.workers.dev/config';
  const PROXY_URL  = 'https://backend.jacob-e87.workers.dev/classify';

  // ── INJECT WIDGET HTML ───────────────────────────────────────────────────
  function injectHTML(agentName) {
    const name = agentName || 'Website Avatar';

    if (!document.getElementById('wa-transition')) {
      const overlay = document.createElement('div');
      overlay.id        = 'wa-transition';
      overlay.innerHTML = '<div class="wa-nav-label"></div>';
      document.body.appendChild(overlay);
    }

    if (!document.getElementById('wa-bubble')) {
      const bubble = document.createElement('button');
      bubble.id        = 'wa-bubble';
      bubble.innerHTML = '💬<div class="wa-badge" id="wa-badge"></div>';
      bubble.onclick   = () => window.WebsiteAvatar && WebsiteAvatar.toggleChat();
      document.body.appendChild(bubble);
    }

    if (!document.getElementById('wa-panel')) {
      const panel = document.createElement('div');
      panel.id        = 'wa-panel';
      panel.innerHTML = `
        <div class="wa-header">
          <div class="wa-header-info">
            <div>
              <h4>${name}</h4>
              <span id="wa-status-label">Offline</span>
            </div>
          </div>
          <div class="wa-header-actions">
            <button class="wa-close">×</button>
          </div>
        </div>
        <div class="wa-messages" id="wa-messages"></div>
        <div class="wa-input-row">
          <input type="text" id="wa-input" placeholder="Type a message…" />
          <button id="wa-send">Send</button>
        </div>
      `;
      document.body.appendChild(panel);

      panel.querySelector('.wa-close').onclick       = () => WebsiteAvatar.toggleChat();
      panel.querySelector('#wa-send').onclick        = () => WebsiteAvatar.sendMessage();
      panel.querySelector('#wa-input').onkeydown     = (e) => WebsiteAvatar.handleKey(e);
    }
  }

  // ── LOAD SCRIPTS ────────────────────────────────────────────────────────
  function loadScript(src, isModule) {
    return new Promise((resolve, reject) => {
      const s   = document.createElement('script');
      s.src     = src;
      s.defer   = true;
      s.onload  = resolve;
      s.onerror = () => reject(new Error('Failed to load: ' + src));
      if (isModule) s.type = 'module';
      document.head.appendChild(s);
    });
  }

  // ── BOOT ────────────────────────────────────────────────────────────────
  async function boot() {
    try {
      // Fetch config
      let config = {};
      if (accountId) {
        try {
          const res = await fetch(`${CONFIG_URL}?id=${accountId}`);
          if (res.ok) {
            config = await res.json();
          } else {
            console.warn('[WA] Config not found for account:', accountId);
          }
        } catch(e) {
          console.warn('[WA] Could not fetch config:', e.message);
        }
      } else {
        console.warn('[WA] No data-account-id provided');
      }

      // Set global config
      window.WA_CONFIG = {
        elevenlabsAgentId: config.elevenlabsAgentId || '',
        openaiProxyUrl:    PROXY_URL,
        agentName:         config.agentName         || 'Website Avatar',
        primaryColor:      config.primaryColor       || '#c84b2f',
        debug:             config.debug              || false
      };

      const debug = window.WA_CONFIG.debug;

      // Inject CSS
      const link = document.createElement('link');
      link.rel   = 'stylesheet';
      link.href  = BASE_URL + '/widget.css';
      document.head.appendChild(link);

      // Inject HTML
      injectHTML(window.WA_CONFIG.agentName);

      // Load modules in dependency order
      // 1. Discover (builds PAGE_MAP, FORM_MAP, PAGE_CONTEXT)
      await loadScript(BASE_URL + '/wa-discover.js');
      
      // 2. Core (state, session, bus, utilities)
      await loadScript(BASE_URL + '/wa-core.js');
      
      // 3. Modules (can load in parallel - they wait for core:ready)
      await Promise.all([
        loadScript(BASE_URL + '/wa-actions.js'),
        loadScript(BASE_URL + '/wa-decision.js'),
        loadScript(BASE_URL + '/wa-forms.js'),
        loadScript(BASE_URL + '/wa-ui.js')
      ]);
      
      // 4. Main orchestrator (waits for all modules via bus)
      await loadScript(BASE_URL + '/wa-agent.js');
      
      // 5. Bridge (last - connects to ElevenLabs)
      await loadScript(BASE_URL + '/wa-elevenlabs.js', true);

      if (debug) console.log('[WA] All modules loaded from', BASE_URL, '| account:', accountId);

    } catch(e) {
      console.error('[WA] Failed to load:', e.message);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
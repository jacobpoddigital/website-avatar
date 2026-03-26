/**
 * website-avatar.js — Website Avatar by AdVelocity
 * Single script tag deployment. Fetches config from backend by account ID.
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

  // Backend config endpoint — always this Worker
  const CONFIG_URL = 'https://backend.jacob-e87.workers.dev/config';
  // OpenAI proxy — always this Worker, never exposed in script tag
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
      const avatarUrl = config.avatar_url || '';
      if (avatarUrl) {
        bubble.innerHTML = `<img src="${avatarUrl}" alt="Chat" class="wa-bubble-avatar" /><div class="wa-badge" id="wa-badge"></div>`;
      } else {
        bubble.innerHTML = '💬<div class="wa-badge" id="wa-badge"></div>';
      }
      bubble.onclick   = () => window.WebsiteAvatar && WebsiteAvatar.toggleChat();
      document.body.appendChild(bubble);
    }

    if (!document.getElementById('wa-panel')) {
      const panel = document.createElement('div');
      panel.id        = 'wa-panel';
      const avatarUrl = config.avatar_url || '';
      const avatarHtml = avatarUrl ? `<img src="${avatarUrl}" alt="${name}" class="wa-header-avatar" />` : '';
      panel.innerHTML = `
        <div class="wa-header">
          <div class="wa-header-info">
            ${avatarHtml}
            <div>
              <h4>${name}</h4>
              <span id="wa-status-label">Offline</span>
            </div>
          </div>
        </div>
        <div class="wa-messages" id="wa-messages"></div>
        <div class="wa-input-row">
          <input type="text" id="wa-input" placeholder="Type a message…" />
          <button id="wa-send">Send</button>
        </div>
      `;
      document.body.appendChild(panel);

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
      // Fetch config from backend using account ID
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
        console.warn('[WA] No data-account-id provided on script tag');
      }

      // Set global config — proxy URL always comes from our code, never the script tag
      window.WA_CONFIG = {
        elevenlabsAgentId: config.elevenlabsAgentId || '',
        openaiProxyUrl:    PROXY_URL,
        agentName:         config.agentName         || 'Website Avatar',
        primaryColor:      config.primaryColor       || '#c84b2f',
        debug:             config.debug              || false,
        avatar_url:        config.avatar_url         || ''
      };

      const debug = window.WA_CONFIG.debug;

      // Inject CSS
      const link = document.createElement('link');
      link.rel   = 'stylesheet';
      link.href  = BASE_URL + '/widget.css';
      document.head.appendChild(link);

      // Inject HTML with agent name from config
      injectHTML(window.WA_CONFIG.agentName);

      // Load discover + agent in parallel, elevenlabs last
      await Promise.all([
        loadScript(BASE_URL + '/wa-discover.js'),
        loadScript(BASE_URL + '/wa-agent.js')
      ]);
      await loadScript(BASE_URL + '/wa-elevenlabs.js', true);

      if (debug) console.log('[WA] Website Avatar loaded from', BASE_URL, '| account:', accountId);

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
/**
 * website-avatar.js — Website Avatar by AdVelocity
 * Single script tag deployment. Loads all dependencies automatically.
 * 
 * Usage:
 * <script src="https://YOUR_R2_URL/website-avatar.js"
 *         data-agent-id="agent_xxx"
 *         data-proxy-url="https://backend.jacob-e87.workers.dev/classify"
 *         data-debug="false">
 * </script>
 */

(function () {

  // ── GUARD AGAINST DOUBLE LOADING ────────────────────────────────────────
  if (window._waLoaded) {
    console.warn('[WA] website-avatar.js loaded twice — ignoring duplicate');
    return;
  }
  window._waLoaded = true;

  // ── READ CONFIG FROM SCRIPT TAG ATTRIBUTES ──────────────────────────────
  const thisScript  = document.currentScript;
  const BASE_URL    = thisScript.src.replace('/website-avatar.js', '');
  const agentId     = thisScript.getAttribute('data-agent-id')    || '';
  const proxyUrl    = thisScript.getAttribute('data-proxy-url')   || '';
  const debug       = thisScript.getAttribute('data-debug')       === 'true';
  const primaryColor = thisScript.getAttribute('data-color')      || '#c84b2f';

  // ── INJECT WA_CONFIG BEFORE SCRIPTS LOAD ────────────────────────────────
  window.WA_CONFIG = {
    elevenlabsAgentId: agentId,
    openaiProxyUrl:    proxyUrl,
    primaryColor:      primaryColor,
    debug:             debug
  };

  // ── INJECT WIDGET HTML ───────────────────────────────────────────────────
  // All injection happens inside boot() — after DOMContentLoaded, never blocking
  function injectHTML() {
    // Page transition overlay
    if (!document.getElementById('wa-transition')) {
      const overlay = document.createElement('div');
      overlay.id        = 'wa-transition';
      overlay.innerHTML = '<div class="wa-nav-label"></div>';
      document.body.appendChild(overlay);
    }

    // Chat bubble
    if (!document.getElementById('wa-bubble')) {
      const bubble = document.createElement('button');
      bubble.id        = 'wa-bubble';
      bubble.innerHTML = '💬<div class="wa-badge" id="wa-badge"></div>';
      bubble.onclick   = () => window.WebsiteAvatar && WebsiteAvatar.toggleChat();
      document.body.appendChild(bubble);
    }

    // Chat panel
    if (!document.getElementById('wa-panel')) {
      const panel = document.createElement('div');
      panel.id        = 'wa-panel';
      panel.innerHTML = `
        <div class="wa-header">
          <div class="wa-header-info">
            <div class="wa-avatar" id="wa-avatar">A<div id="wa-avatar-ring"></div></div>
            <div>
              <h4>Website Avatar</h4>
              <span id="wa-status-label">Offline</span>
            </div>
          </div>
          <div class="wa-header-actions">
            <button id="wa-connect-btn" class="wa-header-btn">Connect</button>
            <button class="wa-close">×</button>
          </div>
        </div>
        <div class="wa-messages" id="wa-messages"></div>
        <div class="wa-input-row">
          <button id="wa-mic-btn" class="wa-mic-btn" title="Toggle voice mode">🎤</button>
          <input type="text" id="wa-input" placeholder="Type a message…" />
          <button id="wa-send">Send</button>
        </div>
      `;
      document.body.appendChild(panel);

      // Wire up events after HTML is in DOM
      panel.querySelector('.wa-close').onclick        = () => WebsiteAvatar.toggleChat();
      panel.querySelector('#wa-mic-btn').onclick      = () => WebsiteAvatar.bridge?.toggleMic();
      panel.querySelector('#wa-connect-btn').onclick  = () => WebsiteAvatar.bridge?.connect();
      panel.querySelector('#wa-send').onclick         = () => WebsiteAvatar.sendMessage();
      panel.querySelector('#wa-input').onkeydown      = (e) => WebsiteAvatar.handleKey(e);
    }
  }

  // ── LOAD SCRIPTS ────────────────────────────────────────────────────────
  function loadScript(src, isModule) {
    return new Promise((resolve, reject) => {
      const s    = document.createElement('script');
      s.src      = src;
      s.defer    = true;
      s.onload   = resolve;
      s.onerror  = () => reject(new Error('Failed to load: ' + src));
      if (isModule) s.type = 'module';
      document.head.appendChild(s);
    });
  }

  async function boot() {
    try {
      // Inject CSS here — after DOMContentLoaded, never blocking render
      const link = document.createElement('link');
      link.rel   = 'stylesheet';
      link.href  = BASE_URL + '/widget.css';
      document.head.appendChild(link);

      injectHTML();

      // Load discover + agent in parallel — both are independent of each other
      // elevenlabs must come last as it depends on WA.bus from agent
      await Promise.all([
        loadScript(BASE_URL + '/wa-discover.js'),
        loadScript(BASE_URL + '/wa-agent.js')
      ]);
      await loadScript(BASE_URL + '/wa-elevenlabs.js', true);

      if (debug) console.log('[WA] Website Avatar loaded from', BASE_URL);
    } catch(e) {
      console.error('[WA] Failed to load:', e.message);
    }
  }

  // Wait for DOMContentLoaded — never block page render
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
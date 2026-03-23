// website-avatar.js
(function() {
    // Grab the <script> tag that loaded this file
    const currentScript = document.currentScript;
  
    // Read configuration from data attributes
    const agentId = currentScript.dataset.agentId || '';
    const proxyUrl = currentScript.dataset.proxyUrl || '';
    const debug = currentScript.dataset.debug === 'true';
  
    // Base URL for loading other files (same folder as this script)
    const baseURL = currentScript.src.replace(/website-avatar\.js$/, '');
  
    // Inject CSS
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${baseURL}widget.css`;
    document.head.appendChild(css);
  
    // Global configuration
    window.WA_CONFIG = {
      elevenlabsAgentId: agentId,
      openaiProxyUrl: proxyUrl,
      debug: debug
    };
  
    // Helper to load JS scripts in order
    function loadScript(src, isModule = false) {
      return new Promise(resolve => {
        const s = document.createElement('script');
        s.src = src;
        if (isModule) s.type = 'module';
        s.onload = resolve;
        document.head.appendChild(s);
      });
    }
  
    // Load scripts in sequence after DOM is ready
    window.addEventListener('DOMContentLoaded', async () => {
      await loadScript(`${baseURL}wa-discover.js`);
      await loadScript(`${baseURL}wa-agent.js`);
      await loadScript(`${baseURL}wa-elevenlabs.js`, true);
    });
  })();
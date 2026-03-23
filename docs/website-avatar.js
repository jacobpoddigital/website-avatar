// website-avatar.js
(function() {
  // Grab the <script> tag that loaded this file
  const currentScript = document.currentScript;
  console.log("Website Avatar loader: script started");

  // Read configuration from data attributes
  const agentId = currentScript.dataset.agentId || '';
  const proxyUrl = currentScript.dataset.proxyUrl || '';
  const debug = currentScript.dataset.debug === 'true';
  console.log("Website Avatar loader: config read", { agentId, proxyUrl, debug });

  // Base URL for loading other files (same folder as this script)
  const baseURL = currentScript.src.replace(/website-avatar\.js$/, '');
  console.log("Website Avatar loader: baseURL =", baseURL);

  // Inject CSS
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = `${baseURL}widget.css`;
  css.onload = () => console.log("Website Avatar loader: widget.css loaded");
  document.head.appendChild(css);

  // Global configuration
  window.WA_CONFIG = {
    elevenlabsAgentId: agentId,
    openaiProxyUrl: proxyUrl,
    debug: debug
  };
  console.log("Website Avatar loader: window.WA_CONFIG set", window.WA_CONFIG);

  // Helper to load JS scripts in order
  function loadScript(src, isModule = false) {
    return new Promise(resolve => {
      const s = document.createElement('script');
      s.src = src;
      if (isModule) s.type = 'module';
      s.onload = () => {
        console.log(`Website Avatar loader: ${src} loaded`);
        resolve();
      };
      s.onerror = () => {
        console.error(`Website Avatar loader: failed to load ${src}`);
        resolve(); // still resolve so other scripts continue
      };
      document.head.appendChild(s);
    });
  }

  // Load scripts in sequence after DOM is ready
  window.addEventListener('DOMContentLoaded', async () => {
    console.log("Website Avatar loader: DOMContentLoaded, starting JS scripts");
    await loadScript(`${baseURL}wa-discover.js`);
    await loadScript(`${baseURL}wa-agent.js`);
    await loadScript(`${baseURL}wa-elevenlabs.js`, true);
    console.log("Website Avatar loader: all scripts loaded");
  });
})();
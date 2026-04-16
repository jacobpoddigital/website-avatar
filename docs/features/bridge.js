/**
 * features/bridge.js — Bridge Interface
 * Connection management, reconnect logic, inactivity tracking
 * Interfaces with wa-dialogue.js bridge
 */

(function () {

  const WA = window.WebsiteAvatar || (window.WebsiteAvatar = {});

  // ─── STATE ────────────────────────────────────────────────────────────────

  let _queuedMessage = null;
  let _intentionalDisconnect = false;
  let _reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 4;

  // ─── INACTIVITY ───────────────────────────────────────────────────────────

  const inactivity = {
    rounds:       0,
    max:          3,
    justConnected: false,
    reset:   function () { this.rounds = 0; this.justConnected = false; },
    onConnect: function () { this.rounds = 0; this.justConnected = true; },
    tick:    function () {
      // Don't disconnect if action or form fill is in progress
      if (WA.State && ['active','proposed'].includes(WA.State.action)) return;
      if (WA.formState && WA.formState.active) return;
      if (this.justConnected) return;
      this.rounds++;
      if (WA.DEBUG) console.log(`[WA] Inactivity: ${this.rounds}/${this.max}`);
      if (this.rounds >= this.max) {
        if (WA.DEBUG) console.log('[WA] Inactivity disconnect');
        setTimeout(disconnectBridge, 2000);
      }
    }
  };

  // ─── ONLINE/OFFLINE DETECTION ─────────────────────────────────────────────

  window.addEventListener('online', () => {
    if (WA.DEBUG) console.log('[WA] Network restored — reconnecting');
    if (WA.State?.session === 'active' && WA.bridge && !WA.bridge.isConnected()) {
      _reconnectAttempts = 0; // reset cap so a genuine reconnect is allowed
      reconnectBridge();
    }
  });

  window.addEventListener('offline', () => {
    if (WA.DEBUG) console.log('[WA] Network lost');
    if (typeof WA.appendMessage === 'function') {
      WA.appendMessage('agent', 'It looks like you\'ve gone offline. The chat will reconnect automatically when your connection is restored.');
    }
  });

  // ─── CONNECTION ───────────────────────────────────────────────────────────

  function disconnectBridge() {
    _intentionalDisconnect = true;
    return WA.bridge ? WA.bridge.disconnect() : Promise.resolve();
  }

  function reconnectBridge(delay = 0) {
    if (!navigator.onLine) {
      if (WA.DEBUG) console.log('[WA] reconnectBridge — offline, skipping');
      return;
    }
    if (WA.bridge && typeof WA.bridge.connect === 'function') {
      if (WA.bridge.isConnected && WA.bridge.isConnected()) {
        if (WA.DEBUG) console.log('[WA] reconnectBridge — already connected, skipping');
        return;
      }
      setTimeout(() => {
        if (WA.DEBUG) console.log('[WA] reconnectBridge — calling connect');
        WA.bridge.connect();
      }, delay);
      return;
    }

    // Bridge not ready — wait for bridge:ready event
    if (WA.DEBUG) console.log('[WA] reconnectBridge — waiting for bridge:ready');
    
    // Safety check: ensure bus exists before using it
    if (!WA.bus) {
      if (WA.DEBUG) console.warn('[WA] reconnectBridge — WA.bus not ready yet, retrying in 100ms');
      setTimeout(() => reconnectBridge(delay), 100);
      return;
    }
    
    function onReady() {
      WA.bus.off('bridge:ready', onReady);
      setTimeout(() => {
        if (WA.DEBUG) console.log('[WA] reconnectBridge — bridge ready, calling connect');
        WA.bridge.connect();
      }, delay);
    }
    WA.bus.on('bridge:ready', onReady);
  }

  // ─── BRIDGE CALLBACKS ─────────────────────────────────────────────────────

  function setupBridgeCallbacks() {
    WA.onBridgeConnecting = () => {
      if (WA.setState) WA.setState('connection', 'connecting');
    };

    WA.onBridgeConnected = () => {
      if (WA.setState) WA.setState('connection', 'connected');
      _reconnectAttempts = 0;
      inactivity.onConnect();
      if (WA.updateSessionButton) WA.updateSessionButton(true);
      
      // Show waiting hint only if no messages yet
      const session = WA.getSession ? WA.getSession() : {};
      if (!session.messages || !session.messages.length) {
        if (WA.showWaitingHint) WA.showWaitingHint();
      }

      // Send queued message if not in form fill
      if (_queuedMessage && WA.bridge && !WA.formState?.active) {
        const msg = _queuedMessage;
        _queuedMessage = null;
        if (WA.hideTyping) WA.hideTyping();
        setTimeout(() => {
          WA.bridge.sendText(msg);
          WA._lastUserMessage = msg;
          if (WA.setState) WA.setState('conversation', 'awaiting');
        }, 400);
      } else if (_queuedMessage && WA.formState?.active) {
        // Form fill active — route through AI
        const msg = _queuedMessage;
        _queuedMessage = null;
        if (WA.hideTyping) WA.hideTyping();
        if (typeof WA.routeFormInput === 'function') WA.routeFormInput(msg);
      }
    };

    WA.onBridgeDisconnected = () => {
      if (WA.setState) {
        WA.setState('connection', 'offline');
        WA.setState('conversation', 'idle');
      }
      if (WA.hideTyping) WA.hideTyping();
      if (WA.hideWaitingHint) WA.hideWaitingHint();
      if (WA.updateSessionButton) WA.updateSessionButton(false);

      const wasIntentional = _intentionalDisconnect;
      _intentionalDisconnect = false;

      // Unexpected drop during active session — reconnect up to MAX_RECONNECT_ATTEMPTS
      if (!wasIntentional && WA.State?.session === 'active' && !WA.formState?.active) {
        if (_reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          _reconnectAttempts++;
          if (WA.DEBUG) console.log(`[WA] Unexpected disconnect — reconnecting (attempt ${_reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
          setTimeout(reconnectBridge, 1500);
        } else {
          if (WA.DEBUG) console.log('[WA] Max reconnect attempts reached — giving up');
          if (typeof WA.appendMessage === 'function') {
            WA.appendMessage('agent', 'The connection was lost. Click the chat button to reconnect when you\'re ready.');
          }
        }
      } else if (!wasIntentional && WA.formState?.active) {
        if (WA.DEBUG) console.log('[WA] Disconnect during form fill — suppressed');
      }
    };

    WA.onAgentMessage = (text, knowledgeContext) => {
      // While a client tool (e.g. ecom_product_search) is executing, the agent
      // may send intermediate "searching..." messages. Replace the thinking bubble
      // text instead of stacking a new message — and don't save to session.
      if (WA._ecomToolActive) {
        if (WA._ecomThinkingBubble) {
          const textEl = WA._ecomThinkingBubble.querySelector('.wa-msg-text');
          if (textEl) textEl.textContent = text;
        }
        return;
      }
      // Tool just completed — remove thinking bubble before the real answer lands
      if (WA._ecomThinkingBubble) {
        WA._ecomThinkingBubble.remove();
        WA._ecomThinkingBubble = null;
      }
      if (typeof WA.agentSay === 'function') WA.agentSay(text);
      if (typeof WA.handleAgentMessage === 'function') {
        WA.handleAgentMessage(WA._lastUserMessage || '', text, knowledgeContext);
      }
    };

    WA.onUserMessage = (text) => {
      inactivity.justConnected = false;
      if (typeof WA.userSay === 'function') WA.userSay(text);
      WA._lastUserMessage = text;
      inactivity.reset();
    };

    WA.onPanelOpened = () => {
      const session = WA.getSession ? WA.getSession() : {};
      session.isOpen = true;
      if (WA.saveSession) WA.saveSession(session);
      
      // Connect if offline and not in form fill
      if (WA.bridge && !WA.bridge.isConnected() && 
          WA.State?.connection !== 'connecting' && !WA.formState?.active) {
        reconnectBridge();
      }
    };
  }

  // ─── MESSAGE QUEUE ────────────────────────────────────────────────────────

  function queueMessage(text) {
    _queuedMessage = text;
  }

  function clearQueue() {
    _queuedMessage = null;
  }

  // ─── EXPOSE ───────────────────────────────────────────────────────────────

  WA.inactivity           = inactivity;
  WA.disconnectBridge     = disconnectBridge;
  WA.reconnectBridge      = reconnectBridge;
  WA.setupBridgeCallbacks = setupBridgeCallbacks;
  WA.queueMessage         = queueMessage;
  WA.clearQueue           = clearQueue;

})();
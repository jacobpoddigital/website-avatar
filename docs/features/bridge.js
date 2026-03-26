/**
 * features/bridge.js — Bridge Interface
 * Connection management, reconnect logic, inactivity tracking
 * Interfaces with wa-elevenlabs.js bridge
 */

(function () {

    const WA = window.WebsiteAvatar || (window.WebsiteAvatar = {});
  
    // ─── STATE ────────────────────────────────────────────────────────────────
  
    let _queuedMessage = null;
    let _intentionalDisconnect = false;
  
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
  
    // ─── CONNECTION ───────────────────────────────────────────────────────────
  
    function disconnectBridge() {
      _intentionalDisconnect = true;
      return WA.bridge ? WA.bridge.disconnect() : Promise.resolve();
    }
  
    function reconnectBridge(delay = 0) {
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
        inactivity.onConnect();
        
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
  
        const wasIntentional = _intentionalDisconnect;
        _intentionalDisconnect = false;
  
        // Unexpected drop during active session — reconnect
        if (!wasIntentional && WA.State?.session === 'active' && !WA.formState?.active) {
          if (WA.DEBUG) console.log('[WA] Unexpected disconnect — reconnecting in 1500ms');
          setTimeout(reconnectBridge, 1500);
        } else if (!wasIntentional && WA.formState?.active) {
          if (WA.DEBUG) console.log('[WA] Disconnect during form fill — suppressed');
        }
      };
  
      WA.onAgentMessage = (text, knowledgeContext) => {
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
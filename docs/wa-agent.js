/**
 * wa-agent.js — Main orchestrator
 * Coordinates all modules, message flow, bridge integration, initialization.
 * Depends on: wa-core, wa-actions, wa-decision, wa-forms, wa-ui
 */

(function () {

  const WA = window.WebsiteAvatar;
  if (!WA) { console.error('[WA:Agent] Core not loaded'); return; }

  let _queuedMessage         = null;
  let _intentionalDisconnect = false;

  // ─── BRIDGE INTEGRATION ───────────────────────────────────────────────────
  WA.onBridgeConnecting = function() {
    WA.log('Bridge connecting...');
    WA.setState('connection', 'connecting');
    WA.inactivity.justConnected = true;
  };

  WA.onBridgeConnected = function() {
    WA.log('Bridge connected');
    WA.setState('connection', 'connected');
    WA.inactivity.reset();
    
    // Send queued message if exists
    if (_queuedMessage && WA.bridge.sendText) {
      WA._lastUserMessage = _queuedMessage;
      WA.bridge.sendText(_queuedMessage);
      _queuedMessage = null;
      WA.showTyping();
      WA.setState('conversation', 'awaiting');
    }

    // Start inactivity timer after grace period
    setTimeout(() => {
      WA.inactivity.justConnected = false;
      WA.inactivity.reset();
    }, 10000);
  };

  WA.onBridgeDisconnected = function() {
    WA.log('Bridge disconnected');
    WA.hideTyping();
    WA.setState('connection', 'offline');

    // Auto-reconnect if unintentional
    if (!_intentionalDisconnect && WA.session.messages.length > 0 && !WA.formState.active) {
      WA.log('Unintentional disconnect — reconnecting in 2s');
      setTimeout(() => {
        if (WA.State.connection === 'offline') {
          reconnectBridge();
        }
      }, 2000);
    }
    _intentionalDisconnect = false;
  };

  WA.onUserMessage = function(text) {
    WA.log('User spoke via voice');
    WA.userSay(text);
    WA.inactivity.reset();
  };

  WA.onAgentMessage = function(text) {
    WA.log('Agent spoke');
    WA.hideTyping();
    WA.setState('conversation', 'idle');
    WA.agentSay(text);

    const lastUserMsg = WA._lastUserMessage || '';
    if (WA.decideActions) {
      WA.decideActions(lastUserMsg, text);
    }
  };

  // ─── RECONNECT BRIDGE ─────────────────────────────────────────────────────
  WA.reconnectBridge = function() {
    if (WA.State.connection === 'connecting') return;
    if (WA.bridge && WA.bridge.isConnected()) {
      _intentionalDisconnect = true;
      WA.bridge.disconnect().then(() => {
        setTimeout(() => WA.bridge.connect(), 300);
      });
    } else if (WA.bridge && !WA.bridge.isConnected()) {
      WA.bridge.connect();
    }
  };

  // ─── MESSAGE SENDING ──────────────────────────────────────────────────────
  WA.sendMessage = function() {
    const input = document.getElementById('wa-input');
    const text  = (input ? input.value : '').trim();
    if (!text) return;

    if (input) input.value = '';
    WA.inactivity.justConnected = false;
    WA.userSay(text);
    WA.inactivity.reset();

    if (WA.bridge && WA.bridge.isConnected()) WA.dismissPendingActions();

    // Form fill takes priority
    if (WA.formState.active) {
      // This will be handled by wa-forms module
      return;
    }

    // Send to bridge if connected
    if (WA.bridge && WA.bridge.isConnected()) {
      WA.bridge.sendText(text);
      WA._lastUserMessage = text;
      WA.showTyping();
      WA.setState('conversation', 'awaiting');
      return;
    }

    // Queue message
    if (WA.bridge) {
      _queuedMessage = text;
      WA.showTyping();
      if (WA.State.connection === 'offline') {
        reconnectBridge();
      }
    }
  };

  WA.handleKey = function(e) {
    if (e.key === 'Enter') WA.sendMessage();
  };

  // ─── END SESSION ──────────────────────────────────────────────────────────
  WA.endSession = function() {
    _intentionalDisconnect = true;
    if (WA.bridge && WA.bridge.isConnected()) {
      WA.bridge.disconnect();
    }
    WA.session.messages = [];
    WA.session.actions  = [];
    WA.session.activeFormActionId = null;
    WA.session.isOpen = false;
    WA.saveSession();
    
    const msgs = document.getElementById('wa-messages');
    if (msgs) msgs.innerHTML = '';
    
    WA.setState('session', 'fresh');
    WA.setState('connection', 'offline');
    WA.setState('action', 'none');
    WA.updateSessionButton();
    
    const panel = document.getElementById('wa-panel');
    if (panel) panel.classList.remove('wa-open');
    
    WA.log('Session ended');
  };

  WA.updateSessionButton = function() {
    const existing = document.getElementById('wa-end-session-btn');
    const hasSession = WA.session.messages.length > 0;

    if (hasSession && !existing) {
      const header = document.querySelector('.wa-header-actions');
      if (!header) return;
      
      const btn = document.createElement('button');
      btn.id = 'wa-end-session-btn';
      btn.className = 'wa-btn-end';
      btn.textContent = 'End';
      btn.title = 'End conversation';
      btn.onclick = () => {
        if (confirm('End this conversation? All history will be cleared.')) {
          WA.endSession();
        }
      };
      header.insertBefore(btn, header.firstChild);
    } else if (!hasSession && existing) {
      existing.remove();
    }
  };

  // ─── DEBUG ────────────────────────────────────────────────────────────────
  WA.renderDebug = function() {
    const el = document.getElementById('wa-debug-output');
    if (!el || !WA.DEBUG) return;
    el.textContent = JSON.stringify({
      state:   WA.State,
      page:    window.location.pathname,
      msgs:    WA.session.messages.length,
      actions: WA.session.actions.map(a => ({ type: a.type, status: a.status }))
    }, null, 2);
  };

  // ─── INIT ─────────────────────────────────────────────────────────────────
  function init() {
    const hasActiveSession = WA.session.messages.length > 0;

    // Restore messages
    const msgs = document.getElementById('wa-messages');
    if (msgs) {
      msgs.innerHTML = '';
      WA.session.messages.forEach(m => {
        const el = document.createElement('div');
        el.className = `wa-msg wa-${m.role}`;
        el.textContent = m.text;
        msgs.appendChild(el);
      });
    }

    // Restore pending action cards
    WA.session.actions.forEach(a => {
      if (a.status === 'pending') {
        const handler = WA.ActionRegistry[a.type];
        WA.renderCard({
          label:    handler?.label || a.type,
          message:  a.description,
          actionId: a.id,
          buttons: [
            { text: 'Go ahead', style: 'confirm', action: () => WA.confirmAction(a.id) },
            { text: 'No thanks', style: 'deny', action: () => WA.denyAction(a.id) }
          ]
        });
      }
    });

    // Panel state
    if (WA.session.isOpen && hasActiveSession) WA.openPanel();
    if (hasActiveSession && !WA.session.isOpen) {
      const badge = document.getElementById('wa-badge');
      if (badge) badge.classList.add('wa-show');
    }

    // Fresh visit
    if (!hasActiveSession) {
      setTimeout(() => {
        const badge = document.getElementById('wa-badge');
        if (badge && !WA.session.isOpen) badge.classList.add('wa-show');
      }, 1500);
    }

    if (msgs) msgs.scrollTop = msgs.scrollHeight;
    WA.renderDebug();
    WA.checkArrival();

    // Auto-connect
    if (hasActiveSession) {
      reconnectBridge();
    }

    if (hasActiveSession) {
      WA.setState('session', 'active');
      WA.updateSessionButton();
    }
  }

  function waitForPanel(cb, attempts = 0) {
    if (document.getElementById('wa-messages')) {
      cb();
    } else if (attempts < 30) {
      setTimeout(() => waitForPanel(cb, attempts + 1), 100);
    } else {
      WA.warn('wa-messages element never appeared');
    }
  }

  // Wait for all modules
  let ready = { core: false, actions: false, decision: false, forms: false, ui: false };
  
  WA.bus.on('core:ready', () => { ready.core = true; checkReady(); });
  WA.bus.on('actions:ready', () => { ready.actions = true; checkReady(); });
  WA.bus.on('decision:ready', () => { ready.decision = true; checkReady(); });
  WA.bus.on('forms:ready', () => { ready.forms = true; checkReady(); });
  WA.bus.on('ui:ready', () => { ready.ui = true; checkReady(); });

  function checkReady() {
    if (Object.values(ready).every(v => v)) {
      WA.log('All modules loaded — initializing');
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => waitForPanel(init));
      } else {
        waitForPanel(init);
      }
    }
  }

  WA.bus.emit('agent:ready');

})();
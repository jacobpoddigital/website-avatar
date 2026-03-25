/**
 * wa-core.js — Core infrastructure
 * State machine, session management, event bus, utilities.
 */

(function () {

    window.WebsiteAvatar = window.WebsiteAvatar || {};
    const WA = window.WebsiteAvatar;
  
    // ─── CONFIG ───────────────────────────────────────────────────────────────
    const CONFIG = window.WA_CONFIG || {};
  
    WA.OPENAI_PROXY = CONFIG.openaiProxyUrl || 'https://backend.jacob-e87.workers.dev/classify';
    WA.SESSION_KEY  = 'wa_session';
    WA.PROMPTS_KEY  = 'wa_sent_prompts';
    WA.DEBUG        = CONFIG.debug || false;
  
    // ─── EVENT BUS ────────────────────────────────────────────────────────────
    if (!WA.bus) {
      const listeners = {};
      WA.bus = {
        on:   (event, fn) => { (listeners[event] = listeners[event] || []).push(fn); },
        off:  (event, fn) => { listeners[event] = (listeners[event] || []).filter(f => f !== fn); },
        emit: (event, data) => { (listeners[event] || []).forEach(fn => { try { fn(data); } catch(e) { WA.log('Bus error', e); } }); }
      };
    }
  
    // ─── LOGGING ──────────────────────────────────────────────────────────────
    WA.log  = (...args) => { if (WA.DEBUG) console.log('[WA]', ...args); };
    WA.warn = (...args) => { console.warn('[WA]', ...args); };
  
    // ─── STATE MACHINE ────────────────────────────────────────────────────────
    WA.State = {
      connection:   'offline',    // offline | connecting | connected | disconnecting
      conversation: 'idle',       // idle | awaiting | responding
      action:       'none',       // none | classifying | proposed | active | complete | error
      session:      'fresh'       // fresh | active | ended
    };
  
    WA.setState = function(layer, value, context) {
      const prev = WA.State[layer];
      if (prev === value) return;
      WA.State[layer] = value;
      WA.log(`State [${layer}]: ${prev} → ${value}`, context || '');
      WA.bus.emit('state:change', { layer, from: prev, to: value, context });
      handleStateChange(layer, value);
    };
  
    function handleStateChange(layer, value) {
      const sendBtn = document.getElementById('wa-send');
      if (!sendBtn) return;
      // Only block send for non-form-fill active actions
      const blocked = WA.State.action === 'active' && !WA.formState?.active;
      sendBtn.disabled = blocked;
      sendBtn.title    = blocked ? 'Please wait…' : '';
    }
  
    // ─── SESSION ──────────────────────────────────────────────────────────────
    function freshSession() {
      return { messages: [], actions: [], activeFormActionId: null, isOpen: false };
    }
  
    function loadSession() {
      try {
        const raw = sessionStorage.getItem(WA.SESSION_KEY);
        if (raw) {
          const s = JSON.parse(raw);
          const now = Date.now();
  
          // Mark abandoned form fills as denied
          (s.actions || []).forEach(a => {
            if (a.type === 'fill_form' && a.status === 'active') {
              a.status      = 'denied';
              a.completedAt = now;
            }
          });
  
          if (s.activeFormActionId) s.activeFormActionId = null;
  
          if (s.pendingOnArrival) {
            const alreadyArrived = (s.actions || []).some(
              a => a.type === 'navigate_then_fill' && a.status === 'complete'
            );
            if (alreadyArrived) delete s.pendingOnArrival;
          }
          return s;
        }
      } catch(e) { WA.warn('Failed to load session', e); }
      return freshSession();
    }
  
    WA.session = loadSession();
  
    WA.saveSession = function() {
      try {
        sessionStorage.setItem(WA.SESSION_KEY, JSON.stringify(WA.session));
        if (WA.renderDebug) WA.renderDebug();
      } catch(e) {
        WA.session.messages = WA.session.messages.slice(-20);
        try { sessionStorage.setItem(WA.SESSION_KEY, JSON.stringify(WA.session)); } catch(e2) {}
      }
    };
  
    WA.getSession = () => WA.session;
  
    // ─── UTILITIES ────────────────────────────────────────────────────────────
    WA.sleep = (ms) => new Promise(r => setTimeout(r, ms));
  
    WA.getPageMap = function() {
      return WA.PAGE_MAP || [];
    };
  
    WA.getContactPage = function() {
      const pages = WA.getPageMap();
      return pages.find(p =>
        /contact/i.test(p.label) ||
        /get.?in.?touch/i.test(p.label) ||
        /enquir/i.test(p.label)
      );
    };
  
    WA.navigateTo = function(url, label) {
      WA.log(`Navigating to ${label} (${url})`);
      const overlay = document.getElementById('wa-transition');
      if (overlay) {
        const labelEl = overlay.querySelector('.wa-nav-label');
        if (labelEl) labelEl.textContent = `Going to ${label}…`;
        overlay.classList.add('wa-active');
      }
  
      WA.session.pendingOnArrival = { page: url, arrived: false, ts: Date.now() };
      WA.saveSession();
  
      setTimeout(() => { window.location.href = url; }, 600);
    };
  
    // Check if we just arrived from a navigation
    WA.checkArrival = function() {
      if (!WA.session.pendingOnArrival) return;
      const p = WA.session.pendingOnArrival;
      if (p.arrived) return;
  
      const currentClean = window.location.href.replace(/\/$/, '');
      const targetClean  = p.page.replace(/\/$/, '');
  
      if (currentClean === targetClean) {
        p.arrived = true;
        WA.saveSession();
  
        const activeNav = WA.session.actions.find(
          a => (a.type === 'navigate' || a.type === 'navigate_then_fill') && a.status === 'active'
        );
  
        if (activeNav) {
          activeNav.status      = 'complete';
          activeNav.completedAt = Date.now();
          WA.saveSession();
          WA.setState('action', 'complete');
  
          if (activeNav.type === 'navigate_then_fill' && activeNav.payload.nextActionOnArrival) {
            setTimeout(() => {
              const nextAction = activeNav.payload.nextActionOnArrival;
              if (nextAction.type === 'fill_form' && WA.startFormFill) {
                const action = WA.createAction('fill_form', nextAction.description, { fields: WA.freshFields() });
                action.status    = 'active';
                action.startedAt = Date.now();
                WA.saveSession();
                WA.startFormFill(action);
              }
            }, 800);
            return;
          }
        }
  
        setTimeout(() => {
          if (WA.reconnectBridge) WA.reconnectBridge();
        }, 1000);
      }
    };
  
    // ─── INACTIVITY TIMEOUT ───────────────────────────────────────────────────
    WA.inactivity = {
      timer: null,
      justConnected: false,
      
      reset() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.fire(), 45000);
      },
      
      tick() {
        if (this.justConnected) return;
        this.reset();
      },
      
      fire() {
        if (!WA.bridge?.isConnected()) return;
        if (WA.State.action !== 'none') return;
        if (WA.session.messages.length === 0) return;
        
        const lastMsg = WA.session.messages[WA.session.messages.length - 1];
        if (lastMsg?.role === 'user') return;
        
        const sinceLastMsg = Date.now() - (lastMsg?.ts || 0);
        if (sinceLastMsg < 40000) return;
        
        WA.log('Inactivity timeout — prompting user');
        if (WA.bridge.sendText) {
          WA.bridge.sendText('[SYSTEM: User has been inactive for 45 seconds. Check if they need help or are still there.]');
        }
      }
    };
  
    WA.bus.emit('core:ready');
    WA.log('Core module loaded');
  
  })();
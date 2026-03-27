/**
 * core/state.js — State Management
 * Pure state logic: state machine, session storage, form state
 * Zero external dependencies, no DOM manipulation
 */

(function () {

    const WA = window.WebsiteAvatar || (window.WebsiteAvatar = {});
  
    // ─── STATE MACHINE ────────────────────────────────────────────────────────
  
    const State = {
      connection:   'offline',    // offline | connecting | connected | disconnecting
      conversation: 'idle',       // idle | awaiting | responding
      action:       'none',       // none | classifying | proposed | active | complete | error
      session:      'fresh'       // fresh | active | ended
    };
  
    function setState(layer, value, context) {
      const prev = State[layer];
      if (prev === value) return;
      State[layer] = value;
      if (WA.DEBUG) console.log(`[WA] State [${layer}]: ${prev} → ${value}`, context || '');
      if (WA.bus && typeof WA.bus.emit === 'function') {
        WA.bus.emit('state:change', { layer, from: prev, to: value, context });
      }
      handleStateChange(layer, value, context);
    }
  
    function handleStateChange(layer, value) {
      const sendBtn = document.getElementById('wa-send');
      if (!sendBtn) return;
      // Only block send for non-form-fill active actions
      const blocked = State.action === 'active' && !formState.active;
      sendBtn.disabled = blocked;
      sendBtn.title    = blocked ? 'Please wait…' : '';
    }
  
    // ─── SESSION STORAGE ──────────────────────────────────────────────────────
  
    const SESSION_KEY = 'wa_session';
  
    function freshSession() {
      return { 
        messages: [], 
        actions: [], 
        activeFormActionId: null, 
        isOpen: false,
        lastUrlValidationFailure: null
      };
    }
  
    function loadSession() {
      try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        if (raw) {
          const s = JSON.parse(raw);
          const now = Date.now();
  
          // Mark abandoned active fill_form as denied
          (s.actions || []).forEach(a => {
            if (a.type === 'fill_form' && a.status === 'active') {
              a.status      = 'denied';
              a.completedAt = now;
            }
          });
  
          // Clear activeFormActionId
          if (s.activeFormActionId) {
            s.activeFormActionId = null;
          }
  
          // Clear stale pendingOnArrival
          if (s.pendingOnArrival) {
            const alreadyArrived = (s.actions || []).some(
              a => a.type === 'navigate_then_fill' && a.status === 'complete'
            );
            if (alreadyArrived) delete s.pendingOnArrival;
          }
          return s;
        }
      } catch(e) { 
        console.warn('[WA] Failed to load session', e); 
      }
      return freshSession();
    }
  
    function saveSession(session) {
      try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
        if (typeof WA.renderDebug === 'function') WA.renderDebug();
      } catch(e) {
        // sessionStorage full — trim oldest messages
        session.messages = session.messages.slice(-20);
        try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch(e2) {}
      }
    }
  
    // ─── FORM STATE ───────────────────────────────────────────────────────────
  
    const formState = {
      active:  false,
      action:  null
    };
  
    function resetFormState() {
      formState.active = false;
      formState.action = null;
      if (WA._completeFormFillAttempts !== undefined) {
        WA._completeFormFillAttempts = 0;
      }
      if (WA.formAIController) {
        WA.formAIController.abort();
        WA.formAIController = null;
      }
    }
  
    // ─── EXPOSE ───────────────────────────────────────────────────────────────
  
    WA.State           = State;
    WA.setState        = setState;
    WA.loadSession     = loadSession;
    WA.saveSession     = saveSession;
    WA.freshSession    = freshSession;
    WA.formState       = formState;
    WA.resetFormState  = resetFormState;
  
  })();
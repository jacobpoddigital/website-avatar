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
  
    // ─── BACKEND SESSION API ──────────────────────────────────────────────────
    // Session persistence has been moved from sessionStorage to the backend
    // /session endpoints. This enables cross-page session continuity managed
    // centrally by the Cloudflare Worker (KV for state, D1 for transcripts).

    // Backend URL from WA_CONFIG.sessionUrl or default worker URL
    const BACKEND_URL = (window.WA_CONFIG || {}).sessionUrl
      || 'https://backend.jacob-e87.workers.dev/session';

    /**
     * Returns a stable session ID persisted in localStorage.
     * Generated once and reused across page navigations for the same browser session.
     * Cleared by clearSession() when the user explicitly ends a session.
     */
    function getSessionId() {
      let id = localStorage.getItem('wa_session_id');
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem('wa_session_id', id);
      }
      return id;
    }

    function freshSession() {
      return {
        messages: [],
        actions: [],
        activeFormActionId: null,
        isOpen: false,
        sentPrompts: []   // replaces the separate wa_sent_prompts sessionStorage key
      };
    }

    /**
     * Loads session state from the backend (GET /session?session_id=...).
     * Now async — callers must await. Falls back to freshSession() on error or
     * when no session exists yet for this session_id.
     */
    async function loadSession() {
      const sessionId = getSessionId();
      try {
        const response = await fetch(
          `${BACKEND_URL}?session_id=${encodeURIComponent(sessionId)}`
        );
        if (response.ok) {
          const data = await response.json();
          // Backend returns { fresh: true } when no prior state exists in KV
          if (data.fresh) return freshSession();

          const s = data;
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

          // Ensure sentPrompts exists (for sessions saved before this field was added)
          if (!s.sentPrompts) s.sentPrompts = [];

          return s;
        }
      } catch(e) {
        console.warn('[WA] Failed to load session from backend', e);
        // Fall back to the local backup written by saveSession()
        try {
          const backup = sessionStorage.getItem('wa_session_backup');
          if (backup) {
            console.log('[WA] Loaded session from local backup');
            return JSON.parse(backup);
          }
        } catch {}
      }
      return freshSession();
    }

    /**
     * Saves session state to the backend (POST /session with session_id → KV).
     * Fire-and-forget: returns a Promise but callers do not need to await it.
     * Replaces all direct sessionStorage.setItem(SESSION_KEY, ...) calls.
     */
    let _saveFailures = 0;

    async function saveSession(session) {
      const sessionId = getSessionId();
      // Always write a local backup so the session survives a temporary backend outage.
      try { sessionStorage.setItem('wa_session_backup', JSON.stringify(session)); } catch {}

      // Retry up to 3 times with a 1-second gap before giving up.
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await fetch(BACKEND_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId, session_data: session })
          });
          _saveFailures = 0;
          if (typeof WA.renderDebug === 'function') WA.renderDebug();
          return; // success — exit early
        } catch(e) {
          console.warn(`[WA] Session save attempt ${attempt}/3 failed:`, e.message);
          if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
        }
      }

      // All 3 attempts failed
      _saveFailures++;
      // After 3 consecutive multi-attempt failures, tell the user.
      if (_saveFailures === 3 && typeof WA.appendMessage === 'function') {
        WA.appendMessage('agent', "Just a heads up — I'm having trouble saving your conversation right now. If you refresh the page, it should restore.");
      }
    }

    /**
     * Debounced variant of saveSession() for high-frequency write paths (form-fill,
     * checkbox callbacks). Coalesces rapid calls into a single KV write 500ms after
     * the last call, preventing write amplification without risking data loss on
     * critical state changes (those callers use saveSession directly).
     */
    let _saveDebounceTimer = null;
    function saveSessionDebounced(session) {
      clearTimeout(_saveDebounceTimer);
      _saveDebounceTimer = setTimeout(() => saveSession(session), 500);
    }

    /**
     * Clears session state from the backend KV and removes the local session ID.
     * Called on endSession() to ensure a clean slate for the next conversation.
     */
    async function clearSession() {
      const sessionId = getSessionId();
      try {
        // Overwrite with a fresh session to reset KV state before removing the ID
        await fetch(BACKEND_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, session_data: freshSession() })
        });
      } catch(e) {
        console.warn('[WA] Failed to clear session on backend', e);
      }
      // Remove session ID so the next getSessionId() call generates a fresh one
      localStorage.removeItem('wa_session_id');
      try { sessionStorage.removeItem('wa_session_backup'); } catch {}
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
  
    WA.State                 = State;
    WA.setState              = setState;
    WA.loadSession           = loadSession;
    WA.saveSession           = saveSession;
    WA.saveSessionDebounced  = saveSessionDebounced;
    WA.freshSession          = freshSession;
    WA.clearSession          = clearSession;
    WA.getSessionId          = getSessionId;
    WA.formState       = formState;
    WA.resetFormState  = resetFormState;
  
  })();
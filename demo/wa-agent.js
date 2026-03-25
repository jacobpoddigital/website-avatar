/**
 * wa-agent.js — Website Avatar by AdVelocity
 * Core agent engine: state machine, session, action registry, UI, OpenAI classification.
 * Depends on wa-discover.js (runs first) and wa-elevenlabs.js (runs after).
 */

(function () {

  // ─── NAMESPACE ────────────────────────────────────────────────────────────
  window.WebsiteAvatar = window.WebsiteAvatar || {};
  const WA = window.WebsiteAvatar;

  // ─── CONFIG ───────────────────────────────────────────────────────────────
  // Read from window.WA_CONFIG injected by platform plugin, or use defaults.
  const CONFIG = window.WA_CONFIG || {};

  const OPENAI_PROXY   = CONFIG.openaiProxyUrl || 'https://backend.jacob-e87.workers.dev/classify';
  const SESSION_KEY    = 'wa_session';
  const PROMPTS_KEY    = 'wa_sent_prompts';
  const DEBUG          = CONFIG.debug || false;
  WA.DEBUG             = DEBUG;

  // ─── EVENT BUS ────────────────────────────────────────────────────────────
  // Ensure bus exists (discover.js creates it, but agent may load standalone)
  if (!WA.bus) {
    const listeners = {};
    WA.bus = {
      on:   (event, fn) => { (listeners[event] = listeners[event] || []).push(fn); },
      off:  (event, fn) => { listeners[event] = (listeners[event] || []).filter(f => f !== fn); },
      emit: (event, data) => { (listeners[event] || []).forEach(fn => { try { fn(data); } catch(e) { log('Bus error', e); } }); }
    };
  }

  // ─── LOGGING ──────────────────────────────────────────────────────────────
  function log(...args)  { if (DEBUG) console.log('[WA]', ...args); }
  function warn(...args) { console.warn('[WA]', ...args); }

  // ─── STATE MACHINE ────────────────────────────────────────────────────────
  // Single source of truth for what's happening right now.
  // All behaviour is a reaction to state transitions.

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
    log(`State [${layer}]: ${prev} → ${value}`, context || '');
    WA.bus.emit('state:change', { layer, from: prev, to: value, context });
    handleStateChange(layer, value, context);
  }

  function handleStateChange(layer, value) {
    const sendBtn = document.getElementById('wa-send');
    if (!sendBtn) return;
    // In voice mode — disable while agent speaking or action active
    // In text mode — only disable while action active (user can type while agent speaks)
    const blocked = State.action === 'active' ||
                    (State.conversation === 'responding' && WA._voiceMode);
    sendBtn.disabled = blocked;
    sendBtn.title    = blocked ? 'Please wait…' : '';
  }

  // ─── SESSION ──────────────────────────────────────────────────────────────

  function freshSession() {
    return { messages: [], actions: [], activeFormActionId: null, isOpen: false };
  }

  function loadSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) return JSON.parse(raw);
    } catch(e) { warn('Failed to load session', e); }
    return freshSession();
  }

  function saveSession() {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      renderDebug();
    } catch(e) {
      // sessionStorage full — trim oldest messages and retry
      session.messages = session.messages.slice(-20);
      try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch(e2) {}
    }
  }

  function loadSentPrompts() {
    try {
      const raw = sessionStorage.getItem(PROMPTS_KEY);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch(e) { return new Set(); }
  }


  let session     = loadSession();
  let sentPrompts = loadSentPrompts();

  // Expose session for wa-elevenlabs.js to read
  WA.getSession = () => session;

  // ─── ACTION REGISTRY ──────────────────────────────────────────────────────
  // Each action type registers its own execute, error, and complete handlers.
  // Adding a new action type = one registration block. Core engine never changes.

  const ActionRegistry = {};

  function registerAction(def) {
    // def: { type, label, permissionLevel, execute, onError, onComplete }
    ActionRegistry[def.type] = def;
    log(`Action registered: ${def.type}`);
  }

  async function executeAction(action) {
    const handler = ActionRegistry[action.type];
    if (!handler) {
      warn(`No handler for action type: ${action.type}`);
      agentSay("I don't know how to do that yet — I'll let the team know.");
      setState('action', 'error');
      return;
    }

    setState('action', 'active');
    action.status    = 'active';
    action.startedAt = Date.now();
    saveSession();
    updateAbortButton();

    try {
      await handler.execute(action);
      action.status      = 'complete';
      action.completedAt = Date.now();
      saveSession();
      setState('action', 'complete');
      updateAbortButton();
      if (handler.onComplete) await handler.onComplete(action);
    } catch (err) {
      warn(`Action ${action.type} failed:`, err);
      action.status      = 'failed';
      action.error       = { message: err.message, retryable: !!err.retryable };
      action.completedAt = Date.now();
      saveSession();
      setState('action', 'error');
      updateAbortButton();
      if (handler.onError) {
        await handler.onError(err, action);
      } else {
        agentSay("Something went wrong — please try again or complete this manually.");
      }
    }
  }

  // ─── REGISTERED ACTIONS ───────────────────────────────────────────────────

  // NAVIGATE
  registerAction({
    type:            'navigate',
    label:           'Navigate to page',
    permissionLevel: 'propose',

    execute: async (action) => {
      const { targetPage, targetLabel } = action.payload;
      agentSay(`Navigating you to the ${targetLabel}…`);
      await sleep(800);
      navigateTo(targetPage, targetLabel);
    },

    onError: async (err, action) => {
      agentSay(`I couldn't navigate to ${action.payload.targetLabel}. You can find it in the menu.`);
      reconnectBridge();
    },

    onComplete: async () => {
      // Reconnect happens in checkArrival() on the new page
    }
  });

  // FILL FORM
  registerAction({
    type:            'fill_form',
    label:           'Fill contact form',
    permissionLevel: 'propose',

    execute: async (action) => {
      // Returns a Promise that resolves only after the user submits or cancels
      // This keeps the action in 'active' state until submission is confirmed
      await new Promise(resolve => {
        action._resolveFormFill = resolve;
        startFormFill(action);
      });
    },

    onError: async (err, action) => {
      agentSay("I had trouble filling the form. You can complete it manually — all the fields are visible.");
      reconnectBridge();
    },

    onComplete: async (action) => {
      // finishFormFill calls action._resolveFormFill which resolves the Promise above
      // reconnectBridge happens here after true completion
      setTimeout(reconnectBridge, 1000);
    }
  });

  // NAVIGATE THEN FILL
  registerAction({
    type:            'navigate_then_fill',
    label:           'Go to contact page and fill form',
    permissionLevel: 'propose',

    execute: async (action) => {
      const { targetPage, targetLabel, nextActionOnArrival } = action.payload;
      agentSay(`I'll take you to the ${targetLabel} and we'll fill out the form together.`);
      session.pendingOnArrival = { page: targetPage, action: nextActionOnArrival };
      saveSession();
      await sleep(1000);
      navigateTo(targetPage, targetLabel);
    },

    onError: async (err, action) => {
      agentSay(`I couldn't navigate to ${action.payload.targetLabel}. You can find it in the menu.`);
      reconnectBridge();
    },

    onComplete: async () => {}
  });

  // ─── PAGE / FORM HELPERS ──────────────────────────────────────────────────

  function getPageMap()    { return WA.PAGE_MAP || window.PAGE_MAP || []; }
  function getFormMap()    { return WA.FORM_MAP || window.FORM_MAP || []; }

  function getContactPage() {
    return getPageMap().find(p =>
      p.label.toLowerCase().includes('contact') ||
      p.keywords.some(k => k.includes('contact')) ||
      p.file.includes('contact')
    ) || null;
  }

  function resolveTargetPage(text) {
    const lower = (text || '').toLowerCase();
    const pages = getPageMap();
    for (const page of pages) {
      if (page.keywords.some(kw => lower.includes(kw))) return page;
    }
    return pages[0] || null;
  }

  function freshFields() {
    const forms = getFormMap();
    if (!forms.length) return [];
    // Use the form with the most fields — that's the main contact form
    return forms[0].fields.map(f => ({ ...f, value: null }));
  }

  function isOnContactPage() {
    const contact = getContactPage();
    if (!contact) return false;
    const current = window.location.href.replace(/\/$/, '');
    const target  = contact.file.replace(/\/$/, '');
    return current === target || window.location.pathname === new URL(contact.file).pathname;
  }

  // ─── NAVIGATION ───────────────────────────────────────────────────────────

  function navigateTo(url, label) {
    const overlay  = document.getElementById('wa-transition');
    const navLabel = overlay ? overlay.querySelector('.wa-nav-label') : null;
    if (navLabel) navLabel.textContent = `Heading to ${label}…`;
    if (overlay)  overlay.classList.add('active');

    // Disconnect bridge before navigation — will reconnect on new page
    disconnectBridge();
    setTimeout(() => { window.location.href = url; }, 400);
  }

  // ─── ON-ARRIVAL ───────────────────────────────────────────────────────────
  // Runs on every page load — checks if we arrived via a navigate action.

  function checkArrival() {
    // Simple navigate — mark complete, open panel and reconnect
    const navAction = session.actions.find(a => a.type === 'navigate' && a.status === 'active');
    if (navAction) {
      navAction.status      = 'complete';
      navAction.completedAt = Date.now();
      saveSession();
      setState('action', 'complete');
      openPanel();
      reconnectBridge();
      return;
    }

    // Navigate then fill — check we're on the right page
    if (!session.pendingOnArrival) return;
    const { page, action } = session.pendingOnArrival;

    const currentPath = window.location.pathname.replace(/\/$/, '');
    const targetPath  = new URL(page, window.location.href).pathname.replace(/\/$/, '');

    if (currentPath !== targetPath) return;

    delete session.pendingOnArrival;
    saveSession();

    openPanel();

    setTimeout(async () => {
      // Discover fields now that we're on the contact page
      const fields = freshFields();
      if (!fields.length) {
        agentSay("I'm here but I couldn't find the contact form. You can fill it in manually.");
        reconnectBridge();
        return;
      }
      action.payload.fields = fields;
      agentSay("We're here! Let's fill out that contact form.");
      const fullAction = createAction('fill_form', action.description, action.payload);
      await executeAction(fullAction);
    }, 900);
  }

  // ─── FORM FILL ────────────────────────────────────────────────────────────

  let formState = {
    active:  false,  // is a form fill in progress
    action:  null    // the active fill_form action
  };

  async function startFormFill(action) {
    if (formState.active) return;

    formState.active = true;
    formState.action = action;

    session.activeFormActionId = action.id;
    saveSession();

    openPanel();
    updateAbortButton();
    repopulateFields(action);

    // Kick off AI — do NOT await, the fill_form Promise stays open until finishFormFill
    handleFormInputAI('__RESUME__');
  }


  // ─── AI FORM FILL ─────────────────────────────────────────────────────────
  // OpenAI manages the entire form fill conversation.
  // Handles: field filling, corrections, validation, abort, submit readiness.

  let formAIController = null; // module-level so resetFormState can abort it

  async function handleFormInputAI(userText) {
    if (!formState.action) return; // guard — form fill may have been reset

    // Cancel any in-flight request
    if (formAIController) formAIController.abort();
    formAIController = new AbortController();

    const fields   = formState.action.payload.fields;
    const isResume = userText === '__RESUME__';

    // Build field summary for prompt
    const fieldSummary = fields.map(f =>
      `- ${f.label} (name: ${f.name}, type: ${f.type}${f.required ? ', required' : ', optional'}): ${f.value ? '"' + f.value + '"' : 'empty'}`
    ).join('\n');

    // Recent conversation for context
    const recentMsgs = session.messages.slice(-6).map(m =>
      `${m.role === 'user' ? 'User' : 'Agent'}: ${m.text}`
    ).join('\n');

    const prompt = `You are managing a form fill conversation for a website contact form.

FORM FIELDS (name | type | required | current value):
${fieldSummary}

RECENT CONVERSATION:
${recentMsgs}

USER JUST SAID: "${isResume ? '(resuming form fill — greet user and ask for next empty required field)' : userText}"

Reply with JSON only, no explanation:
{
  "action": "fill_field" | "correct_field" | "submit_ready" | "abort" | "ask_again",
  "field_name": "name attribute of field to update, or null",
  "value": "value to set, or null",
  "message": "what to say to the user — natural, warm, confirm what was filled and ask for next empty field",
  "all_required_filled": true | false
}

Rules:
- abort: user wants to stop, cancel, or leave (any phrasing)
- fill_field: user provided a value for a field
- correct_field: user is correcting a previously filled field
- submit_ready: all required fields are filled and user confirmed or nothing left to ask
- ask_again: input was unclear or ambiguous
- After filling a field, message should confirm it and ask for the next empty required field
- If all required fields are now filled, set action to submit_ready and all_required_filled to true
- Never ask for a field that already has a value unless user is correcting it
- Validate email format, phone must have at least 7 digits — if invalid ask user to correct it`;

    showTyping();
    log('→ Form AI request sent');
    const t0 = Date.now();

    try {
      const res = await fetch(OPENAI_PROXY, {
        method:  'POST',
        signal:  formAIController.signal,
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ prompt, maxTokens: 350 })
      });

      if (!res.ok) throw new Error(`Proxy error: ${res.status}`);

      const data = await res.json();
      const raw  = data.content || '';
      log(`← Form AI ${Date.now() - t0}ms:`, raw.trim());

      let parsed;
      try {
        parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      } catch(e) {
        warn('Form AI bad JSON:', raw);
        hideTyping();
        agentSay("Sorry, I didn't catch that — could you say it again?");
        return;
      }

      hideTyping();

      if (parsed.action === 'abort') {
        abandonFormFill();
        return;
      }

      if (parsed.action === 'fill_field' || parsed.action === 'correct_field') {
        const field = fields.find(f => f.name === parsed.field_name);
        if (field && parsed.value) {
          field.value = parsed.value;
          const el = getFieldElement(field);
          if (el) {
            el.classList.add('wa-filling');
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            fillField(el, parsed.value);
          }
          saveSession();
        }
      }

      // submit_ready — go to confirmation card, don't agentSay here
      // completeFormFill handles the summary message
      if (parsed.action === 'submit_ready' || parsed.all_required_filled) {
        setTimeout(completeFormFill, 400);
        return;
      }

      if (parsed.message) agentSay(parsed.message);

    } catch(e) {
      if (e.name === 'AbortError') { log('Form AI cancelled'); return; }
      warn('Form AI error:', e.message);
      hideTyping();
      agentSay("I'm having trouble processing that — could you try again?");
    }
  }

  let _completeFormFillAttempts = 0;

  function completeFormFill() {
    if (!formState.action) return;
    const fields  = formState.action.payload.fields;
    const missing = fields.filter(f => f.required && (!f.value || !f.value.trim()));

    // Safety net — max 2 retries to prevent infinite loop
    if (missing.length) {
      _completeFormFillAttempts++;
      if (_completeFormFillAttempts <= 2) {
        handleFormInputAI('__RESUME__');
      } else {
        _completeFormFillAttempts = 0;
        agentSay(`I still need: ${missing.map(f => f.label).join(', ')}. Please provide these to continue.`);
      }
      return;
    }
    _completeFormFillAttempts = 0;

    const filled  = fields.filter(f => f.value);
    const summary = filled.map(f => `${f.label}: ${f.value}`).join(', ');

    agentSay(`All set! I've filled in ${summary}. Ready to send?`);

    renderCard({
      label:   'Ready to submit',
      message: 'Shall I submit the form now?',
      buttons: [
        { text: 'Submit', action: () => submitForm() },
        { text: 'Cancel', action: () => cancelFormFill(), style: 'deny' }
      ]
    });
  }

  async function submitForm() {
    // Mark action
    if (formState.action) {
      formState.action.status      = 'complete';
      formState.action.completedAt = Date.now();
    }
    const parent = session.actions.find(a => a.type === 'navigate_then_fill' && a.status === 'active');
    if (parent) { parent.status = 'complete'; parent.completedAt = Date.now(); }
    session.activeFormActionId = null;
    saveSession();

    // If CF7 form — listen for response before declaring success
    const formEl = document.querySelector('.wpcf7-form');
    if (formEl) {
      await submitCF7Form(formEl);
    } else {
      // Generic form — click submit button
      await submitGenericForm();
    }
  }

  function submitCF7Form(formEl) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        // Timed out waiting for CF7 response — fall back gracefully
        warn('CF7 response timed out');
        handleFormSubmitFallback();
        resolve();
      }, 10000);

      const onSuccess = () => {
        clearTimeout(timeout);
        cleanup();
        finishFormFill('success');
        resolve();
      };

      const onInvalid = (e) => {
        clearTimeout(timeout);
        cleanup();
        // Re-enter fill for failed fields
        handleCF7ValidationError(e.detail);
        resolve();
      };

      const onSpam = () => {
        clearTimeout(timeout);
        cleanup();
        agentSay("The form was flagged — please click the submit button manually to complete your enquiry.");
        highlightSubmitButton();
        reconnectBridge();
        resolve();
      };

      const onFailed = () => {
        clearTimeout(timeout);
        cleanup();
        agentSay("There was a problem sending the form. Please try submitting manually or try again in a moment.");
        reconnectBridge();
        resolve();
      };

      function cleanup() {
        WA.bus.off('form:submitted', onSuccess);
        WA.bus.off('form:invalid',   onInvalid);
        WA.bus.off('form:spam',      onSpam);
        WA.bus.off('form:failed',    onFailed);
      }

      WA.bus.on('form:submitted', onSuccess);
      WA.bus.on('form:invalid',   onInvalid);
      WA.bus.on('form:spam',      onSpam);
      WA.bus.on('form:failed',    onFailed);

      // Click the submit button
      const submitBtn = formEl.querySelector('[type="submit"], .wpcf7-submit');
      if (submitBtn) {
        log('Clicking CF7 submit button');
        submitBtn.click();
      } else {
        warn('CF7 submit button not found');
        handleFormSubmitFallback();
        resolve();
      }
    });
  }

  async function submitGenericForm() {
    const submitBtn = document.querySelector(
      'form [type="submit"], .btn-submit, button[type="submit"], input[type="submit"]'
    );

    if (submitBtn) {
      submitBtn.click();
      await sleep(1000);
      finishFormFill('success');
    } else {
      agentSay("The form is filled — please click the submit button to send your enquiry.");
      highlightSubmitButton();
      resetFormState();
      setState('action', 'none');
    }
  }

  function finishFormFill(outcome) {
    document.querySelectorAll('.wa-filling').forEach(el => el.classList.remove('wa-filling'));
    session.activeFormActionId = null;
    saveSession();
    // Update the action card status to complete
    if (formState.action) {
      updateActionCardStatus(formState.action.id, 'complete');
    }
    // Resolve the Promise in fill_form execute — this lets executeAction mark it complete
    // executeAction.onComplete handles reconnect
    if (formState.action?._resolveFormFill) {
      formState.action._resolveFormFill();
    }
    resetFormState();
    // setState handled by executeAction after Promise resolves
  }

  function handleCF7ValidationError(detail) {
    // Reset failed fields and let AI re-ask
    const failedInputs = document.querySelectorAll('.wpcf7-not-valid');
    if (failedInputs.length && formState.action) {
      const failedNames = Array.from(failedInputs).map(el => el.getAttribute('name'));
      formState.action.payload.fields.forEach(f => {
        if (failedNames.includes(f.name)) f.value = null;
      });
      formState.active = true;
      handleFormInputAI('__RESUME__');
      return;
    }
    agentSay("Some fields need correcting — please check the form.");
    reconnectBridge();
  }

  function handleFormSubmitFallback() {
    agentSay("The form is filled — please click the submit button to send your enquiry.");
    highlightSubmitButton();
    reconnectBridge();
  }

  function highlightSubmitButton() {
    const btn = document.querySelector('.wpcf7-submit, [type="submit"], .btn-submit');
    if (btn) {
      btn.style.boxShadow = '0 0 0 3px rgba(200,75,47,0.5)';
      btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function cancelFormFill() {
    if (formState.action) {
      formState.action.status      = 'denied';
      formState.action.completedAt = Date.now();
      if (formState.action._resolveFormFill) formState.action._resolveFormFill();
    }
    session.activeFormActionId = null;
    saveSession();
    resetFormState();
    setState('action', 'none');
    setTimeout(reconnectBridge, 800);
  }

  function abandonFormFill() {
    if (formState.action) {
      formState.action.status      = 'denied';
      formState.action.completedAt = Date.now();
      if (formState.action._resolveFormFill) formState.action._resolveFormFill();
    }
    session.activeFormActionId = null;
    document.querySelectorAll('.wa-filling').forEach(el => el.classList.remove('wa-filling'));
    saveSession();
    resetFormState();
    setState('action', 'none');
    setTimeout(reconnectBridge, 800);
  }

  function resetFormState() {
    formState.active = false;
    formState.action = null;
    _completeFormFillAttempts = 0;
    if (formAIController) { formAIController.abort(); formAIController = null; }
    updateAbortButton();
  }

  function repopulateFields(action) {
    action.payload.fields.forEach(f => {
      if (f.value !== null) {
        const el = getFieldElement(f);
        if (el) fillField(el, f.value);
      }
    });
  }

  // ─── FIELD UTILITIES ──────────────────────────────────────────────────────

  function getFieldElement(field) {
    if (field.id) {
      const el = document.getElementById(field.id);
      if (el) return el;
    }
    if (field.name) {
      const el = document.querySelector(`[name="${field.name}"]`);
      if (el) return el;
    }
    return null;
  }

  // Fill a field with proper DOM events — passes CF7 validation and reCAPTCHA
  function fillField(el, value) {
    if (!el) return;
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event('input',    { bubbles: true }));
    el.dispatchEvent(new Event('change',   { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    el.blur();
  }



  // ─── END SESSION ─────────────────────────────────────────────────────────
  // First-class action — clears everything and returns to fresh state.

  function endSession() {
    log('Ending session');

    // Disconnect bridge first
    disconnectBridge();

    // Clear all session storage
    try { sessionStorage.removeItem(SESSION_KEY); } catch(e) {}
    try { sessionStorage.removeItem(PROMPTS_KEY); } catch(e) {}

    // Reset session object — isOpen false so panel stays closed on next load
    session = freshSession();
    session.isOpen = false;
    sentPrompts = new Set();

    // Reset form state
    resetFormState();

    // Reset state machine
    State.connection   = 'offline';
    State.conversation = 'idle';
    State.action       = 'none';
    State.session      = 'fresh';

    // Reset inactivity
    inactivity.reset();

    // Clear 11labs sent prompts
    WA._sentReconnectPrompts = new Set();

    // Clear UI messages
    const msgs = document.getElementById('wa-messages');
    if (msgs) msgs.innerHTML = '';

    // Remove buttons
    const endBtn   = document.getElementById('wa-end-session-btn');
    const abortBtn = document.getElementById('wa-abort-btn');
    if (endBtn)   endBtn.remove();
    if (abortBtn) abortBtn.remove();

    // Close the panel
    const panel = document.getElementById('wa-panel');
    if (panel) panel.classList.remove('wa-open');

    // Show greeting directly in DOM without saving to session
    // so session stays empty (fresh) after end
    setTimeout(() => {
      if (msgs) {
        const el = document.createElement('div');
        el.className   = 'wa-msg wa-agent';
        el.textContent = 'Session ended. Open the chat to start a new conversation.';
        msgs.appendChild(el);
      }
    }, 300);

    saveSession();
    renderDebug();
    log('Session ended — fresh state restored');
  }

  function updateSessionButton() {
    const existing = document.getElementById('wa-end-session-btn');
    // Place below messages, above input row
    const panel    = document.getElementById('wa-panel');
    if (!panel) return;

    const hasSession = session.messages.length > 0;

    if (hasSession && !existing) {
      const btn = document.createElement('button');
      btn.id        = 'wa-end-session-btn';
      btn.className = 'wa-btn-end-session';
      btn.textContent = 'End session';
      btn.title     = 'Clear conversation and start fresh';
      btn.onclick   = () => {
        if (confirm('End this session and clear the conversation?')) endSession();
      };
      // Insert before the input row
      const inputRow = panel.querySelector('.wa-input-row');
      if (inputRow) panel.insertBefore(btn, inputRow);
      else panel.appendChild(btn);
    } else if (!hasSession && existing) {
      existing.remove();
    }
  }

  // ─── ACTION PROPOSAL ──────────────────────────────────────────────────────

  function createAction(type, description, payload) {
    const action = {
      id:          'act_' + Date.now(),
      type,
      description,
      payload,
      status:      'pending',
      createdAt:   Date.now(),
      startedAt:   null,
      completedAt: null,
      error:       null
    };
    session.actions.push(action);
    saveSession();
    return action;
  }

  function proposeAction(type, description, payload) {
    // Guard — only one pending/active action at a time
    const hasActive = session.actions.some(a => ['pending','active'].includes(a.status));
    if (hasActive) {
      log('Action already pending/active — skipping proposal');
      return;
    }

    const action = createAction(type, description, payload);
    setState('action', 'proposed');
    renderActionCard(action);
  }

  function proposeChoiceAction(description, options) {
    const hasActive = session.actions.some(a => ['pending','active'].includes(a.status));
    if (hasActive) return;

    renderCard({
      label:   'Choose an action',
      message: description,
      buttons: options.map((opt) => ({
        text:   opt.label,
        style:  'confirm',
        action: () => {
          const a = createAction(opt.action.type, opt.action.description, opt.action.payload);
          a.status    = 'active';
          a.startedAt = Date.now();
          saveSession();
          disconnectBridge().then(() => executeAction(a));
        }
      })).concat([{ text: 'No thanks', style: 'deny', action: () => setState('action', 'none') }])
    });
  }

  function confirmAction(actionId) {
    const action = session.actions.find(a => a.id === actionId);
    if (!action || action.status !== 'pending') return;
    setState('action', 'active');
    updateActionCardStatus(actionId, 'active');
    disconnectBridge().then(() => executeAction(action));
  }

  function denyAction(actionId) {
    const action = session.actions.find(a => a.id === actionId);
    if (!action || action.status !== 'pending') return;
    action.status      = 'denied';
    action.completedAt = Date.now();
    saveSession();
    updateActionCardStatus(actionId, 'denied');
    setState('action', 'none');
    agentSay("No problem — just let me know if you change your mind.");
  }

  // Dismiss pending actions when user sends a new message
  function dismissPendingActions() {
    session.actions.forEach(a => {
      if (a.status === 'pending') {
        a.status      = 'denied';
        a.completedAt = Date.now();
        const card = document.querySelector(`[data-action-id="${a.id}"]`);
        if (card) card.style.display = 'none';
      }
    });
    saveSession();
    setState('action', 'none');
  }

  // ─── OPENAI CLASSIFICATION ────────────────────────────────────────────────
  // Fires once per agent message from one place. Pre-checks before API call.

  let classifyController = null;

  const ACTION_SIGNALS = [
    'take you', 'taking you', 'head over', 'navigate you', 'send you',
    "i'll take", 'let\'s go', 'going to the', 'direct you',
    'get that form', 'form started', 'form ready', 'fill that', 'open that up',
    'get that booked', 'booking page', 'schedule that',
    'contact page', 'services page', 'home page', 'homepage'
  ];

  const SKIP_CLASSIFICATION = [
    'are you still there', 'still there', 'you\'re not responding',
    'gotten distracted', 'stepped away', 'seems like you',
    'welcome to the', 'we\'ve arrived', 'we\'re here', 'we\'re now on',
    'you\'re now on', 'here we are', 'we have arrived',
    'how can i help', 'what can i help', 'what would you like',
    'is there anything', 'anything else'
  ];

  async function classifyAgentMessage(userMessage, agentMessage) {
    const lower = agentMessage.toLowerCase();

    // Skip inactivity / greeting messages
    if (SKIP_CLASSIFICATION.some(p => lower.includes(p))) {
      log('Classification skipped — matched skip phrase');
      return;
    }

    // Pre-check — only call OpenAI if message looks action-like
    if (!ACTION_SIGNALS.some(s => lower.includes(s))) {
      log('Classification skipped — no action signal');
      return;
    }

    // Don't classify if action already in progress
    if (session.actions.some(a => ['pending','active'].includes(a.status))) {
      log('Classification skipped — action already active');
      return;
    }

    // Cancel previous in-flight request
    if (classifyController) classifyController.abort();
    classifyController = new AbortController();

    const pages      = getPageMap().map(p => `${p.label}|${p.file}`).join('\n');
    const currentUrl = window.location.href;
    const userCtx    = userMessage ? `User: "${userMessage}"` : 'User: (silent)';

    const prompt = `Website agent conversation analyser. Reply JSON only.
Current URL: ${currentUrl}
Pages (label|url):
${pages}
${userCtx}
Agent: "${agentMessage}"
JSON: {"action":"navigate"|"fill_form"|"navigate_then_fill"|"none","target_url":"exact url from list or null"}
Rules: navigate=agent taking user to different page now; fill_form=agent explicitly starting form AND user already on contact page; navigate_then_fill=going to contact page to fill form; none=conversation/greeting/question. Never target_url=current page. Greetings/questions=none. Be conservative.`;

    const t0 = Date.now();
    log('→ Classification request sent');

    try {
      const res = await fetch(OPENAI_PROXY, {
        method:  'POST',
        signal:  classifyController.signal,
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ prompt, maxTokens: 60 })
      });

      if (!res.ok) { warn('Classification error:', res.status); return; }

      const data = await res.json();
      const raw  = data.content || data.choices?.[0]?.message?.content || '';
      log(`← Classification ${Date.now() - t0}ms:`, raw.trim());

      let parsed;
      try {
        const clean = raw.replace(/```json|```/g, '').trim();
        parsed = JSON.parse(clean);
      } catch(e) { warn('Bad JSON from classifier:', raw); return; }

      if (!parsed.action || parsed.action === 'none') return;

      // Double-check still clear
      if (session.actions.some(a => ['pending','active'].includes(a.status))) return;

      if (parsed.action === 'fill_form') {
        proposeAction('fill_form', 'Help you fill out the contact form.', { fields: freshFields() });

      } else if (parsed.action === 'navigate_then_fill') {
        const contact = getContactPage();
        if (!contact) return;
        proposeAction('navigate_then_fill',
          `Take you to the ${contact.label} and fill out the enquiry form.`,
          {
            targetPage:          contact.file,
            targetLabel:         contact.label,
            // Fields are empty here — discovered fresh on arrival at contact page
            nextActionOnArrival: { type: 'fill_form', description: 'Fill out the contact form.', payload: { fields: [] } }
          }
        );

      } else if (parsed.action === 'navigate' && parsed.target_url) {
        // Guard — don't navigate to current page
        const targetClean  = parsed.target_url.replace(/\/$/, '');
        const currentClean = window.location.href.replace(/\/$/, '');
        if (targetClean === currentClean) {
          const page = getPageMap().find(p => p.file.replace(/\/$/, '') === targetClean);
          agentSay(`You're already on the ${page ? page.label : 'page'} — is there something I can help you with here?`);
          return;
        }

        const page  = getPageMap().find(p => p.file.replace(/\/$/, '') === targetClean);
        const label = page ? page.label : 'page';

        // If target is contact page — offer choice
        const contact = getContactPage();
        if (contact && targetClean === contact.file.replace(/\/$/, '')) {
          proposeChoiceAction(
            `Would you like to just visit the ${contact.label}, or go there and fill out the enquiry form?`,
            [
              { label: 'Just browse', action: { type: 'navigate', description: `Take you to the ${contact.label}.`, payload: { targetPage: contact.file, targetLabel: contact.label } } },
              { label: 'Fill the form', action: { type: 'navigate_then_fill', description: `Take you to the ${contact.label} and fill the form.`, payload: { targetPage: contact.file, targetLabel: contact.label, nextActionOnArrival: { type: 'fill_form', description: 'Fill out the contact form.', payload: { fields: [] } } } } }
            ]
          );
        } else {
          proposeAction('navigate', `Take you to the ${label}.`, { targetPage: parsed.target_url, targetLabel: label });
        }

      } else if (parsed.action === 'navigate' && !parsed.target_url) {
        // Agent wanted to navigate but page not in map
        const pageList = getPageMap().map(p => p.label).join(', ');
        agentSay(`I'm not sure which page you mean. Here's what's available: ${pageList}. Which would you like?`);
      }

    } catch(e) {
      if (e.name === 'AbortError') {
        log('Classification cancelled — superseded by new message');
      } else {
        warn('Classification failed:', e.message);
      }
    }
  }


  // ─── MESSAGE FLOW ─────────────────────────────────────────────────────────

  function sendMessage() {
    const input = document.getElementById('wa-input');
    const text  = (input ? input.value : '').trim();
    if (!text) return;

    // Only block send in voice mode while agent is speaking
    if (State.conversation === 'responding' && WA._voiceMode) return;

    if (input) input.value = '';
    userSay(text);
    inactivity.reset(); // text message counts as user activity

    // Cancel in-flight classification and dismiss pending cards on new message
    if (classifyController) { classifyController.abort(); classifyController = null; }
    if (WA.bridge && WA.bridge.isConnected()) dismissPendingActions();

    // Form fill takes priority — OpenAI handles all form fill input
    if (formState.active) {
      handleFormInputAI(text);
      return;
    }

    // Send to bridge (11labs) if connected
    if (WA.bridge && WA.bridge.isConnected()) {
      WA.bridge.sendText(text);
      WA._lastUserMessage = text;
      showTyping();
      setState('conversation', 'awaiting');
      return;
    }

    // Mock fallback
    showTyping();
    setTimeout(() => {
      hideTyping();
      mockRespond(text);
    }, 600);
  }

  function handleKey(e) {
    if (e.key === 'Enter') sendMessage();
  }

  function userSay(text) {
    session.messages.push({ role: 'user', text, ts: Date.now() });
    if (State.session === 'fresh') {
      setState('session', 'active');
      updateSessionButton();
    }
    saveSession();
    appendMessage('user', text);
  }

  function agentSay(text) {
    hideTyping();
    session.messages.push({ role: 'agent', text, ts: Date.now() });
    if (State.session === 'fresh') {
      setState('session', 'active');
      updateSessionButton();
    }
    saveSession();

    // Skip DOM render if bridge already showed this message
    if (WA._tentativeCommitted) {
      WA._tentativeCommitted = false;
      return;
    }
    appendMessage('agent', text);
  }

  // Expose for bridge
  WA.agentSay = agentSay;
  WA.userSay  = userSay;

  function mockRespond(text) {
    const lower = text.toLowerCase();
    if (['hello','hi','hey','help'].some(w => lower.includes(w))) {
      agentSay("Hey! I'm the Website Avatar. I can help you navigate this site or fill out the contact form. What do you need?");
    } else if (CONTACT_KEYWORDS.some(w => lower.includes(w))) {
      handleContactIntent();
    } else if (NAV_KEYWORDS.some(w => lower.includes(w))) {
      handleNavIntent(text);
    } else {
      agentSay("I heard you — connect the voice agent to get full AI responses, or ask me to navigate or fill a form.");
    }
  }

  const CONTACT_KEYWORDS = ['contact', 'fill', 'form', 'enquiry', 'inquiry', 'get in touch', 'reach out'];
  const NAV_KEYWORDS     = ['go to', 'take me', 'navigate', 'show me', 'home', 'homepage'];

  function isNavigationIntent(text) {
    return NAV_KEYWORDS.some(kw => text.toLowerCase().includes(kw));
  }

  function handleContactIntent() {
    if (isOnContactPage()) {
      proposeAction('fill_form', 'Help you fill out the contact form.', { fields: freshFields() });
    } else {
      const contact = getContactPage();
      if (contact) {
        proposeAction('navigate_then_fill',
          `Take you to the ${contact.label} and fill out the enquiry form.`,
          {
            targetPage:          contact.file,
            targetLabel:         contact.label,
            nextActionOnArrival: { type: 'fill_form', description: 'Fill out the contact form.', payload: { fields: [] } }
          }
        );
      }
    }
  }

  function handleNavIntent(text) {
    const lower = text.toLowerCase();
    const pages = getPageMap();
    // Only navigate if we find a genuine keyword match — no fallback to pages[0]
    const target = pages.find(p => p.keywords.some(kw => lower.includes(kw)));
    if (!target) {
      const pageList = pages.map(p => p.label).join(', ');
      agentSay(`I'm not sure which page you mean. Available pages: ${pageList}.`);
      return;
    }
    const currentClean = window.location.href.replace(/\/$/, '');
    const targetClean  = target.file.replace(/\/$/, '');
    if (currentClean === targetClean) {
      agentSay(`You're already on the ${target.label}!`);
      return;
    }
    proposeAction('navigate', `Take you to the ${target.label}.`, { targetPage: target.file, targetLabel: target.label });
  }

  // ─── BRIDGE INTERFACE ─────────────────────────────────────────────────────
  // Clean interface for wa-elevenlabs.js — no direct function calls back in.

  WA.onBridgeConnected    = () => { setState('connection', 'connected'); inactivity.onConnect(); };
  WA.onBridgeDisconnected = () => { setState('connection', 'offline'); setState('conversation', 'idle'); hideTyping(); };
  WA.onSpeakingStart = () => { setState('conversation', 'responding'); hideTyping(); };
  WA.onSpeakingStop  = () => { setState('conversation', 'idle'); };
  WA.onAgentMessage       = (text) => { agentSay(text); classifyAgentMessage(WA._lastUserMessage || '', text); };
  WA.onUserMessage        = (text) => { userSay(text); WA._lastUserMessage = text; inactivity.reset(); };
  WA.onPreAudioMessage    = (text) => {
    // Text arrived before/during audio — show immediately
    hideTyping();
    showTentativeMessage(text);
  };

  function disconnectBridge() {
    return WA.bridge ? WA.bridge.disconnect() : Promise.resolve();
  }

  function reconnectBridge(delay = 0) {
    // If bridge already ready — connect immediately
    if (WA.bridge && typeof WA.bridge.connect === 'function') {
      if (WA.bridge.isConnected && WA.bridge.isConnected()) {
        log('reconnectBridge — already connected, skipping');
        return;
      }
      setTimeout(() => {
        log('reconnectBridge — calling connect');
        WA.bridge.connect();
      }, delay);
      return;
    }

    // Bridge not ready yet — wait for bridge:ready event from wa-elevenlabs.js
    log('reconnectBridge — waiting for bridge:ready');
    function onReady() {
      WA.bus.off('bridge:ready', onReady);
      setTimeout(() => {
        log('reconnectBridge — bridge ready, calling connect');
        WA.bridge.connect();
      }, delay);
    }
    WA.bus.on('bridge:ready', onReady);
  }

  // ─── INACTIVITY ───────────────────────────────────────────────────────────

  const inactivity = {
    rounds:       0,
    max:          3,
    justConnected: false, // true for first message after reconnect — don't count
    reset:   function () { this.rounds = 0; this.justConnected = false; },
    onConnect: function () { this.rounds = 0; this.justConnected = true; },
    tick:    function () {
      // Don't disconnect if action or form fill is in progress
      if (['active','proposed'].includes(State.action)) return;
      if (formState.active) return;
      // First message after connect is Michelle's greeting — don't count it
      if (this.justConnected) { this.justConnected = false; return; }
      this.rounds++;
      log(`Inactivity: ${this.rounds}/${this.max}`);
      if (this.rounds >= this.max) {
        log('Inactivity disconnect');
        setTimeout(disconnectBridge, 2000);
      }
    }
  };

  WA.inactivity = inactivity;

  // ─── UI ───────────────────────────────────────────────────────────────────

  let typingEl      = null;
  let tentativeMsgEl = null;

  function showTyping() {
    if (typingEl) return;
    typingEl = document.createElement('div');
    typingEl.className = 'wa-typing';
    typingEl.innerHTML = '<span></span><span></span><span></span>';
    const msgs = document.getElementById('wa-messages');
    if (msgs) { msgs.appendChild(typingEl); scrollToBottom(); }
  }

  function hideTyping() {
    if (typingEl) { typingEl.remove(); typingEl = null; }
  }

  function showTentativeMessage(text) {
    if (!tentativeMsgEl) {
      tentativeMsgEl = document.createElement('div');
      tentativeMsgEl.className = 'wa-msg wa-agent wa-tentative';
      const msgs = document.getElementById('wa-messages');
      if (msgs) { msgs.appendChild(tentativeMsgEl); }
    }
    tentativeMsgEl.textContent = text;
    scrollToBottom();
  }

  function commitTentativeMessage(text) {
    if (tentativeMsgEl) {
      tentativeMsgEl.classList.remove('wa-tentative');
      tentativeMsgEl.textContent = text;
      tentativeMsgEl = null;
      WA._tentativeCommitted = true;
      return true;
    }
    return false;
  }

  WA.showTentativeMessage  = showTentativeMessage;
  WA.commitTentativeMessage = commitTentativeMessage;

  function appendMessage(role, text) {
    const el = document.createElement('div');
    el.className = `wa-msg wa-${role}`;
    el.textContent = text;
    const msgs = document.getElementById('wa-messages');
    if (msgs) { msgs.appendChild(el); scrollToBottom(); }
  }

  function renderActionCard(action) {
    renderCard({
      label:      'Proposed action',
      message:    action.description,
      actionId:   action.id,
      buttons: [
        { text: "Let's do it", style: 'confirm', action: () => confirmAction(action.id) },
        { text: 'No thanks',   style: 'deny',    action: () => denyAction(action.id) }
      ]
    });
  }

  function renderCard({ label, message, actionId, buttons }) {
    const card = document.createElement('div');
    card.className = 'wa-action-card';
    if (actionId) card.dataset.actionId = actionId;

    const btnsHtml = buttons.map((btn, i) =>
      `<button class="wa-btn wa-btn-${btn.style || 'confirm'}" data-btn-idx="${i}">${btn.text}</button>`
    ).join('');

    card.innerHTML = `
      <div class="wa-card-label">${label}</div>
      <p>${message}</p>
      <div class="wa-card-btns">${btnsHtml}</div>
    `;

    // Attach handlers
    card.querySelectorAll('button[data-btn-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.btnIdx);
        buttons[idx].action();
      });
    });

    const msgs = document.getElementById('wa-messages');
    if (msgs) { msgs.appendChild(card); scrollToBottom(); }
  }

  function updateActionCardStatus(actionId, status) {
    const card = document.querySelector(`[data-action-id="${actionId}"]`);
    if (!card) return;
    const btnsEl = card.querySelector('.wa-card-btns');
    if (!btnsEl) return;

    const labels = { active: 'Active', denied: 'Cancelled', complete: 'Done' };
    const styles = { active: 'wa-status-active', denied: 'wa-status-denied', complete: 'wa-status-complete' };

    btnsEl.innerHTML = `<span class="wa-status ${styles[status] || ''}">${labels[status] || status}</span>`;
  }

  function scrollToBottom() {
    const msgs = document.getElementById('wa-messages');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
  }

  function openPanel() {
    const panel = document.getElementById('wa-panel');
    if (panel && !panel.classList.contains('wa-open')) {
      panel.classList.add('wa-open');
      session.isOpen = true;
      saveSession();
    }
  }

  function updateAbortButton() {
    const existing = document.getElementById('wa-abort-btn');
    const msgs     = document.getElementById('wa-messages');
    if (!msgs) return;

    const hasActive = session.actions.some(a => a.status === 'active');

    if (hasActive && !existing) {
      const btn = document.createElement('button');
      btn.id        = 'wa-abort-btn';
      btn.className = 'wa-btn-abort';
      btn.textContent = '✕ Cancel action';
      btn.title     = 'Cancel current action';
      btn.onclick   = () => abortCurrentAction();
      // Append inside messages — appears below last message
      msgs.appendChild(btn);
      scrollToBottom();
    } else if (!hasActive && existing) {
      existing.remove();
    }
  }

  function abortCurrentAction() {
    const activeAction = session.actions.find(a => a.status === 'active');
    if (!activeAction) return;

    if (formState.active) {
      abandonFormFill();
      return;
    }

    activeAction.status      = 'denied';
    activeAction.completedAt = Date.now();
    saveSession();
    setState('action', 'none');
    updateAbortButton();
    agentSay("Action cancelled. What would you like to do?");
    setTimeout(reconnectBridge, 600);
  }

  function toggleChat() {
    const panel = document.getElementById('wa-panel');
    if (!panel) return;
    const isOpen = panel.classList.toggle('wa-open');
    session.isOpen = isOpen;
    saveSession();

    if (isOpen) {
      const badge = document.getElementById('wa-badge');
      if (badge) badge.classList.remove('wa-show');
      // Only auto-connect if session is active — not on fresh panel open
      if (WA.bridge && !WA.bridge.isConnected() &&
          State.session === 'active' && session.messages.length > 0) {
        reconnectBridge();
      }
    }
  }

  function renderDebug() {
    const el = document.getElementById('wa-debug-output');
    if (!el || !DEBUG) return;
    el.textContent = JSON.stringify({
      state:   State,
      page:    window.location.pathname,
      msgs:    session.messages.length,
      actions: session.actions.map(a => ({ type: a.type, status: a.status })),
      pending: session.pendingOnArrival ? session.pendingOnArrival.page : null
    }, null, 2);
  }

  // ─── INIT ─────────────────────────────────────────────────────────────────

  function init() {
    // Declare these first — used throughout init
    const hasActiveSession = session.messages.length > 0;
    const hasNavAction     = session.actions.some(a => a.type === 'navigate' && a.status === 'active');
    const hasFormResume    = !!(session.activeFormActionId &&
                               session.actions.find(a => a.id === session.activeFormActionId && a.status === 'active'));

    // Restore messages
    const msgs = document.getElementById('wa-messages');
    if (msgs) {
      msgs.innerHTML = '';
      session.messages.forEach(m => {
        const el = document.createElement('div');
        el.className = `wa-msg wa-${m.role}`;
        el.textContent = m.text;
        msgs.appendChild(el);
      });
    }

    // Restore pending action cards
    session.actions.forEach(a => {
      if (a.status === 'pending') renderActionCard(a);
    });

    // Resume interrupted form fill
    if (session.activeFormActionId && !session.pendingOnArrival) {
      const resumeAction = session.actions.find(
        a => a.id === session.activeFormActionId && a.status === 'active'
      );
      if (resumeAction) {
        formState.active = true;
        formState.action = resumeAction;
        repopulateFields(resumeAction);
        updateAbortButton();
        // Don't reconnect bridge during form fill resume —
        // Michelle speaking would conflict with the form fill conversation.
        // Let the AI greet the user and ask for the next field directly.
        setTimeout(() => handleFormInputAI('__RESUME__'), 400);
      } else {
        session.activeFormActionId = null;
        saveSession();
      }
    }

    // Panel state — only restore open state if session is active
    if (session.isOpen && session.messages.length > 0) openPanel();
    if (session.messages.length > 0 && !session.isOpen) {
      const badge = document.getElementById('wa-badge');
      if (badge) badge.classList.add('wa-show');
    }

    // First visit greeting — only in mock mode (no active session, bridge not connecting)
    if (!hasActiveSession) {
      setTimeout(() => {
        // By this point bridge would have connected if it was going to — safe to check
        if (!WA.bridge || !WA.bridge.isConnected()) {
          agentSay("Hi! I'm your Website Avatar. Connect the voice agent or type to get started.");
          const badge = document.getElementById('wa-badge');
          if (badge && !session.isOpen) badge.classList.add('wa-show');
        }
      }, 1500);
    }

    scrollToBottom();
    renderDebug();
    checkArrival();

    // Auto-connect if session active — not during form resume or navigate arrival
    // (those handle their own reconnect)
    if (hasActiveSession && !hasNavAction && !hasFormResume) {
      reconnectBridge();
    }

    // Show end session button if session has messages
    if (hasActiveSession) {
      setState('session', 'active');
      updateSessionButton();
    }
  }

  // ─── EXPOSE PUBLIC API ────────────────────────────────────────────────────

  WA.toggleChat     = toggleChat;
  WA.sendMessage    = sendMessage;
  WA.handleKey      = handleKey;
  WA.confirmAction  = confirmAction;
  WA.denyAction     = denyAction;
  WA.submitForm     = submitForm;
  WA.cancelFormFill = cancelFormFill;
  WA.endSession     = endSession;
  WA.manualSubmit   = () => submitGenericForm(); // for demo submit button

  // ─── HELPERS ──────────────────────────────────────────────────────────────

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ─── START ────────────────────────────────────────────────────────────────

  function waitForPanel(cb, attempts = 0) {
    if (document.getElementById('wa-messages')) {
      cb();
    } else if (attempts < 30) {
      setTimeout(() => waitForPanel(cb, attempts + 1), 100);
    } else {
      warn('wa-messages element never appeared — init aborted');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => waitForPanel(init));
  } else {
    waitForPanel(init);
  }

})();
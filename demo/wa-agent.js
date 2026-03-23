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

  const OPENAI_PROXY   = CONFIG.openaiProxyUrl || 'https://website-avatar.advelocity-ai.workers.dev/classify';
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
    action:       'none'        // none | classifying | proposed | active | complete | error
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
    // Disable/enable send button based on combined state
    const sendBtn = document.getElementById('wa-send');
    if (sendBtn) {
      const blocked = State.conversation === 'responding' || State.action === 'active';
      sendBtn.disabled = blocked;
      sendBtn.title    = blocked ? 'Wait for the agent to finish…' : '';
    }
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

  function saveSentPrompts() {
    try { sessionStorage.setItem(PROMPTS_KEY, JSON.stringify([...sentPrompts])); } catch(e) {}
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

    try {
      await handler.execute(action);
      action.status      = 'complete';
      action.completedAt = Date.now();
      saveSession();
      setState('action', 'complete');
      if (handler.onComplete) await handler.onComplete(action);
    } catch (err) {
      warn(`Action ${action.type} failed:`, err);
      action.status      = 'failed';
      action.error       = { message: err.message, retryable: !!err.retryable };
      action.completedAt = Date.now();
      saveSession();
      setState('action', 'error');
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
      await startFormFill(action);
    },

    onError: async (err, action) => {
      agentSay("I had trouble filling the form. You can complete it manually — all the fields are visible.");
      reconnectBridge();
    },

    onComplete: async (action) => {
      // Handled inside submitForm() after CF7 event fires
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
    // Simple navigate — mark complete and reconnect
    const navAction = session.actions.find(a => a.type === 'navigate' && a.status === 'active');
    if (navAction) {
      navAction.status      = 'complete';
      navAction.completedAt = Date.now();
      saveSession();
      setState('action', 'complete');
      setTimeout(reconnectBridge, 600);
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
      agentSay("We're here! Let's fill out that contact form.");
      const fullAction = createAction('fill_form', action.description, action.payload);
      await executeAction(fullAction);
    }, 900);
  }

  // ─── FORM FILL ────────────────────────────────────────────────────────────

  let formState = {
    active:               false,
    action:               null,
    fieldIndex:           0,
    awaitingAbandon:      false,
    awaitingSubmitConfirm: false
  };

  async function startFormFill(action) {
    if (formState.active) return;

    formState.active               = true;
    formState.action               = action;
    formState.fieldIndex           = action.payload.fields.findIndex(f => f.value === null);
    formState.awaitingAbandon      = false;
    formState.awaitingSubmitConfirm = false;

    if (formState.fieldIndex === -1) formState.fieldIndex = action.payload.fields.length;

    session.activeFormActionId = action.id;
    saveSession();

    openPanel();
    repopulateFields(action);
    askNextField();
  }

  function askNextField() {
    const fields = formState.action.payload.fields;

    if (formState.fieldIndex >= fields.length) {
      completeFormFill();
      return;
    }

    const field = fields[formState.fieldIndex];
    const el    = getFieldElement(field);

    if (el) {
      el.classList.add('wa-filling');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    agentSay(`What's your ${field.label.toLowerCase()}?`);
  }

  function handleFormInput(text) {
    // Check for abandon intent
    if (isNavigationIntent(text)) {
      formState.awaitingAbandon = true;
      agentSay("Looks like you want to navigate away — should I save your progress and continue later? Reply 'yes' to leave or 'no' to keep going.");
      return;
    }

    // Check for field correction — "actually my email is..."
    const correctedField = detectFieldCorrection(text, formState.action.payload.fields);
    if (correctedField !== null) {
      handleFieldCorrection(correctedField, text);
      return;
    }

    const field = formState.action.payload.fields[formState.fieldIndex];

    // Validate before accepting
    const validationError = validateField(field, text);
    if (validationError) {
      agentSay(validationError);
      return; // Don't advance — re-ask same field
    }

    // Fill field
    field.value = text;
    fillField(getFieldElement(field), text);
    saveSession();

    agentSay(`Got it — ${field.label}: "${text}"`);
    formState.fieldIndex++;
    setTimeout(askNextField, 600);
  }

  function handleAbandonConfirm(text) {
    formState.awaitingAbandon = false;
    if (/^y(es)?$/i.test(text.trim())) {
      abandonFormFill();
    } else {
      agentSay("Got it — let's carry on.");
      setTimeout(askNextField, 400);
    }
  }

  function completeFormFill() {
    // Validate all required fields before showing summary
    const fields  = formState.action.payload.fields;
    const missing = fields.filter(f => f.required && (!f.value || !f.value.trim()));

    if (missing.length) {
      agentSay(`Before we submit, I still need: ${missing.map(f => f.label).join(', ')}. Let's fill those in.`);
      formState.fieldIndex = fields.indexOf(missing[0]);
      askNextField();
      return;
    }

    const summary = fields
      .filter(f => f.value)
      .map(f => `${f.label}: ${f.value}`)
      .join(', ');

    agentSay(`All set! I've filled in ${summary}. Ready to send?`);
    formState.awaitingSubmitConfirm = true;

    renderCard({
      label:   'Ready to submit',
      message: 'Shall I submit the form now?',
      buttons: [
        { text: 'Submit',  action: () => submitForm() },
        { text: 'Cancel',  action: () => cancelFormFill(), style: 'deny' }
      ]
    });
  }

  async function submitForm() {
    formState.awaitingSubmitConfirm = false;

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
      // No button found — show demo success or tell user
      const formEl    = document.getElementById('contact-form-fields');
      const successEl = document.getElementById('form-success');
      if (formEl)    formEl.style.display    = 'none';
      if (successEl) successEl.style.display = 'block';
      finishFormFill('success');
    }
  }

  function finishFormFill(outcome) {
    resetFormState();
    setState('action', 'complete');
    // Reconnect bridge — it will build context including form outcome
    setTimeout(reconnectBridge, 1000);
  }

  function handleCF7ValidationError(detail) {
    agentSay("A few fields need checking — let me re-ask those.");
    // Identify failed fields from CF7 response
    const failedInputs = document.querySelectorAll('.wpcf7-not-valid');
    if (failedInputs.length) {
      const failedNames = Array.from(failedInputs).map(el => el.getAttribute('name'));
      const failedFields = formState.action.payload.fields.filter(f => failedNames.includes(f.name));
      if (failedFields.length) {
        // Reset values for failed fields and re-ask
        failedFields.forEach(f => { f.value = null; });
        formState.fieldIndex = formState.action.payload.fields.indexOf(failedFields[0]);
        formState.active     = true;
        setTimeout(askNextField, 600);
        return;
      }
    }
    // Couldn't identify specific fields — tell user to check manually
    agentSay("Please check the form — some fields may need correcting.");
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
    }
    session.activeFormActionId = null;
    saveSession();
    agentSay("No problem — the form is still there if you want to fill it in manually.");
    resetFormState();
    setState('action', 'none');
    setTimeout(reconnectBridge, 800);
  }

  function abandonFormFill() {
    if (formState.action) {
      formState.action.status      = 'denied';
      formState.action.completedAt = Date.now();
    }
    session.activeFormActionId = null;
    document.querySelectorAll('.wa-filling').forEach(el => el.classList.remove('wa-filling'));
    saveSession();
    agentSay("I've left the form for now.");
    resetFormState();
    setState('action', 'none');
    setTimeout(reconnectBridge, 800);
  }

  function resetFormState() {
    formState.active                = false;
    formState.action                = null;
    formState.fieldIndex            = 0;
    formState.awaitingAbandon       = false;
    formState.awaitingSubmitConfirm = false;
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

  function validateField(field, value) {
    if (field.required && (!value || !value.trim())) {
      return `${field.label} is required — please provide a value.`;
    }
    if (field.type === 'email' && value && !value.includes('@')) {
      return `That doesn't look like a valid email — could you double-check it?`;
    }
    if (field.type === 'tel' && value && value.replace(/\D/g, '').length < 7) {
      return `That phone number looks too short — could you check it?`;
    }
    if (field.type === 'url' && value && !value.match(/^https?:\/\//i)) {
      // Not a hard error — URL field is often optional
      // Auto-prefix if they forgot http
      const el = getFieldElement(field);
      if (el) fillField(el, 'https://' + value);
      field.value = 'https://' + value;
    }
    return null;
  }

  function detectFieldCorrection(text, fields) {
    const lower = text.toLowerCase();
    const correctionSignals = ['actually', 'sorry', 'change', 'wrong', 'correct', 'meant', 'meant to say'];
    const hasSignal = correctionSignals.some(s => lower.includes(s));
    if (!hasSignal) return null;

    // Find which field they're referring to
    for (let i = 0; i < fields.length; i++) {
      if (lower.includes(fields[i].label.toLowerCase())) return i;
    }
    return null;
  }

  function handleFieldCorrection(fieldIndex, text) {
    // Extract the new value — strip the correction signal words
    const signals = ['actually', 'sorry', 'change', 'wrong', 'correct', 'it is', "it's", 'to'];
    let value = text.toLowerCase();
    signals.forEach(s => { value = value.replace(s, ''); });
    // Remove the field label too
    const field = formState.action.payload.fields[fieldIndex];
    value = value.replace(field.label.toLowerCase(), '').trim();

    if (value) {
      field.value = value;
      fillField(getFieldElement(field), value);
      agentSay(`Updated — ${field.label}: "${value}"`);
      // Continue from where we were
      setTimeout(askNextField, 600);
    } else {
      // Couldn't extract value — re-ask the field
      formState.fieldIndex = fieldIndex;
      askNextField();
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
      buttons: options.map((opt, i) => ({
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
            nextActionOnArrival: { type: 'fill_form', description: 'Fill out the contact form.', payload: { fields: freshFields() } }
          }
        );

      } else if (parsed.action === 'navigate' && parsed.target_url) {
        // Guard — don't navigate to current page
        const targetClean  = parsed.target_url.replace(/\/$/, '');
        const currentClean = window.location.href.replace(/\/$/, '');
        if (targetClean === currentClean) return;

        const page  = getPageMap().find(p => p.file.replace(/\/$/, '') === targetClean);
        const label = page ? page.label : 'page';

        // If target is contact page — offer choice
        const contact = getContactPage();
        if (contact && targetClean === contact.file.replace(/\/$/, '')) {
          proposeChoiceAction(
            `Would you like to just visit the ${contact.label}, or go there and fill out the enquiry form?`,
            [
              { label: 'Just browse', action: { type: 'navigate', description: `Take you to the ${contact.label}.`, payload: { targetPage: contact.file, targetLabel: contact.label } } },
              { label: 'Fill the form', action: { type: 'navigate_then_fill', description: `Take you to the ${contact.label} and fill the form.`, payload: { targetPage: contact.file, targetLabel: contact.label, nextActionOnArrival: { type: 'fill_form', description: 'Fill out the contact form.', payload: { fields: freshFields() } } } } }
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

  // Expose for wa-elevenlabs.js to call
  WA.classifyAgentMessage = classifyAgentMessage;

  // ─── MESSAGE FLOW ─────────────────────────────────────────────────────────

  function sendMessage() {
    const input = document.getElementById('wa-input');
    const text  = (input ? input.value : '').trim();
    if (!text) return;

    // Block send while agent is speaking
    if (State.conversation === 'responding') return;

    if (input) input.value = '';
    userSay(text);

    // Cancel in-flight classification and dismiss pending cards on new message
    if (classifyController) { classifyController.abort(); classifyController = null; }
    if (WA.bridge && WA.bridge.isConnected()) dismissPendingActions();

    // Form fill takes priority
    if (formState.awaitingAbandon) {
      showTyping();
      setTimeout(() => { hideTyping(); handleAbandonConfirm(text); }, 400);
      return;
    }

    if (formState.active) {
      showTyping();
      setTimeout(() => { hideTyping(); handleFormInput(text); }, 400);
      return;
    }

    // Send to bridge (11labs) if connected
    if (WA.bridge && WA.bridge.isConnected()) {
      WA.bridge.sendText(text);
      window._wa_lastUserMessage = text;
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
    saveSession();
    appendMessage('user', text);
  }

  function agentSay(text) {
    hideTyping();
    session.messages.push({ role: 'agent', text, ts: Date.now() });
    saveSession();

    // Skip DOM render if bridge already showed this message
    if (window._wa_tentativeCommitted) {
      window._wa_tentativeCommitted = false;
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
            nextActionOnArrival: { type: 'fill_form', description: 'Fill out the contact form.', payload: { fields: freshFields() } }
          }
        );
      }
    }
  }

  function handleNavIntent(text) {
    const target = resolveTargetPage(text);
    if (!target) {
      agentSay("I'm not sure which page you mean — which section are you looking for?");
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

  WA.onBridgeConnected    = () => { setState('connection', 'connected'); };
  WA.onBridgeDisconnected = () => { setState('connection', 'offline'); setState('conversation', 'idle'); hideTyping(); };
  WA.onSpeakingStart      = () => { setState('conversation', 'responding'); hideTyping(); };
  WA.onSpeakingStop       = () => { setState('conversation', 'idle'); };
  WA.onAgentMessage       = (text) => { agentSay(text); classifyAgentMessage(window._wa_lastUserMessage || '', text); };
  WA.onUserMessage        = (text) => { userSay(text); window._wa_lastUserMessage = text; inactivity.reset(); };
  WA.onPreAudioMessage    = (text) => {
    // Text arrived before/during audio — show immediately
    hideTyping();
    showTentativeMessage(text);
  };

  function disconnectBridge() {
    return WA.bridge ? WA.bridge.disconnect() : Promise.resolve();
  }

  function reconnectBridge() {
    if (WA.bridge) WA.bridge.connect();
  }

  // ─── INACTIVITY ───────────────────────────────────────────────────────────

  const inactivity = {
    rounds:  0,
    max:     2,
    reset:   function () { this.rounds = 0; },
    tick:    function () {
      // Don't disconnect if action is in progress
      if (['active','proposed'].includes(State.action)) return;
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
      window._wa_tentativeCommitted = true;
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

  function toggleChat() {
    const panel = document.getElementById('wa-panel');
    if (!panel) return;
    const isOpen = panel.classList.toggle('wa-open');
    session.isOpen = isOpen;
    saveSession();

    if (isOpen) {
      const badge = document.getElementById('wa-badge');
      if (badge) badge.classList.remove('wa-show');
      // Auto-connect bridge on open
      if (WA.bridge && !WA.bridge.isConnected()) {
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
    // Sync maps from discover.js
    // (already on window.WebsiteAvatar from discover.js DOMContentLoaded)

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
        formState.active     = true;
        formState.action     = resumeAction;
        formState.fieldIndex = resumeAction.payload.fields.findIndex(f => f.value === null);
        if (formState.fieldIndex === -1) formState.fieldIndex = resumeAction.payload.fields.length;
        repopulateFields(resumeAction);
        agentSay("Welcome back — let's pick up where we left off.");
        setTimeout(askNextField, 600);
      } else {
        session.activeFormActionId = null;
        saveSession();
      }
    }

    // Panel state
    if (session.isOpen) openPanel();
    if (session.messages.length > 0 && !session.isOpen) {
      const badge = document.getElementById('wa-badge');
      if (badge) badge.classList.add('wa-show');
    }

    // First visit greeting (mock mode only — bridge sends its own greeting)
    if (session.messages.length === 0) {
      setTimeout(() => {
        if (!WA.bridge || !WA.bridge.isConnected()) {
          agentSay("Hi! I'm your Website Avatar. Connect the voice agent or type to get started.");
          const badge = document.getElementById('wa-badge');
          if (badge && !session.isOpen) badge.classList.add('wa-show');
        }
      }, 800);
    }

    scrollToBottom();
    renderDebug();
    checkArrival();
  }

  // ─── EXPOSE PUBLIC API ────────────────────────────────────────────────────

  WA.toggleChat     = toggleChat;
  WA.sendMessage    = sendMessage;
  WA.handleKey      = handleKey;
  WA.confirmAction  = confirmAction;
  WA.denyAction     = denyAction;
  WA.submitForm     = submitForm;
  WA.cancelFormFill = cancelFormFill;
  WA.manualSubmit   = () => submitGenericForm(); // for demo submit button

  // ─── HELPERS ──────────────────────────────────────────────────────────────

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ─── START ────────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', init);

})();

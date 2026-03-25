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
    // Only block send for non-form-fill active actions (navigation etc)
    // Never block during form fill — user needs to type answers
    const blocked = State.action === 'active' && !formState.active;
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
      if (raw) {
        const s = JSON.parse(raw);
        // Sanitise session on load — fix any state left by unexpected page changes
        const now = Date.now();

        // Mark any abandoned active fill_form as denied
        // (page navigated away mid-fill — don't resume automatically)
        (s.actions || []).forEach(a => {
          if (a.type === 'fill_form' && a.status === 'active') {
            a.status      = 'denied';
            a.completedAt = now;
          }
        });

        // Clear activeFormActionId — no auto-resume on page load
        // User must explicitly ask to fill the form again
        if (s.activeFormActionId) {
          s.activeFormActionId = null;
        }

        // Clear stale pendingOnArrival if navigate_then_fill already complete
        if (s.pendingOnArrival) {
          const alreadyArrived = (s.actions || []).some(
            a => a.type === 'navigate_then_fill' && a.status === 'complete'
          );
          if (alreadyArrived) delete s.pendingOnArrival;
        }
        return s;
      }
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

  let session = loadSession();

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

  // CLICK ELEMENT — click a CTA or button on the current page
  registerAction({
    type:            'click_element',
    label:           'Click page element',
    permissionLevel: 'propose',

    execute: async (action) => {
      const { elementId, elementText } = action.payload;
      const ctx = WA.PAGE_CONTEXT;
      const el  = ctx?._refs?.[elementId];
      if (!el) throw new Error(`Element ${elementId} not found`);
      agentSay(`Clicking "${elementText}" for you…`);
      await sleep(400);
      el.click();
    },

    onError: async (err, action) => {
      agentSay(`I couldn't click that — you can click "${action.payload.elementText}" yourself.`);
      reconnectBridge();
    },

    onComplete: async () => {
      setTimeout(reconnectBridge, 800);
    }
  });

  // SCROLL TO — scroll to a named section on the current page
  registerAction({
    type:            'scroll_to',
    label:           'Scroll to section',
    permissionLevel: 'auto', // no confirmation needed

    execute: async (action) => {
      const { elementId, elementTitle } = action.payload;
      const ctx = WA.PAGE_CONTEXT;
      const el  = ctx?._refs?.[elementId];
      if (!el) throw new Error(`Section ${elementId} not found`);
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      agentSay(`Scrolled to "${elementTitle}".`);
    },

    onError: async (err, action) => {
      agentSay(`I couldn't scroll there — try scrolling down manually.`);
      reconnectBridge();
    },

    onComplete: async () => {
      setTimeout(reconnectBridge, 600);
    }
  });

  // HIGHLIGHT ELEMENT — draw attention to an element (price, phone, email etc)
  registerAction({
    type:            'highlight_element',
    label:           'Highlight element',
    permissionLevel: 'auto',

    execute: async (action) => {
      const { elementId, elementText } = action.payload;
      const ctx = WA.PAGE_CONTEXT;
      const el  = ctx?._refs?.[elementId];
      if (!el) throw new Error(`Element ${elementId} not found`);
      // Scroll to it and add a temporary highlight
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const prev = el.style.cssText;
      el.style.outline        = '3px solid rgba(200,75,47,0.7)';
      el.style.outlineOffset  = '4px';
      el.style.borderRadius   = '4px';
      el.style.transition     = 'outline 0.3s ease';
      setTimeout(() => { el.style.cssText = prev; }, 3000);
      agentSay(`Here's ${elementText}.`);
    },

    onError: async (err, action) => {
      reconnectBridge();
    },

    onComplete: async () => {
      setTimeout(reconnectBridge, 600);
    }
  });

  // ─── PAGE / FORM HELPERS ──────────────────────────────────────────────────

  function getPageMap()    { return WA.PAGE_MAP || []; }
  function getFormMap()    { return WA.FORM_MAP || []; }

  function getContactPage() {
    return getPageMap().find(p =>
      p.label.toLowerCase().includes('contact') ||
      p.keywords.some(k => k.includes('contact')) ||
      p.file.includes('contact')
    ) || null;
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

    // Disconnect bridge before navigation — intentional, new page will reconnect
    _queuedMessage = null;
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

  // Queued message — sent to Michelle as soon as bridge reconnects
  let _queuedMessage = null;

  // Flag intentional disconnects so onBridgeDisconnected doesn't auto-reconnect
  let _intentionalDisconnect = false;



  async function startFormFill(action) {
    if (formState.active) return;

    formState.active = true;
    formState.action = action;

    session.activeFormActionId = action.id;
    saveSession();

    openPanel();
    updateAbortButton();
    repopulateFields(action);

    // Explicitly re-enable send button — form fill requires it
    // (it may have been disabled when action went active before formState.active was set)
    const sendBtn = document.getElementById('wa-send');
    if (sendBtn) { sendBtn.disabled = false; sendBtn.title = ''; }

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

    // Build field summary in DOM order — AI must follow this order strictly
    const fieldSummary = fields.map((f, idx) => {
      const val  = f.value
        ? (Array.isArray(f.value) ? f.value.join(', ') : '"' + f.value + '"')
        : 'empty';
      const opts = f.options?.length
        ? ` | options: [${f.options.map(o => o.value).join(', ')}]`
        : '';
      const multi = f.type === 'checkbox' ? ' | multi-select' : (f.type === 'radio' ? ' | single-select' : '');
      const typeHint = ['checkbox','radio','select'].includes(f.type)
        ? ` ⚠️ USE show_options action for this field`
        : '';
      return `${idx + 1}. ${f.label} (name: ${f.name}, type: ${f.type}${f.required ? ', required' : ', optional'}${multi}${opts}): ${val}${typeHint}`;
    }).join('\n');

    // Recent conversation for context
    const recentMsgs = session.messages.slice(-6).map(m =>
      `${m.role === 'user' ? 'User' : 'Agent'}: ${m.text}`
    ).join('\n');

    const prompt = `You are managing a form fill conversation for a website contact form.

FORM FIELDS (name | type | required | current value):
${fieldSummary}

RECENT CONVERSATION:
${recentMsgs}

USER JUST SAID: "${isResume ? '(continuing form fill — do NOT greet again, just ask for the next empty required field in sequence)' : userText}"

Reply with JSON only, no explanation:
{
  "action": "fill_field" | "correct_field" | "show_options" | "submit_ready" | "abort" | "ask_again",
  "field_name": "name attribute of field to update, or null",
  "value": "value to set for fill_field/correct_field, or null",
  "options": ["option1", "option2"] | null,
  "multi": true | false,
  "message": "what to say to the user",
  "all_required_filled": true | false
}

Rules:
- abort: user wants to stop, cancel, or leave (any phrasing)
- fill_field: user provided a value for a plain text/email/tel/textarea field
- correct_field: user is correcting a previously filled field
- show_options: field is type checkbox, radio, or select — render options as buttons for user to pick
- submit_ready: all required fields are filled
- ask_again: input was unclear or ambiguous
- IMPORTANT: Ask for fields strictly in the numbered order listed above — never skip or reorder
- After filling a field, confirm and ask for the NEXT field in sequence by number
- For checkbox/radio/select fields: always return show_options — never ask user to type their choice
- For show_options include field_name and all options from the field definition
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
        body:    JSON.stringify({ prompt, maxTokens: 250 })
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

      // ── show_options — render multi/single select card ──────────────────
      if (parsed.action === 'show_options' && parsed.field_name) {
        const field = fields.find(f => f.name === parsed.field_name);
        if (field) {
          if (parsed.message) agentSay(parsed.message);
          renderOptionsCard(field, parsed.multi !== false, (selected) => {
            // User confirmed selection — fill checkboxes in DOM
            field.value = selected; // array of values
            fillCheckboxField(field, selected);
            saveSession();
            // Tell AI what was selected and continue
            const summary = selected.length
              ? `Selected: ${selected.join(', ')}`
              : '(skipped)';
            handleFormInputAI(summary);
          });
          return;
        }
      }

      if (parsed.action === 'fill_field' || parsed.action === 'correct_field') {
        const field = fields.find(f => f.name === parsed.field_name);
        if (field) {
          // If AI returned fill_field for a choice field — intercept and show options card
          if (['checkbox', 'radio', 'select'].includes(field.type) && field.options?.length) {
            if (parsed.message) agentSay(parsed.message);
            renderOptionsCard(field, field.type !== 'radio', (selected) => {
              field.value = selected;
              if (field.type === 'select') {
                const el = getFieldElement(field);
                if (el) { el.value = selected[0] || ''; fillField(el, selected[0] || ''); }
              } else {
                fillCheckboxField(field, selected);
              }
              saveSession();
              const summary = selected.length ? `Selected: ${selected.join(', ')}` : '(skipped)';
              handleFormInputAI(summary);
            });
            return;
          }

          if (parsed.value) {
            field.value = parsed.value;
            const el = getFieldElement(field);
            if (el) {
              el.classList.add('wa-filling');
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              fillField(el, parsed.value);
            }
            saveSession();
          } else {
            // AI returned fill_field but no value — just show message and wait
            if (parsed.message) agentSay(parsed.message);
            return;
          }
        }
      }

      // submit_ready — go to confirmation card
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
    const missing = fields.filter(f => f.required && (!f.value || (Array.isArray(f.value) ? !f.value.length : !f.value.trim())));

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



  // ─── OPTIONS CARD ────────────────────────────────────────────────────────
  // Renders a multi/single-select card for checkbox, radio, or select fields.
  // User taps options to toggle, then confirms or skips.

  function renderOptionsCard(field, multi, onConfirm) {
    const selected = new Set();
    const msgs = document.getElementById('wa-messages');
    if (!msgs) return;

    const card = document.createElement('div');
    card.className = 'wa-options-card';

    const label = document.createElement('div');
    label.className = 'wa-options-label';
    label.textContent = multi ? 'Select all that apply' : 'Choose one';
    card.appendChild(label);

    const grid = document.createElement('div');
    grid.className = 'wa-options-grid';

    const options = field.options || [];
    options.forEach(opt => {
      const btn = document.createElement('button');
      btn.className = 'wa-option-btn';
      btn.textContent = opt.label || opt.value;
      btn.dataset.value = opt.value;
      btn.onclick = () => {
        if (!multi) {
          // Single select — clear others
          grid.querySelectorAll('.wa-option-btn').forEach(b => b.classList.remove('wa-option-selected'));
          selected.clear();
        }
        if (selected.has(opt.value)) {
          selected.delete(opt.value);
          btn.classList.remove('wa-option-selected');
        } else {
          selected.add(opt.value);
          btn.classList.add('wa-option-selected');
        }
      };
      grid.appendChild(btn);
    });
    card.appendChild(grid);

    const btnRow = document.createElement('div');
    btnRow.className = 'wa-card-btns';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'wa-btn wa-btn-confirm';
    confirmBtn.textContent = 'Confirm';
    confirmBtn.onclick = () => {
      card.remove();
      onConfirm([...selected]);
    };

    const skipBtn = document.createElement('button');
    skipBtn.className = 'wa-btn wa-btn-deny';
    skipBtn.textContent = 'Skip';
    skipBtn.onclick = () => {
      card.remove();
      onConfirm([]);
    };

    btnRow.appendChild(confirmBtn);
    if (!field.required) btnRow.appendChild(skipBtn);
    card.appendChild(btnRow);

    msgs.appendChild(card);
    scrollToBottom();
  }

  // Fill checkbox/radio inputs in the DOM
  function fillCheckboxField(field, selectedValues) {
    if (!selectedValues?.length) return;
    const form = WA.FORM_MAP?.[0]?.formEl;
    if (!form) return;

    // Uncheck all first
    const allInputs = form.querySelectorAll(
      `input[type="checkbox"][name="${field.name}"], input[type="checkbox"][name="${field.name}[]"],` +
      `input[type="radio"][name="${field.name}"], input[type="radio"][name="${field.name}[]"]`
    );
    allInputs.forEach(el => { el.checked = false; });

    // Check selected values
    selectedValues.forEach(val => {
      const el = form.querySelector(
        `input[name="${field.name}"][value="${val}"], input[name="${field.name}[]"][value="${val}"]`
      );
      if (el) {
        el.checked = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    // Highlight the group
    const firstEl = allInputs[0];
    if (firstEl) firstEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ─── END SESSION ─────────────────────────────────────────────────────────
  // First-class action — clears everything and returns to fresh state.

  function endSession() {
    log('Ending session');

    // Disconnect bridge first — intentional
    _queuedMessage = null;
    disconnectBridge();

    // Clear all session storage
    try { sessionStorage.removeItem(SESSION_KEY); } catch(e) {}
    try { sessionStorage.removeItem(PROMPTS_KEY); } catch(e) {}

    // Reset session object — isOpen false so panel stays closed on next load
    session = freshSession();
    session.isOpen = false;
    // Reset form state
    resetFormState();

    // Reset state machine
    State.connection   = 'offline';
    State.conversation = 'idle';
    State.action       = 'none';
    State.session      = 'fresh';

    // Reset inactivity
    inactivity.reset();

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

  function proposeAction(type, description, payload, autoOverride) {
    // Guard — only one pending/active action at a time
    const hasActive = session.actions.some(a => ['pending','active'].includes(a.status));
    if (hasActive) {
      log('Action already pending/active — skipping proposal');
      return;
    }

    const handler = ActionRegistry[type];
    const action  = createAction(type, description, payload);

    // Auto if registered as auto OR explicitly overridden by caller
    const isAuto = autoOverride === true || handler?.permissionLevel === 'auto';

    if (isAuto) {
      log(`Auto-executing: ${type}`);
      setState('action', 'active');
      action.status    = 'active';
      action.startedAt = Date.now();
      saveSession();
      disconnectBridge().then(() => executeAction(action));
      return;
    }

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
    // Only reset action state if no other action is currently active
    const hasOtherActive = session.actions.some(a => a.id !== actionId && a.status === 'active');
    if (!hasOtherActive) setState('action', 'none');
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
    // Only reset action state if no active action — form fill manages its own state
    const hasActive = session.actions.some(a => a.status === 'active');
    if (!hasActive) setState('action', 'none');
  }

  // ─── OPENAI CLASSIFICATION ────────────────────────────────────────────────
  // Fires once per agent message from one place. Pre-checks before API call.

  // ─── ACTION DECISION ENGINE ──────────────────────────────────────────────
  // Fires after every agent message. OpenAI reads Michelle's response,
  // the page context, and conversation history — then decides what to do.
  // No brittle signal word pre-checks. OpenAI is the brain.
  //
  // auto=true  → execute immediately (scroll, highlight)
  // auto=false → show confirmation card first (navigate, fill_form, click)

  let decideController = null;

  // Phrases that mean nothing actionable happened — skip the API call entirely
  const SKIP_PHRASES = [
    'are you still there', 'still there', "you're not responding",
    'gotten distracted', 'stepped away', 'seems like you',
    'how can i help', 'what can i help', 'what would you like',
    'is there anything', 'anything else i can help',
    'let me know if', 'feel free to ask'
  ];

  async function decideActions(userMessage, agentMessage) {
    const lower = agentMessage.toLowerCase();

    // Skip inactivity / generic phrases — nothing to act on
    if (SKIP_PHRASES.some(p => lower.includes(p))) {
      log('Action decision skipped — generic/inactivity phrase');
      return;
    }

    // Don't overlap with active actions
    if (session.actions.some(a => ['pending','active'].includes(a.status))) {
      log('Action decision skipped — action already active');
      return;
    }

    // Cancel any in-flight request from previous message
    if (decideController) decideController.abort();
    decideController = new AbortController();

    // Build context
    const pages      = getPageMap().map(p => `${p.label}|${p.file}`).join('\n');
    const currentUrl = window.location.href;
    const ctx        = WA.PAGE_CONTEXT;

    const pageEls = ctx?.elements?.length
      ? ctx.elements.map(e =>
          `${e.id}|${e.type}|${e.text || e.title || e.number || e.email || ''}|${e.actions.join(',')}`
        ).join('\n')
      : 'none';

    const recentMsgs = session.messages.slice(-4)
      .map(m => `${m.role === 'user' ? 'User' : 'Michelle'}: ${m.text}`)
      .join('\n');

    const prompt = `You are deciding what actions a website chat widget should take after the agent spoke.

CURRENT PAGE: ${document.title}
URL: ${currentUrl}

AVAILABLE PAGES (label|url):
${pages}

PAGE ELEMENTS (id|type|text/title|available_actions):
${pageEls}

RECENT CONVERSATION:
${recentMsgs}

AGENT JUST SAID: "${agentMessage}"

Decide what actions the widget should take now. Reply with JSON only:
{
  "actions": [
    {
      "type": "scroll_to"|"highlight_element"|"navigate"|"fill_form"|"navigate_then_fill"|"click_element"|"none",
      "auto": true|false,
      "element_id": "wa_el_N or null",
      "target_url": "exact url from pages list or null",
      "reason": "brief reason"
    }
  ]
}

Rules:
- Return empty actions array [] if nothing should happen
- auto: true = execute immediately without asking (scroll_to, highlight_element)
- auto: false = show user a confirmation card first (navigate, fill_form, click_element)
- scroll_to: agent mentioned or implied a section — scroll there automatically
- highlight_element: agent mentioned a phone number, email, price, or specific element — highlight it
- navigate: agent is sending user to a different page
- fill_form: agent is starting the contact form (only if user is already on contact page)
- navigate_then_fill: agent is sending user to contact page to fill form
- click_element: agent is about to click a button on behalf of user
- Only return actions that are clearly implied by what the agent said
- Never navigate to the current page
- Maximum 2 actions per response`;

    const t0 = Date.now();
    log('→ Action decision request sent');

    try {
      const res = await fetch(OPENAI_PROXY, {
        method:  'POST',
        signal:  decideController.signal,
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ prompt, maxTokens: 200 })
      });

      if (!res.ok) { warn('Action decision error:', res.status); return; }

      const data = await res.json();
      const raw  = data.content || '';
      log(`← Action decision ${Date.now() - t0}ms:`, raw.trim());

      let parsed;
      try {
        parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      } catch(e) { warn('Bad JSON from action decision:', raw); return; }

      if (!parsed.actions?.length) return;

      // Double-check still clear before executing
      if (session.actions.some(a => ['pending','active'].includes(a.status))) return;

      for (const action of parsed.actions) {
        if (!action.type || action.type === 'none') continue;
        await executeDecidedAction(action);
        // Small gap between multiple actions
        if (parsed.actions.indexOf(action) < parsed.actions.length - 1) {
          await sleep(300);
        }
      }

    } catch(e) {
      if (e.name === 'AbortError') {
        log('Action decision cancelled — superseded');
      } else {
        warn('Action decision failed:', e.message);
      }
    }
  }

  // Execute a single decided action
  async function executeDecidedAction(action) {
    const { type, auto, element_id, target_url } = action;

    const isAuto = auto === true; // respect OpenAI's decision

    if (type === 'scroll_to' || type === 'highlight_element') {
      const el = WA.PAGE_CONTEXT?.elements?.find(e => e.id === element_id);
      if (!el) return;
      const label = el.text || el.title || el.number || el.email || element_id;
      // scroll and highlight are auto by default unless OpenAI says otherwise
      proposeAction(type, label, {
        elementId:    el.id,
        elementText:  label,
        elementTitle: el.title || el.text || label
      }, isAuto !== false); // default to auto
      return;
    }

    if (type === 'fill_form') {
      proposeAction('fill_form', 'Help you fill out the contact form.', { fields: freshFields() }, isAuto);
      return;
    }

    if (type === 'navigate_then_fill') {
      const contact = getContactPage();
      if (!contact) return;
      proposeAction('navigate_then_fill',
        `Take you to the ${contact.label} and fill out the enquiry form.`,
        {
          targetPage:          contact.file,
          targetLabel:         contact.label,
          nextActionOnArrival: { type: 'fill_form', description: 'Fill out the contact form.', payload: { fields: [] } }
        },
        isAuto
      );
      return;
    }

    if (type === 'navigate' && target_url) {
      const targetClean  = target_url.replace(/\/$/, '');
      const currentClean = window.location.href.replace(/\/$/, '');
      if (targetClean === currentClean) return;

      const page    = getPageMap().find(p => p.file.replace(/\/$/, '') === targetClean);
      const label   = page ? page.label : 'page';
      const contact = getContactPage();

      if (contact && targetClean === contact.file.replace(/\/$/, '')) {
        proposeChoiceAction(
          `Would you like to just visit the ${contact.label}, or go there and fill out the enquiry form?`,
          [
            { label: 'Just browse',   action: { type: 'navigate',           description: `Take you to the ${contact.label}.`,                payload: { targetPage: contact.file, targetLabel: contact.label } } },
            { label: 'Fill the form', action: { type: 'navigate_then_fill', description: `Take you to the ${contact.label} and fill the form.`, payload: { targetPage: contact.file, targetLabel: contact.label, nextActionOnArrival: { type: 'fill_form', description: 'Fill out the contact form.', payload: { fields: [] } } } } }
          ]
        );
      } else {
        proposeAction('navigate', `Take you to the ${label}.`, { targetPage: target_url, targetLabel: label }, isAuto);
      }
      return;
    }

    if (type === 'click_element' && element_id) {
      const el = WA.PAGE_CONTEXT?.elements?.find(e => e.id === element_id);
      if (!el) return;
      proposeAction('click_element',
        `Click "${el.text || el.title}" for you.`,
        { elementId: el.id, elementText: el.text || el.title },
        isAuto
      );
    }
  }


  // ─── MESSAGE FLOW ─────────────────────────────────────────────────────────

  function sendMessage() {
    const input = document.getElementById('wa-input');
    const text  = (input ? input.value : '').trim();
    if (!text) return;

    // Only block send in voice mode while agent is speaking

    if (input) input.value = '';
    inactivity.justConnected = false; // user has spoken — inactivity can now count
    userSay(text);
    inactivity.reset();

    // Cancel in-flight classification and dismiss pending cards on new message
    if (decideController) { decideController.abort(); decideController = null; }
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

    // Bridge connecting or offline — queue message, it will be sent on connect
    if (WA.bridge) {
      _queuedMessage = text;
      showTyping();
      if (State.connection === 'offline') {
        reconnectBridge();
      }
      // If already connecting, onBridgeConnected will pick up the queued message
    }
  }

  function handleKey(e) {
    if (e.key === 'Enter') sendMessage();
  }

  function userSay(text) {
    hideWaitingHint();
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
    hideWaitingHint();
    session.messages.push({ role: 'agent', text, ts: Date.now() });
    if (State.session === 'fresh') {
      setState('session', 'active');
      updateSessionButton();
    }
    saveSession();

    appendMessage('agent', text);
  }

  // Expose for bridge
  WA.agentSay = agentSay;
  WA.userSay  = userSay;

  // ─── BRIDGE INTERFACE ─────────────────────────────────────────────────────
  // Clean interface for wa-elevenlabs.js — no direct function calls back in.

  WA.onBridgeConnecting   = () => { setState('connection', 'connecting'); };
  WA.onBridgeConnected    = () => {
    setState('connection', 'connected');
    inactivity.onConnect();
    // Show waiting hint only if no messages yet — disappears when Michelle responds
    if (!session.messages.length) showWaitingHint();
    // Send any message the user typed while bridge was offline/connecting
    // But not during form fill — form fill talks to OpenAI not the bridge
    if (_queuedMessage && WA.bridge && !formState.active) {
      const msg = _queuedMessage;
      _queuedMessage = null;
      hideTyping();
      setTimeout(() => {
        WA.bridge.sendText(msg);
        WA._lastUserMessage = msg;
        setState('conversation', 'awaiting');
      }, 400);
    } else if (_queuedMessage && formState.active) {
      // Form fill is active — route queued message through AI not bridge
      const msg = _queuedMessage;
      _queuedMessage = null;
      hideTyping();
      handleFormInputAI(msg);
    }
  };
  WA.onBridgeDisconnected = () => {
    setState('connection', 'offline');
    setState('conversation', 'idle');
    hideTyping();
    hideWaitingHint();

    const wasIntentional = _intentionalDisconnect;
    _intentionalDisconnect = false; // reset for next time

    // Unexpected drop during active session — reconnect after brief delay
    if (!wasIntentional && State.session === 'active' && !formState.active) {
      log('Unexpected disconnect — reconnecting in 1500ms');
      setTimeout(reconnectBridge, 1500);
    } else if (!wasIntentional && formState.active) {
      log('Disconnect during form fill — suppressed, form fill continues via AI');
    }
  };
  // No speaking callbacks in text-only mode
  WA.onAgentMessage       = (text) => { agentSay(text); decideActions(WA._lastUserMessage || '', text); };
  WA.onUserMessage        = (text) => {
    inactivity.justConnected = false; // user has spoken — inactivity can now count
    userSay(text);
    WA._lastUserMessage = text;
    inactivity.reset();
  };
  function disconnectBridge() {
    _intentionalDisconnect = true;
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
      // justConnected stays true until user speaks — don't count inactivity before that
      if (this.justConnected) return;
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
  let waitingHintEl = null;

  function showWaitingHint() {
    hideWaitingHint();
    const msgs = document.getElementById('wa-messages');
    if (!msgs) return;
    waitingHintEl = document.createElement('div');
    waitingHintEl.className = 'wa-waiting-hint';
    waitingHintEl.textContent = 'Connected — type a message to start…';
    msgs.appendChild(waitingHintEl);
    scrollToBottom();
  }

  function hideWaitingHint() {
    if (waitingHintEl) { waitingHintEl.remove(); waitingHintEl = null; }
  }

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

  // Note: ElevenLabs text-only mode supports streaming via onAgentChatResponsePart
  // — could be wired up here for word-by-word text rendering in future

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
      // Connect whenever panel opens — unless form fill is active (AI mode)
      if (WA.bridge && !WA.bridge.isConnected() &&
          State.connection !== 'connecting' && !formState.active) {
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

    // Fresh visit — show badge to draw attention, Michelle greets when user connects
    if (!hasActiveSession) {
      setTimeout(() => {
        const badge = document.getElementById('wa-badge');
        if (badge && !session.isOpen) badge.classList.add('wa-show');
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
  // Used by bridge to open panel without triggering reconnect
  WA._openPanelDirect = () => {
    session.isOpen = true;
    saveSession();
    scrollToBottom();
    updateSessionButton();
  };
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
/**
 * features/actions.js — Action System
 * Action registry, all action handlers, execution orchestration
 * Reads page context, emits state changes, calls UI functions
 */

(function () {

  const WA = window.WebsiteAvatar || (window.WebsiteAvatar = {});

  // ─── ACTION REGISTRY ──────────────────────────────────────────────────────

  const ActionRegistry = {};

  function registerAction(def) {
    ActionRegistry[def.type] = def;
    if (WA.DEBUG) console.log(`[WA] Action registered: ${def.type}`);
  }

  async function executeAction(action, session) {
    const handler = ActionRegistry[action.type];
    if (!handler) {
      console.warn(`[WA] No handler for action type: ${action.type}`);
      if (WA.agentSay) WA.agentSay("I don't know how to do that yet — I'll let the team know.");
      if (WA.setState) WA.setState('action', 'error');
      return;
    }

    if (WA.setState) WA.setState('action', 'active');
    action.status    = 'active';
    action.startedAt = Date.now();
    if (WA.saveSession) WA.saveSession(session);
    if (WA.updateAbortButton) WA.updateAbortButton(true);

    try {
      await handler.execute(action, session);
      action.status      = 'complete';
      action.completedAt = Date.now();
      if (WA.saveSession) WA.saveSession(session);
      if (WA.setState) WA.setState('action', 'complete');
      if (WA.updateAbortButton) WA.updateAbortButton(false);
      if (handler.onComplete) await handler.onComplete(action);
    } catch (err) {
      console.warn(`[WA] Action ${action.type} failed:`, err);
      action.status      = 'failed';
      action.error       = { message: err.message, retryable: !!err.retryable };
      action.completedAt = Date.now();
      if (WA.saveSession) WA.saveSession(session);
      if (WA.setState) WA.setState('action', 'error');
      if (WA.updateAbortButton) WA.updateAbortButton(false);
      if (handler.onError) {
        await handler.onError(err, action);
      } else {
        if (WA.agentSay) WA.agentSay("Something went wrong — please try again or complete this manually.");
      }
    }
  }

  // ─── ACTION HANDLERS ──────────────────────────────────────────────────────

  // NAVIGATE
  registerAction({
    type:            'navigate',
    label:           'Navigate to page',
    permissionLevel: 'propose',

    execute: async (action) => {
      const { targetPage, targetLabel } = action.payload;
      if (WA.agentSay) WA.agentSay(`Navigating you to the ${targetLabel}…`);
      await WA.sleep(800);
      if (WA.navigateTo) WA.navigateTo(targetPage, targetLabel);
    },

    onError: async (err, action) => {
      if (WA.agentSay) WA.agentSay(`I couldn't navigate to ${action.payload.targetLabel}. You can find it in the menu.`);
      if (WA.reconnectBridge) WA.reconnectBridge();
    },

    onComplete: async () => {
      // Reconnect happens in checkArrival() on new page
    }
  });

  // FILL FORM
  registerAction({
    type:            'fill_form',
    label:           'Fill contact form',
    permissionLevel: 'propose',

    execute: async (action) => {
      return new Promise(resolve => {
        action._resolveFormFill = resolve;
        startFormFill(action);
      });
    },

    onError: async (err, action) => {
      if (WA.agentSay) WA.agentSay("I had trouble filling the form. You can complete it manually — all the fields are visible.");
      if (WA.reconnectBridge) WA.reconnectBridge();
    },

    onComplete: async (action) => {
      setTimeout(() => { if (WA.reconnectBridge) WA.reconnectBridge(); }, 1000);
    }
  });

  // NAVIGATE THEN FILL
  registerAction({
    type:            'navigate_then_fill',
    label:           'Go to contact page and fill form',
    permissionLevel: 'propose',

    execute: async (action, session) => {
      const { targetPage, targetLabel, nextActionOnArrival } = action.payload;
      if (WA.agentSay) WA.agentSay(`I'll take you to the ${targetLabel} and we'll fill out the form together.`);
      session.pendingOnArrival = { page: targetPage, action: nextActionOnArrival };
      if (WA.saveSession) WA.saveSession(session);
      await WA.sleep(1000);
      if (WA.navigateTo) WA.navigateTo(targetPage, targetLabel);
    },

    onError: async (err, action) => {
      if (WA.agentSay) WA.agentSay(`I couldn't navigate to ${action.payload.targetLabel}. You can find it in the menu.`);
      if (WA.reconnectBridge) WA.reconnectBridge();
    },

    onComplete: async () => {}
  });

  // CLICK ELEMENT
  registerAction({
    type:            'click_element',
    label:           'Click page element',
    permissionLevel: 'propose',

    execute: async (action) => {
      const { elementId, elementText } = action.payload;
      const ctx = WA.PAGE_CONTEXT;
      const el  = ctx?._refs?.[elementId];
      if (!el) throw new Error(`Element ${elementId} not found`);
      if (WA.agentSay) WA.agentSay(`Clicking "${elementText}" for you…`);
      await WA.sleep(400);
      el.click();
    },

    onError: async (err, action) => {
      if (WA.agentSay) WA.agentSay(`I couldn't click that — you can click "${action.payload.elementText}" yourself.`);
      if (WA.reconnectBridge) WA.reconnectBridge();
    },

    onComplete: async () => {
      setTimeout(() => { if (WA.reconnectBridge) WA.reconnectBridge(); }, 800);
    }
  });

  // SCROLL TO (with sparkle highlight effect)
  registerAction({
    type:            'scroll_to',
    label:           'Scroll to section',
    permissionLevel: 'auto',

    execute: async (action) => {
      const { sectionId, sectionTitle, elementId, elementTitle } = action.payload;
      
      const idToFind = sectionId || elementId;
      const titleToShow = sectionTitle || elementTitle;
      
      // Try multiple methods to find the element
      let el = null;
      
      // Method 1: Try _refs first (fastest if it works)
      const ctx = WA.PAGE_CONTEXT;
      if (ctx?._refs?.[idToFind] && ctx._refs[idToFind] instanceof HTMLElement) {
        el = ctx._refs[idToFind];
        if (WA.DEBUG) console.log('[WA] Found element via _refs');
      }
      
      // Method 2: Try document.getElementById
      if (!el) {
        el = document.getElementById(idToFind);
        if (el && WA.DEBUG) console.log('[WA] Found element via getElementById');
      }
      
      // Method 3: Try finding by data attribute
      if (!el) {
        el = document.querySelector(`[data-section-id="${idToFind}"]`);
        if (el && WA.DEBUG) console.log('[WA] Found element via data attribute');
      }
      
      // Method 4: Find by matching title
      if (!el && ctx?.page?.sections) {
        const section = ctx.page.sections.find(s => s.id === idToFind);
        if (section) {
          const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
          for (const heading of headings) {
            if (heading.textContent.trim() === section.title) {
              el = heading.closest('section, article, div[class*="section"], main > div');
              if (el) {
                if (WA.DEBUG) console.log('[WA] Found element by matching title');
                break;
              }
            }
          }
        }
      }
      
      if (!el) {
        console.warn('[WA] Section not found after trying all methods:', idToFind);
        throw new Error(`Section ${idToFind} not found`);
      }
      
      // Smart scroll with offset for fixed headers and better positioning
      const rect = el.getBoundingClientRect();
      const absoluteTop = window.pageYOffset + rect.top;
      
      // Check if there's a fixed header
      const header = document.querySelector('header[style*="fixed"], nav[style*="fixed"], .fixed-header, .sticky-header');
      const headerHeight = header ? header.offsetHeight : 0;
      
      // Calculate scroll position: element top minus header height minus some padding
      const targetY = absoluteTop - headerHeight - 20; // 20px padding
      
      window.scrollTo({
        top: Math.max(0, targetY),
        behavior: 'smooth'
      });
      
      await WA.sleep(600);
      if (WA.spawnSparkles) WA.spawnSparkles(el);
      if (WA.agentSay) WA.agentSay(`Here's the ${titleToShow}.`);
    
      // Skip turn - prevent disconnect during scroll
      if (WA.bridge?.skipTurn) WA.bridge.skipTurn();
    },

    onError: async (err, action) => {
      if (WA.agentSay) WA.agentSay(`I couldn't scroll there — try scrolling down manually.`);
      if (WA.reconnectBridge) WA.reconnectBridge();
    },

    onComplete: async () => {
      setTimeout(() => { if (WA.reconnectBridge) WA.reconnectBridge(); }, 600);
    }
  });

  // ─── FORM FILL ────────────────────────────────────────────────────────────

  let _completeFormFillAttempts = 0;

  async function startFormFill(action) {
    if (WA.formState.active) return;

    WA.formState.active = true;
    WA.formState.action = action;

    const session = WA.getSession();
    session.activeFormActionId = action.id;
    WA.saveSession(session);

    WA.openPanel();
    WA.updateAbortButton(true);
    repopulateFields(action);
    routeFormInput('__RESUME__');
  }

  async function routeFormInput(userText) {
    if (!WA.formState.action) return;

    const session    = WA.getSession();
    const fields     = WA.formState.action.payload.fields;
    const recentMsgs = session.messages.slice(-6);

    WA.showTyping();
    const result = await WA.handleFormInputAI(userText, fields, recentMsgs);
    WA.hideTyping();

    if (!result || result.error) {
      if (result?.message) WA.agentSay(result.message);
      return;
    }

    if (result.action === 'abort') {
      abandonFormFill();
      return;
    }

    // Show options
    if (result.action === 'show_options' && result.field_name) {
      const field = fields.find(f => f.name === result.field_name);
      if (field) {
        if (result.message) WA.agentSay(result.message);
        WA.renderOptionsCard(field, result.multi !== false, (selected) => {
          field.value = selected;
          WA.fillCheckboxField(field, selected);
          WA.saveSessionDebounced(WA.getSession());
          const summary = selected.length ? `Selected: ${selected.join(', ')}` : '(skipped)';
          routeFormInput(summary);
        });
        return;
      }
    }

    // Fill field
    if (result.action === 'fill_field' || result.action === 'correct_field') {
      const field = fields.find(f => f.name === result.field_name);
      if (field) {
        // Intercept choice fields
        if (['checkbox', 'radio', 'select'].includes(field.type) && field.options?.length) {
          if (result.message) WA.agentSay(result.message);
          WA.renderOptionsCard(field, field.type !== 'radio', (selected) => {
            field.value = selected;
            if (field.type === 'select') {
              const el = WA.getFieldElement(field);
              if (el) { el.value = selected[0] || ''; WA.fillField(el, selected[0] || ''); }
            } else {
              WA.fillCheckboxField(field, selected);
            }
            WA.saveSessionDebounced(WA.getSession());
            const summary = selected.length ? `Selected: ${selected.join(', ')}` : '(skipped)';
            routeFormInput(summary);
          });
          return;
        }

        if (result.value) {
          field.value = result.value;
          const el = WA.getFieldElement(field);
          if (el) {
            el.classList.add('wa-filling');
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            WA.fillField(el, result.value);
          }
          WA.saveSessionDebounced(WA.getSession());
        } else {
          if (result.message) WA.agentSay(result.message);
          return;
        }
      }
    }

    // Submit ready
    if (result.action === 'submit_ready' || result.all_required_filled) {
      setTimeout(completeFormFill, 400);
      return;
    }

    if (result.message) WA.agentSay(result.message);
  }

  function completeFormFill() {
    if (!WA.formState.action) return;
    const fields  = WA.formState.action.payload.fields;
    const missing = fields.filter(f => f.required && (!f.value || (Array.isArray(f.value) ? !f.value.length : !f.value.trim())));

    if (missing.length) {
      _completeFormFillAttempts++;
      if (_completeFormFillAttempts <= 2) {
        routeFormInput('__RESUME__');
      } else {
        _completeFormFillAttempts = 0;
        WA.agentSay(`I still need: ${missing.map(f => f.label).join(', ')}. Please provide these to continue.`);
      }
      return;
    }
    _completeFormFillAttempts = 0;

    const filled  = fields.filter(f => f.value);
    const summary = filled.map(f => `${f.label}: ${f.value}`).join(', ');

    WA.agentSay(`All set! I've filled in ${summary}. Ready to send?`);

    WA.renderCard({
      label:   'Ready to submit',
      message: 'Shall I submit the form now?',
      buttons: [
        { text: 'Submit', action: () => submitForm() },
        { text: 'Cancel', action: () => cancelFormFill(), style: 'deny' }
      ]
    });
  }

  async function submitForm() {
    const session = WA.getSession();
    if (WA.formState.action) {
      WA.formState.action.status      = 'complete';
      WA.formState.action.completedAt = Date.now();
    }
    const parent = session.actions.find(a => a.type === 'navigate_then_fill' && a.status === 'active');
    if (parent) { parent.status = 'complete'; parent.completedAt = Date.now(); }
    session.activeFormActionId = null;
    WA.saveSession(session);

    const formEl = document.querySelector('.wpcf7-form');
    if (formEl) {
      await submitCF7Form(formEl);
    } else {
      await submitGenericForm();
    }
  }

  function submitCF7Form(formEl) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn('[WA] CF7 response timed out');
        handleFormSubmitFallback();
        resolve();
      }, 10000);

      const onSuccess = () => { clearTimeout(timeout); cleanup(); finishFormFill('success'); resolve(); };
      const onInvalid = (e) => { clearTimeout(timeout); cleanup(); handleCF7ValidationError(e.detail); resolve(); };
      const onSpam    = () => {
        clearTimeout(timeout); cleanup();
        WA.agentSay("The form was flagged — please click the submit button manually to complete your enquiry.");
        WA.highlightSubmitButton();
        WA.reconnectBridge();
        resolve();
      };
      const onFailed  = () => {
        clearTimeout(timeout); cleanup();
        WA.agentSay("There was a problem sending the form. Please try submitting manually or try again in a moment.");
        WA.reconnectBridge();
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

      const submitBtn = formEl.querySelector('[type="submit"], .wpcf7-submit');
      if (submitBtn) {
        if (WA.DEBUG) console.log('[WA] Clicking CF7 submit button');
        submitBtn.click();
      } else {
        console.warn('[WA] CF7 submit button not found');
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
      await WA.sleep(1000);
      finishFormFill('success');
    } else {
      WA.agentSay("The form is filled — please click the submit button to send your enquiry.");
      WA.highlightSubmitButton();
      WA.resetFormState();
      WA.setState('action', 'none');
    }
  }

  function finishFormFill(outcome) {
    WA.clearFieldHighlights();
    const session = WA.getSession();
    session.activeFormActionId = null;
    WA.saveSession(session);
    if (WA.formState.action) {
      WA.updateActionCardStatus(WA.formState.action.id, 'complete');
    }
    if (WA.formState.action?._resolveFormFill) {
      WA.formState.action._resolveFormFill();
    }
    WA.resetFormState();
  }

  function handleCF7ValidationError(detail) {
    const failedInputs = document.querySelectorAll('.wpcf7-not-valid');
    if (failedInputs.length && WA.formState.action) {
      const failedNames = Array.from(failedInputs).map(el => el.getAttribute('name'));
      WA.formState.action.payload.fields.forEach(f => {
        if (failedNames.includes(f.name)) f.value = null;
      });
      WA.formState.active = true;
      routeFormInput('__RESUME__');
      return;
    }
    WA.agentSay("Some fields need correcting — please check the form.");
    WA.reconnectBridge();
  }

  function handleFormSubmitFallback() {
    WA.agentSay("The form is filled — please click the submit button to send your enquiry.");
    WA.highlightSubmitButton();
    WA.reconnectBridge();
  }

  function cancelFormFill() {
    if (WA.formState.action) {
      WA.formState.action.status      = 'denied';
      WA.formState.action.completedAt = Date.now();
      if (WA.formState.action._resolveFormFill) WA.formState.action._resolveFormFill();
    }
    const session = WA.getSession();
    session.activeFormActionId = null;
    WA.saveSession(session);
    WA.resetFormState();
    WA.setState('action', 'none');
    setTimeout(() => WA.reconnectBridge(), 800);
  }

  function abandonFormFill() {
    if (WA.formState.action) {
      WA.formState.action.status      = 'denied';
      WA.formState.action.completedAt = Date.now();
      if (WA.formState.action._resolveFormFill) WA.formState.action._resolveFormFill();
    }
    const session = WA.getSession();
    session.activeFormActionId = null;
    WA.clearFieldHighlights();
    WA.saveSession(session);
    WA.resetFormState();
    WA.setState('action', 'none');
    setTimeout(() => WA.reconnectBridge(), 800);
  }

  function repopulateFields(action) {
    action.payload.fields.forEach(f => {
      if (f.value !== null) {
        const el = WA.getFieldElement(f);
        if (el) WA.fillField(el, f.value);
      }
    });
  }

  // ─── URL VALIDATION ───────────────────────────────────────────────────────

  async function validateUrl(url) {
    try {
      const resp = await fetch(url, { method: 'HEAD' });
      return resp.ok;
    } catch {
      return false;
    }
  }

  // ─── ACTION ORCHESTRATION ─────────────────────────────────────────────────

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
    return action;
  }

  async function proposeAction(session, type, description, payload, autoOverride) {
    // Guard — only one pending/active at a time
    const hasActive = session.actions.some(a => ['pending','active'].includes(a.status));
    if (hasActive) {
      if (WA.DEBUG) console.log('[WA] Action already pending/active — skipping proposal');
      return { failed: false, reason: 'action_already_active' }; // Return status
    }
  
    const handler = ActionRegistry[type];
  
    // For navigate actions, validate URL first
    if (type === 'navigate' && payload?.targetPage) {
      const isValid = await validateUrl(payload.targetPage);
      if (!isValid) {
        if (WA.DEBUG) console.warn(`[WA] Navigation blocked — 404 detected: ${payload.targetPage}`);
        
        // Record the failure in session state
        session.lastUrlValidationFailure = {
          targetUrl: payload.targetPage,
          targetLabel: payload.targetLabel,
          attemptedAt: Date.now(),
          userMessage: WA._lastUserMessage || '',
          agentResponse: session.messages[session.messages.length - 1]?.text || ''
        };
        
        if (WA.saveSession) WA.saveSession(session);
        
        // Provide immediate feedback to user
        if (WA.agentSay) {
          WA.agentSay(`I tried to find "${payload.targetLabel}" but that page isn't available. Let me suggest an alternative.`);
        }
        
        // Reconnect only if disconnected - if connected, agent will see failure on next turn
        if (WA.reconnectBridge && WA.bridge && !WA.bridge.isConnected()) {
          setTimeout(() => WA.reconnectBridge(), 1500);
        }
        
        return { failed: true, reason: 'url_validation_failed' }; // Return failure status
      }
    }
  
    const action  = createAction(type, description, payload);
    session.actions.push(action);
    if (WA.saveSession) WA.saveSession(session);

    const isAuto = autoOverride === true || handler?.permissionLevel === 'auto';

    if (isAuto) {
      if (WA.DEBUG) console.log(`[WA] Auto-executing: ${type}`);
      if (WA.setState) WA.setState('action', 'active');
      action.status    = 'active';
      action.startedAt = Date.now();
      if (WA.saveSession) WA.saveSession(session);

      // Skip turn instead of disconnect - stay connected during action
      if (WA.bridge?.skipTurn) WA.bridge.skipTurn();
      executeAction(action, session);
      return { failed: false }; // Success
    }

    if (WA.setState) WA.setState('action', 'proposed');
    if (WA.renderActionCard) WA.renderActionCard(action);
  }

  function proposeChoiceAction(session, description, options) {
    const hasActive = session.actions.some(a => ['pending','active'].includes(a.status));
    if (hasActive) return;

    if (WA.renderCard) {
      WA.renderCard({
        label:   'Choose an action',
        message: description,
        buttons: options.map((opt) => ({
          text:   opt.label,
          style:  'confirm',
          action: () => {
            const a = createAction(opt.action.type, opt.action.description, opt.action.payload);
            session.actions.push(a);
            a.status    = 'active';
            a.startedAt = Date.now();
            if (WA.saveSession) WA.saveSession(session);

            // Skip turn instead of disconnect - stay connected during action
            if (WA.bridge?.skipTurn) WA.bridge.skipTurn();
            executeAction(a, session);
          }
        })).concat([{ text: 'No thanks', style: 'deny', action: () => { if (WA.setState) WA.setState('action', 'none'); } }])
      });
    }
  }

  function confirmAction(actionId, session) {
    const action = session.actions.find(a => a.id === actionId);
    if (!action || action.status !== 'pending') return;
    if (WA.setState) WA.setState('action', 'active');
    if (WA.updateActionCardStatus) WA.updateActionCardStatus(actionId, 'active');

    // Skip turn instead of disconnect - stay connected during action
    if (WA.bridge?.skipTurn) WA.bridge.skipTurn();
    executeAction(action, session);
  }

  function denyAction(actionId, session) {
    const action = session.actions.find(a => a.id === actionId);
    if (!action || action.status !== 'pending') return;
    action.status      = 'denied';
    action.completedAt = Date.now();
    if (WA.saveSession) WA.saveSession(session);
    if (WA.updateActionCardStatus) WA.updateActionCardStatus(actionId, 'denied');
    const hasOtherActive = session.actions.some(a => a.id !== actionId && a.status === 'active');
    if (!hasOtherActive && WA.setState) WA.setState('action', 'none');
    if (WA.agentSay) WA.agentSay("No problem — just let me know if you change your mind.");
  }

  function dismissPendingActions(session) {
    session.actions.forEach(a => {
      if (a.status === 'pending') {
        a.status      = 'denied';
        a.completedAt = Date.now();
        const card = document.querySelector(`[data-action-id="${a.id}"]`);
        if (card) card.style.display = 'none';
      }
    });
    if (WA.saveSession) WA.saveSession(session);
    const hasActive = session.actions.some(a => a.status === 'active');
    if (!hasActive && WA.setState) WA.setState('action', 'none');
  }

  function abortCurrentAction(session) {
    const activeAction = session.actions.find(a => a.status === 'active');
    if (!activeAction) return;

    if (WA.formState?.active) {
      abandonFormFill();
      return;
    }

    activeAction.status      = 'denied';
    activeAction.completedAt = Date.now();
    if (WA.saveSession) WA.saveSession(session);
    if (WA.setState) WA.setState('action', 'none');
    if (WA.updateAbortButton) WA.updateAbortButton(false);
    if (WA.agentSay) WA.agentSay("Action cancelled. What would you like to do?");
    setTimeout(() => { if (WA.reconnectBridge) WA.reconnectBridge(); }, 600);
  }

  // ─── EXPOSE ───────────────────────────────────────────────────────────────

  WA.ActionRegistry        = ActionRegistry;
  WA.registerAction        = registerAction;
  WA.executeAction         = executeAction;
  WA.createAction          = createAction;
  WA.proposeAction         = proposeAction;
  WA.proposeChoiceAction   = proposeChoiceAction;
  WA.confirmAction         = confirmAction;
  WA.denyAction            = denyAction;
  WA.dismissPendingActions = dismissPendingActions;
  WA.abortCurrentAction    = abortCurrentAction;
  WA.startFormFill         = startFormFill;
  WA.routeFormInput        = routeFormInput;
  WA.submitForm            = submitForm;
  WA.cancelFormFill        = cancelFormFill;
  WA.abandonFormFill       = abandonFormFill;
  WA.repopulateFields      = repopulateFields;

})();
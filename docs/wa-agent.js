/**
 * wa-agent.js — Website Avatar Core (Refactored)
 * Main orchestrator - imports modules, wires together, exposes public API
 * This file must load AFTER core/ and features/ modules
 */

(function () {

  // ─── NAMESPACE ────────────────────────────────────────────────────────────
  window.WebsiteAvatar = window.WebsiteAvatar || {};
  const WA = window.WebsiteAvatar;

  // ─── CONFIG ───────────────────────────────────────────────────────────────
  const CONFIG = window.WA_CONFIG || {};
  WA.DEBUG = CONFIG.debug || false;

  // ─── SESSION ──────────────────────────────────────────────────────────────
  let session = WA.loadSession();
  WA.getSession = () => session;

  let _completeFormFillAttempts = 0;
  WA._completeFormFillAttempts = _completeFormFillAttempts;

  // ─── MESSAGE FLOW ─────────────────────────────────────────────────────────

  function sendMessage() {
    const input = document.getElementById('wa-input');
    const text  = (input ? input.value : '').trim();
    if (!text) return;

    if (input) input.value = '';
    WA.inactivity.justConnected = false;
    userSay(text);
    WA.inactivity.reset();

    // Cancel in-flight AI and dismiss pending cards
    if (WA.formAIController) WA.formAIController.abort();
    if (WA.bridge && WA.bridge.isConnected()) WA.dismissPendingActions(session);

    // Form fill takes priority
    if (WA.formState.active) {
      routeFormInput(text);
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

    // Queue message if bridge offline
    if (WA.bridge) {
      WA.queueMessage(text);
      WA.showTyping();
      if (WA.State.connection === 'offline') {
        WA.reconnectBridge();
      }
    }
  }

  function handleKey(e) {
    if (e.key === 'Enter') sendMessage();
  }

  function userSay(text) {
    WA.hideWaitingHint();
    session.messages.push({ role: 'user', text, ts: Date.now() });
    if (WA.State.session === 'fresh') {
      WA.setState('session', 'active');
      WA.updateSessionButton(true);
    }
    WA.saveSession(session);
    WA.appendMessage('user', text);
  }

  function agentSay(text) {
    WA.hideTyping();
    WA.hideWaitingHint();
    session.messages.push({ role: 'agent', text, ts: Date.now() });
    if (WA.State.session === 'fresh') {
      WA.setState('session', 'active');
      WA.updateSessionButton(true);
    }
    WA.saveSession(session);
    WA.appendMessage('agent', text);
  }

  // ─── NAVIGATION ───────────────────────────────────────────────────────────

  function navigateTo(url, label) {
    const overlay  = document.getElementById('wa-transition');
    const navLabel = overlay ? overlay.querySelector('.wa-nav-label') : null;
    if (navLabel) navLabel.textContent = `Heading to ${label}…`;
    if (overlay)  overlay.classList.add('active');

    WA.clearQueue();
    WA.disconnectBridge();
    setTimeout(() => { window.location.href = url; }, 400);
  }

  function checkArrival() {
    // Simple navigate
    const navAction = session.actions.find(a => a.type === 'navigate' && a.status === 'active');
    if (navAction) {
      // Mark as complete BEFORE reconnecting so state is ready
      navAction.status      = 'complete';
      navAction.completedAt = Date.now();
      WA.saveSession(session);
      
      // Clear action state so new messages can flow
      WA.setState('action', 'none');
      
      WA.openPanel();
      
      // Reconnect and send arrival prompt
      setTimeout(() => {
        WA.reconnectBridge();
        
        // Wait for connection, then send arrival message
        setTimeout(() => {
          if (WA.bridge && WA.bridge.sendText) {
            const context = WA.PAGE_CONTEXT?.summary || 'this page';
            WA.bridge.sendText(`I've arrived at ${context}.`);
          }
        }, 1000);
      }, 100);
      return;
    }

    // Navigate then fill
    if (!session.pendingOnArrival) return;
    const { page, action } = session.pendingOnArrival;

    const currentPath = window.location.pathname.replace(/\/$/, '');
    const targetPath  = new URL(page, window.location.href).pathname.replace(/\/$/, '');

    if (currentPath !== targetPath) return;

    delete session.pendingOnArrival;
    WA.saveSession(session);
    WA.openPanel();

    setTimeout(async () => {
      const fields = WA.freshFields();
      if (!fields.length) {
        agentSay("I'm here but I couldn't find the contact form. You can fill it in manually.");
        WA.reconnectBridge();
        return;
      }
      action.payload.fields = fields;
      agentSay("We're here! Let's fill out that contact form.");
      const fullAction = WA.createAction('fill_form', action.description, action.payload);
      session.actions.push(fullAction);
      await WA.executeAction(fullAction, session);
    }, 900);
  }

  // ─── FORM FILL ────────────────────────────────────────────────────────────

  async function startFormFill(action) {
    if (WA.formState.active) return;

    WA.formState.active = true;
    WA.formState.action = action;

    session.activeFormActionId = action.id;
    WA.saveSession(session);

    WA.openPanel();
    WA.updateAbortButton(true);
    repopulateFields(action);

    // Re-enable send button
    const sendBtn = document.getElementById('wa-send');
    if (sendBtn) { sendBtn.disabled = false; sendBtn.title = ''; }

    // Start AI conversation
    routeFormInput('__RESUME__');
  }

  async function routeFormInput(userText) {
    if (!WA.formState.action) return;

    const fields   = WA.formState.action.payload.fields;
    const recentMsgs = session.messages.slice(-6);

    WA.showTyping();
    const result = await WA.handleFormInputAI(userText, fields, recentMsgs);
    WA.hideTyping();

    if (!result || result.error) {
      if (result?.message) agentSay(result.message);
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
        if (result.message) agentSay(result.message);
        WA.renderOptionsCard(field, result.multi !== false, (selected) => {
          field.value = selected;
          WA.fillCheckboxField(field, selected);
          WA.saveSession(session);
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
          if (result.message) agentSay(result.message);
          WA.renderOptionsCard(field, field.type !== 'radio', (selected) => {
            field.value = selected;
            if (field.type === 'select') {
              const el = WA.getFieldElement(field);
              if (el) { el.value = selected[0] || ''; WA.fillField(el, selected[0] || ''); }
            } else {
              WA.fillCheckboxField(field, selected);
            }
            WA.saveSession(session);
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
          WA.saveSession(session);
        } else {
          if (result.message) agentSay(result.message);
          return;
        }
      }
    }

    // Submit ready
    if (result.action === 'submit_ready' || result.all_required_filled) {
      setTimeout(completeFormFill, 400);
      return;
    }

    if (result.message) agentSay(result.message);
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
        agentSay(`I still need: ${missing.map(f => f.label).join(', ')}. Please provide these to continue.`);
      }
      return;
    }
    _completeFormFillAttempts = 0;

    const filled  = fields.filter(f => f.value);
    const summary = filled.map(f => `${f.label}: ${f.value}`).join(', ');

    agentSay(`All set! I've filled in ${summary}. Ready to send?`);

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

      const onSuccess = () => {
        clearTimeout(timeout);
        cleanup();
        finishFormFill('success');
        resolve();
      };

      const onInvalid = (e) => {
        clearTimeout(timeout);
        cleanup();
        handleCF7ValidationError(e.detail);
        resolve();
      };

      const onSpam = () => {
        clearTimeout(timeout);
        cleanup();
        agentSay("The form was flagged — please click the submit button manually to complete your enquiry.");
        highlightSubmitButton();
        WA.reconnectBridge();
        resolve();
      };

      const onFailed = () => {
        clearTimeout(timeout);
        cleanup();
        agentSay("There was a problem sending the form. Please try submitting manually or try again in a moment.");
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
      agentSay("The form is filled — please click the submit button to send your enquiry.");
      highlightSubmitButton();
      WA.resetFormState();
      WA.setState('action', 'none');
    }
  }

  function finishFormFill(outcome) {
    document.querySelectorAll('.wa-filling').forEach(el => el.classList.remove('wa-filling'));
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
    agentSay("Some fields need correcting — please check the form.");
    WA.reconnectBridge();
  }

  function handleFormSubmitFallback() {
    agentSay("The form is filled — please click the submit button to send your enquiry.");
    highlightSubmitButton();
    WA.reconnectBridge();
  }

  function highlightSubmitButton() {
    const btn = document.querySelector('.wpcf7-submit, [type="submit"], .btn-submit');
    if (btn) {
      btn.style.boxShadow = '0 0 0 3px rgba(200,75,47,0.5)';
      btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function cancelFormFill() {
    if (WA.formState.action) {
      WA.formState.action.status      = 'denied';
      WA.formState.action.completedAt = Date.now();
      if (WA.formState.action._resolveFormFill) WA.formState.action._resolveFormFill();
    }
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
    session.activeFormActionId = null;
    document.querySelectorAll('.wa-filling').forEach(el => el.classList.remove('wa-filling'));
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

  // ─── END SESSION ──────────────────────────────────────────────────────────

  function endSession() {
    if (WA.DEBUG) console.log('[WA] Ending session');

    WA.clearQueue();
    WA.disconnectBridge();

    try { sessionStorage.removeItem('wa_session'); } catch(e) {}
    try { sessionStorage.removeItem('wa_sent_prompts'); } catch(e) {}

    session = WA.freshSession();
    session.isOpen = false;
    WA.resetFormState();

    WA.State.connection   = 'offline';
    WA.State.conversation = 'idle';
    WA.State.action       = 'none';
    WA.State.session      = 'fresh';

    WA.inactivity.reset();

    const msgs = document.getElementById('wa-messages');
    if (msgs) msgs.innerHTML = '';

    const endBtn   = document.getElementById('wa-end-session-btn');
    const abortBtn = document.getElementById('wa-abort-btn');
    if (endBtn)   endBtn.remove();
    if (abortBtn) abortBtn.remove();

    const panel = document.getElementById('wa-panel');
    if (panel) panel.classList.remove('wa-open');

    setTimeout(() => {
      if (msgs) {
        const el = document.createElement('div');
        el.className   = 'wa-msg wa-agent';
        el.textContent = 'Session ended. Open the chat to start a new conversation.';
        msgs.appendChild(el);
      }
    }, 300);

    WA.saveSession(session);
    WA.renderDebug();
    if (WA.DEBUG) console.log('[WA] Session ended — fresh state restored');
  }

  // ─── ACTION CARD RENDERING ────────────────────────────────────────────────

  function renderActionCard(action) {
    WA.renderCard({
      label:      'Proposed action',
      message:    action.description,
      actionId:   action.id,
      buttons: [
        { text: "Let's do it", style: 'confirm', action: () => WA.confirmAction(action.id, session) },
        { text: 'No thanks',   style: 'deny',    action: () => WA.denyAction(action.id, session) }
      ]
    });
  }

  // ─── AI DECISION ENGINE ───────────────────────────────────────────────────

  async function handleAgentMessage(userMessage, agentMessage, knowledgeContext) {
    const result = await WA.decideActions(
      userMessage,
      agentMessage,
      knowledgeContext,  // Pass knowledge context from Michelle
      WA.PAGE_CONTEXT,
      session.messages.slice(-4),
      session.actions
    );

    if (!result || !result.actions?.length) return;

    // Double-check still clear
    if (session.actions.some(a => ['pending','active'].includes(a.status))) return;

    for (const action of result.actions) {
      if (!action.type || action.type === 'none') continue;
      await executeDecidedAction(action);
      if (result.actions.indexOf(action) < result.actions.length - 1) {
        await WA.sleep(300);
      }
    }
  }

  async function executeDecidedAction(action) {
    const { type, auto, element_id, target_url } = action;
    const isAuto = auto === true;

    if (type === 'scroll_to') {
      const expandedId = element_id?.startsWith('wa_el_') ? element_id : `wa_el_${element_id}`;
      const el = WA.PAGE_CONTEXT?.elements?.find(e => e.id === expandedId);
      if (!el) return;
      const label = el.text || el.title || el.number || el.email || element_id;
      WA.proposeAction(session, 'scroll_to', label, {
        elementId:    el.id,
        elementText:  label,
        elementTitle: el.title || el.text || label
      }, isAuto !== false); // scroll_to is auto by default
      return;
    }

    if (type === 'fill_form') {
      WA.proposeAction(session, 'fill_form', 'Help you fill out the contact form.', { fields: WA.freshFields() }, isAuto);
      return;
    }

    if (type === 'navigate_then_fill') {
      const contact = WA.getContactPage();
      if (!contact) return;
      WA.proposeAction(session, 'navigate_then_fill',
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

      const page    = WA.getPageMap().find(p => p.file.replace(/\/$/, '') === targetClean);
      const label   = page ? page.label : 'page';
      const contact = WA.getContactPage();

      if (contact && targetClean === contact.file.replace(/\/$/, '')) {
        WA.proposeChoiceAction(session,
          `Would you like to just visit the ${contact.label}, or go there and fill out the enquiry form?`,
          [
            { label: 'Just browse',   action: { type: 'navigate',           description: `Take you to the ${contact.label}.`,                payload: { targetPage: contact.file, targetLabel: contact.label } } },
            { label: 'Fill the form', action: { type: 'navigate_then_fill', description: `Take you to the ${contact.label} and fill the form.`, payload: { targetPage: contact.file, targetLabel: contact.label, nextActionOnArrival: { type: 'fill_form', description: 'Fill out the contact form.', payload: { fields: [] } } } } }
          ]
        );
      } else {
        WA.proposeAction(session, 'navigate', `Take you to the ${label}.`, { targetPage: target_url, targetLabel: label }, isAuto);
      }
      return;
    }

    if (type === 'click_element' && element_id) {
      const expandedId = element_id?.startsWith('wa_el_') ? element_id : `wa_el_${element_id}`;
      const el = WA.PAGE_CONTEXT?.elements?.find(e => e.id === expandedId);
      if (!el) return;
      WA.proposeAction(session, 'click_element',
        `Click "${el.text || el.title}" for you.`,
        { elementId: el.id, elementText: el.text || el.title },
        isAuto
      );
    }
  }

  // ─── INIT ─────────────────────────────────────────────────────────────────

  function init() {
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
        WA.formState.active = true;
        WA.formState.action = resumeAction;
        repopulateFields(resumeAction);
        WA.updateAbortButton(true);
        setTimeout(() => routeFormInput('__RESUME__'), 400);
      } else {
        session.activeFormActionId = null;
        WA.saveSession(session);
      }
    }

    // Panel state
    if (session.isOpen && session.messages.length > 0) WA.openPanel();
    if (session.messages.length > 0 && !session.isOpen) {
      const badge = document.getElementById('wa-badge');
      if (badge) badge.classList.add('wa-show');
    }

    // Fresh visit
    if (!hasActiveSession) {
      setTimeout(() => {
        const badge = document.getElementById('wa-badge');
        if (badge && !session.isOpen) badge.classList.add('wa-show');
      }, 1500);
    }

    WA.scrollToBottom();
    WA.renderDebug();
    checkArrival();

    // Auto-connect if session active
    if (hasActiveSession && !hasNavAction && !hasFormResume) {
      WA.reconnectBridge();
    }

    // Show end session button
    if (hasActiveSession) {
      WA.setState('session', 'active');
      WA.updateSessionButton(true);
    }

    // Setup bridge callbacks
    WA.setupBridgeCallbacks();
  }

  // ─── EXPOSE PUBLIC API ────────────────────────────────────────────────────

  WA.sendMessage         = sendMessage;
  WA.handleKey           = handleKey;
  WA.agentSay            = agentSay;
  WA.userSay             = userSay;
  WA.navigateTo          = navigateTo;
  WA.startFormFill       = startFormFill;
  WA.submitForm          = submitForm;
  WA.cancelFormFill      = cancelFormFill;
  WA.abandonFormFill     = abandonFormFill;
  WA.endSession          = endSession;
  WA.renderActionCard    = renderActionCard;
  WA.handleAgentMessage  = handleAgentMessage;
  WA.routeFormInput      = routeFormInput;
  WA._lastUserMessage    = '';

  // ─── START ────────────────────────────────────────────────────────────────

  function waitForPanel(cb, attempts = 0) {
    if (document.getElementById('wa-messages')) {
      cb();
    } else if (attempts < 30) {
      setTimeout(() => waitForPanel(cb, attempts + 1), 100);
    } else {
      console.warn('[WA] wa-messages element never appeared — init aborted');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => waitForPanel(init));
  } else {
    waitForPanel(init);
  }

})();
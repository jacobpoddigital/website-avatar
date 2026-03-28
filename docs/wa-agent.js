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

  async function endSession() {
    if (WA.DEBUG) console.log('[WA] Ending session');

    // SAVE SESSION BEFORE DISCONNECTING
    const userId = WA.getUserId ? WA.getUserId() : null;
    if (userId && session.elevenlabsConversationId && session.messages?.length) {
      if (WA.DEBUG) console.log('[WA] 💾 Saving session before end...');
      
      try {
        const response = await fetch('https://backend.jacob-e87.workers.dev/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: userId,
            conversation_id: session.elevenlabsConversationId,
            transcript: session.messages,
            analysis: {
              lastSaved: new Date().toISOString(),
              messageCount: session.messages.length,
              endedManually: true
            }
          })
        });
        
        if (response.ok) {
          if (WA.DEBUG) console.log('[WA] ✅ Session saved before end');
        }
      } catch (err) {
        console.error('[WA] ❌ Failed to save session before end:', err);
      }
    }

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
    // Action type labels for buttons
    const actionTypeLabels = {
      'navigate': 'Navigate',
      'fill_form': 'Fill Form',
      'navigate_then_fill': 'Navigate',
      'click_element': 'Click',
      'scroll_to': 'Scroll'
    };
    
    const actionTypeLabel = actionTypeLabels[action.type] || action.type;
    
    // Build message with context (no bold formatting)
    const messageParts = [action.description];
  
    // Add destination/element context if available
    if (action.payload?.targetLabel) {
      messageParts.push(`Destination: ${action.payload.targetLabel}`);
    } else if (action.payload?.elementTitle) {
      messageParts.push(`Section: ${action.payload.elementTitle}`);
    } else if (action.payload?.elementText) {
      messageParts.push(`Element: ${action.payload.elementText}`);
    }
  
    WA.renderCard({
      label:    'Proposed action',
      message:  messageParts.join('\n\n'),
      actionId: action.id,
      buttons: [
        { 
          text: "Let's do it", 
          label: actionTypeLabel,  // Add action type as button label
          style: 'confirm', 
          action: () => WA.confirmAction(action.id, session) 
        },
        { text: 'No thanks', style: 'deny', action: () => WA.denyAction(action.id, session) }
      ]
    });
  }
  
  function renderMultiActionCard(actions) {
    // Action type labels
    const actionTypeLabels = {
      'navigate': 'Navigate',
      'fill_form': 'Fill Form',
      'navigate_then_fill': 'Navigate',
      'click_element': 'Click',
      'scroll_to': 'Scroll'
    };
    
    // Sort by confidence (if available)
    const sorted = [...actions].sort((a, b) => 
      (b.confidence || 0.8) - (a.confidence || 0.8)
    );
    
    // Build button options from actions
    const buttons = sorted.map(action => {
      let label = action.description || action.type;
      
      // Add destination context to button label
      if (action.target_label) {
        label = `${action.target_label}`;
      }
      
      // Add confidence indicator for uncertain actions
      const conf = action.confidence || 0.8;
      const indicator = conf < 0.7 ? ' (?)' : '';
      
      // Get action type label
      const actionTypeLabel = actionTypeLabels[action.type] || action.type;
      
      return {
        text: label + indicator,
        label: actionTypeLabel,  // Add action type as button label
        style: 'confirm',
        action: async () => {
          await executeDecidedAction(action);
        }
      };
    });
    
    // Add "No thanks" option
    buttons.push({ 
      text: 'No thanks', 
      style: 'deny', 
      action: () => { 
        if (WA.setState) WA.setState('action', 'none');
      } 
    });
    
    WA.renderCard({
      label: 'Choose an action',
      message: 'I found a few options for you:',
      buttons: buttons
    });
  }

  // ─── CONTEXT FILTERING (INTENT-AWARE) ─────────────────────────────────────

  function normalise(text) {
    return (text || "")
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function scoreElement(el, ctx) {
    let score = 0;

    const keywords = (ctx?.keywords || []).map(normalise);
    const targetSection = normalise(ctx?.section || "");

    const haystack = normalise(
      (el.title || "") + " " +
      (el.summary || "") + " " +
      (el.text || "")
    );

    // keyword match
    keywords.forEach(k => {
      if (haystack.includes(k)) score += 5;
    });

    // strong section match
    if (targetSection && el.title && normalise(el.title).includes(targetSection)) {
      score += 20;
    }

    // subsection relevance
    if (el.subsections) {
      el.subsections.forEach(sub => {
        const subText = normalise(sub.title + " " + sub.description);
        keywords.forEach(k => {
          if (subText.includes(k)) score += 3;
        });
      });
    }

    // CTA context boost
    if (el.context) {
      const ctxText = normalise(el.context);
      keywords.forEach(k => {
        if (ctxText.includes(k)) score += 2;
      });
    }

    return score;
  }

  function filterPageContext(pageContext, knowledge) {
    if (!pageContext?.elements || !knowledge) return pageContext;

    const scored = pageContext.elements.map(el => ({
      ...el,
      _score: scoreElement(el, knowledge)
    }));

    const filtered = scored
      .filter(el => el._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 12); // limit size

    return {
      ...pageContext,
      elements: filtered
    };
  }

  function debugFilteredContext(full, filtered, knowledge) {
    if (!WA.DEBUG) return;

    console.group('[WA] 🧠 Context Filtering');

    console.log('Intent:', knowledge?.intent);
    console.log('Keywords:', knowledge?.keywords);
    console.log('Section:', knowledge?.section);

    console.group(`📦 FULL (${full.elements.length})`);
    full.elements.forEach(e => {
      console.log(`${e.type}: ${e.title || e.text}`);
    });
    console.groupEnd();

    console.group(`🎯 FILTERED (${filtered.elements.length})`);
    filtered.elements.forEach(e => {
      console.log(`${e.type}: ${e.title || e.text} (score: ${e._score})`);
      if (e.subsections) {
        e.subsections.forEach(sub => {
          console.log(`   ↳ ${sub.title}`);
        });
      }
    });
    console.groupEnd();

    console.groupEnd();
  }

  // ─── AI DECISION ENGINE ───────────────────────────────────────────────────

  async function handleAgentMessage(userMessage, agentMessage, knowledgeContext) {
    // Apply intent-aware filtering
    const filteredContext = filterPageContext(WA.PAGE_CONTEXT, knowledgeContext);
  
    // Debug full vs filtered
    debugFilteredContext(WA.PAGE_CONTEXT, filteredContext, knowledgeContext);
  
    // GATE: Skip OpenAI if filtering did nothing
    if (filteredContext.elements.length === WA.PAGE_CONTEXT.elements.length) {
      if (WA.DEBUG) console.log('[WA] No filtering applied (0% reduction) — skipping OpenAI');
      return;
    }
  
    const result = await WA.decideActions(
      userMessage,
      agentMessage,
      knowledgeContext,
      filteredContext, // Only pass filtered context
      session.messages.slice(-4),
      session.actions
    );
  
    if (!result || !result.actions?.length) return;
  
    // Double-check still clear
    if (session.actions.some(a => ['pending','active'].includes(a.status))) return;
  
    // Filter out 'none' actions
    const validActions = result.actions.filter(a => a.type && a.type !== 'none');
    if (!validActions.length) return;
  
    // Multiple high-confidence actions → show multi-action card (never auto)
    const highConfidence = validActions.filter(a => (a.confidence || 0.8) >= 0.7);
    if (highConfidence.length > 1) {
      // Force all actions to require confirmation when showing choice card
      const manualActions = highConfidence.map(a => ({ ...a, auto: false }));
      renderMultiActionCard(manualActions);
      return;
    }
  
    // Single action or mixed confidence → execute in sequence
    for (const action of validActions) {
      await executeDecidedAction(action);
      if (validActions.indexOf(action) < validActions.length - 1) {
        await WA.sleep(300);
      }
    }
  }

  async function executeDecidedAction(action) {
    const { type, auto, element_id, target_url, target_label, reason, confidence } = action;
    const isAuto = auto === true;
  
    if (type === 'scroll_to') {
      const expandedId = element_id?.startsWith('wa_el_') ? element_id : `wa_el_${element_id}`;
      const el = WA.PAGE_CONTEXT?.elements?.find(e => e.id === expandedId);
      if (!el) return;
      
      // Use target_label from AI if provided, otherwise fallback
      const label = target_label || el.text || el.title || el.number || el.email || element_id;
      const description = reason || `Show you the ${label} section`;
      
      WA.proposeAction(session, 'scroll_to', description, {
        elementId:    el.id,
        elementText:  label,
        elementTitle: el.title || el.text || label,
        confidence:   confidence
      }, isAuto !== false); // scroll_to is auto by default
      return;
    }
  
    if (type === 'fill_form') {
      const description = reason || 'Help you fill out the contact form';
      WA.proposeAction(session, 'fill_form', description, { 
        fields: WA.freshFields(),
        confidence: confidence
      }, isAuto);
      return;
    }
  
    if (type === 'navigate_then_fill') {
      const contact = WA.getContactPage();
      if (!contact) return;
      
      const description = reason || `Take you to the ${contact.label} and fill out the enquiry form`;
      const result = await WA.proposeAction(session, 'navigate_then_fill',
        description,
        {
          targetPage:          contact.file,
          targetLabel:         target_label || contact.label,
          nextActionOnArrival: { type: 'fill_form', description: 'Fill out the contact form.', payload: { fields: [] } },
          confidence:          confidence
        },
        isAuto
      );
      return result;
    }
  
    if (type === 'navigate' && target_url) {
      const targetClean  = target_url.replace(/\/$/, '');
      const currentClean = window.location.href.replace(/\/$/, '');
      if (targetClean === currentClean) return;
  
      const page    = WA.getPageMap().find(p => p.file.replace(/\/$/, '') === targetClean);
      const label   = target_label || (page ? page.label : 'page');
      const contact = WA.getContactPage();
  
      if (contact && targetClean === contact.file.replace(/\/$/, '')) {
        WA.proposeChoiceAction(session,
          `Would you like to just visit the ${label}, or go there and fill out the enquiry form?`,
          [
            { label: 'Just browse',   action: { type: 'navigate',           description: `Take you to the ${label}.`,                payload: { targetPage: contact.file, targetLabel: label } } },
            { label: 'Fill the form', action: { type: 'navigate_then_fill', description: `Take you to the ${label} and fill the form.`, payload: { targetPage: contact.file, targetLabel: label, nextActionOnArrival: { type: 'fill_form', description: 'Fill out the contact form.', payload: { fields: [] } } } } }
          ]
        );
      } else {
        const description = reason || `Take you to the ${label}`;
        const result = await WA.proposeAction(session, 'navigate', description, { 
          targetPage: target_url, 
          targetLabel: label,
          confidence: confidence
        }, isAuto);
        return result;
      }
      return;
    }
  
    if (type === 'click_element' && element_id) {
      const expandedId = element_id?.startsWith('wa_el_') ? element_id : `wa_el_${element_id}`;
      const el = WA.PAGE_CONTEXT?.elements?.find(e => e.id === expandedId);
      if (!el) return;
      
      const label = target_label || el.text || el.title;
      const description = reason || `Click "${label}" for you`;
      
      WA.proposeAction(session, 'click_element',
        description,
        { 
          elementId: el.id, 
          elementText: label,
          confidence: confidence
        },
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
  WA.renderMultiActionCard = renderMultiActionCard;
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
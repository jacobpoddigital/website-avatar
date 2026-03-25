/**
 * wa-ui.js — User interface
 * Messaging, action cards, options cards, typing indicators, panel control.
 */

(function () {

    const WA = window.WebsiteAvatar;
    if (!WA) { console.error('[WA:UI] Core not loaded'); return; }
  
    // ─── MESSAGING ────────────────────────────────────────────────────────────
    WA.userSay = function(text) {
      WA.session.messages.push({ role: 'user', text, ts: Date.now() });
      if (WA.State.session === 'fresh') {
        WA.setState('session', 'active');
        if (WA.updateSessionButton) WA.updateSessionButton();
      }
      WA.saveSession();
      renderMessage('user', text);
    };
  
    WA.agentSay = function(text) {
      WA.hideTyping();
      WA.session.messages.push({ role: 'agent', text, ts: Date.now() });
      if (WA.State.session === 'fresh') {
        WA.setState('session', 'active');
        if (WA.updateSessionButton) WA.updateSessionButton();
      }
      WA.saveSession();
      renderMessage('agent', text);
    };
  
    function renderMessage(role, text) {
      const msgs = document.getElementById('wa-messages');
      if (!msgs) return;
      const msg = document.createElement('div');
      msg.className = `wa-msg wa-${role}`;
      msg.textContent = text;
      msgs.appendChild(msg);
      scrollToBottom();
    }
  
    // ─── TYPING INDICATOR ─────────────────────────────────────────────────────
    WA.showTyping = function() {
      hideTyping();
      const msgs = document.getElementById('wa-messages');
      if (!msgs) return;
      const typing = document.createElement('div');
      typing.className = 'wa-typing';
      typing.id        = 'wa-typing-indicator';
      typing.innerHTML = '<span></span><span></span><span></span>';
      msgs.appendChild(typing);
      scrollToBottom();
    };
  
    WA.hideTyping = function() {
      const typing = document.getElementById('wa-typing-indicator');
      if (typing) typing.remove();
    };
  
    function hideTyping() { WA.hideTyping(); }
  
    // ─── ACTION CARDS ─────────────────────────────────────────────────────────
    WA.createAction = function(type, description, payload) {
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
      WA.session.actions.push(action);
      WA.saveSession();
      return action;
    };
  
    WA.proposeAction = function(type, description, payload, autoOverride) {
      const hasActive = WA.session.actions.some(a => ['pending','active'].includes(a.status));
      if (hasActive) {
        WA.log('Action already pending/active — skipping proposal');
        return;
      }
  
      const handler = WA.ActionRegistry[type];
      const action  = WA.createAction(type, description, payload);
  
      const isAuto = autoOverride === true || handler?.permissionLevel === 'auto';
  
      if (isAuto) {
        WA.log(`Auto-executing: ${type}`);
        WA.setState('action', 'active');
        action.status    = 'active';
        action.startedAt = Date.now();
        WA.saveSession();
        disconnectBridge().then(() => WA.executeAction(action));
        return;
      }
  
      WA.setState('action', 'proposed');
      renderActionCard(action);
    };
  
    WA.proposeChoiceAction = function(description, options) {
      const hasActive = WA.session.actions.some(a => ['pending','active'].includes(a.status));
      if (hasActive) return;
  
      WA.renderCard({
        label:   'Choose an action',
        message: description,
        buttons: options.map((opt) => {
          // Extract action details from the option structure
          const actionDef = opt.action || opt;
          
          // Build proper payload based on action type
          let payload = {};
          let description = actionDef.reason || opt.label;
          
          if (actionDef.type === 'navigate') {
            const pages = WA.getPageMap();
            const targetUrl = actionDef.target_url;
            const page = pages.find(p => p.file.includes(targetUrl) || targetUrl.includes(p.file));
            payload = {
              targetPage: page ? page.file : targetUrl,
              targetLabel: page ? page.label : 'page'
            };
          } else if (actionDef.type === 'scroll_to') {
            const expandedId = actionDef.element_id?.startsWith('wa_el_') 
              ? actionDef.element_id 
              : `wa_el_${actionDef.element_id}`;
            const el = WA.PAGE_CONTEXT?.elements?.find(e => e.id === expandedId);
            if (el) {
              payload = {
                elementId: el.id,
                elementText: el.text || el.title,
                elementTitle: el.title || el.text
              };
            }
          } else if (actionDef.type === 'fill_form') {
            payload = { fields: WA.freshFields() };
          }
  
          return {
            text: opt.label,
            style: 'confirm',
            action: () => {
              const a = WA.createAction(actionDef.type, description, payload);
              a.status = 'active';
              a.startedAt = Date.now();
              WA.saveSession();
              disconnectBridge().then(() => WA.executeAction(a));
            }
          };
        }).concat([{ 
          text: 'No thanks', 
          style: 'deny', 
          action: () => {
            WA.setState('action', 'none');
            if (WA.reconnectBridge) WA.reconnectBridge();
          }
        }])
      });
    };
  
    function renderActionCard(action) {
      WA.renderCard({
        label:    WA.ActionRegistry[action.type]?.label || action.type,
        message:  action.description,
        actionId: action.id,
        buttons: [
          { text: 'Go ahead', style: 'confirm', action: () => WA.confirmAction(action.id) },
          { text: 'No thanks', style: 'deny', action: () => WA.denyAction(action.id) }
        ]
      });
    }
  
    WA.confirmAction = function(actionId) {
      const action = WA.session.actions.find(a => a.id === actionId);
      if (!action || action.status !== 'pending') return;
      WA.setState('action', 'active');
      WA.updateActionCardStatus(actionId, 'active');
      disconnectBridge().then(() => WA.executeAction(action));
    };
  
    WA.denyAction = function(actionId) {
      const action = WA.session.actions.find(a => a.id === actionId);
      if (!action || action.status !== 'pending') return;
      action.status      = 'denied';
      action.completedAt = Date.now();
      WA.saveSession();
      WA.updateActionCardStatus(actionId, 'denied');
      const hasOtherActive = WA.session.actions.some(a => a.id !== actionId && a.status === 'active');
      if (!hasOtherActive) WA.setState('action', 'none');
      WA.agentSay("No problem — just let me know if you change your mind.");
    };
  
    WA.dismissPendingActions = function() {
      WA.session.actions.forEach(a => {
        if (a.status === 'pending') {
          a.status      = 'denied';
          a.completedAt = Date.now();
          const card = document.querySelector(`[data-action-id="${a.id}"]`);
          if (card) card.style.display = 'none';
        }
      });
      WA.saveSession();
      const hasActive = WA.session.actions.some(a => a.status === 'active');
      if (!hasActive) WA.setState('action', 'none');
    };
  
    // ─── GENERIC CARD RENDERER ────────────────────────────────────────────────
    WA.renderCard = function({ label, message, buttons, actionId }) {
      const card = document.createElement('div');
      card.className = 'wa-card';
      if (actionId) card.dataset.actionId = actionId;
  
      const btnsHtml = buttons.map((btn, idx) =>
        `<button class="wa-btn wa-btn-${btn.style}" data-btn-idx="${idx}">${btn.text}</button>`
      ).join('');
  
      card.innerHTML = `
        <div class="wa-card-label">${label}</div>
        <p>${message}</p>
        <div class="wa-card-btns">${btnsHtml}</div>
      `;
  
      card.querySelectorAll('button[data-btn-idx]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.btnIdx);
          buttons[idx].action();
        });
      });
  
      const msgs = document.getElementById('wa-messages');
      if (msgs) { msgs.appendChild(card); scrollToBottom(); }
    };
  
    WA.updateActionCardStatus = function(actionId, status) {
      const card = document.querySelector(`[data-action-id="${actionId}"]`);
      if (!card) return;
      const btnsEl = card.querySelector('.wa-card-btns');
      if (!btnsEl) return;
  
      const labels = { active: 'Active', denied: 'Cancelled', complete: 'Done' };
      const styles = { active: 'wa-status-active', denied: 'wa-status-denied', complete: 'wa-status-complete' };
  
      btnsEl.innerHTML = `<span class="wa-status ${styles[status] || ''}">${labels[status] || status}</span>`;
    };
  
    // ─── OPTIONS CARD (for form fields) ───────────────────────────────────────
    WA.renderOptionsCard = function(field, multi, onConfirm) {
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
    };
  
    // ─── ABORT BUTTON ─────────────────────────────────────────────────────────
    WA.updateAbortButton = function() {
      const existing = document.getElementById('wa-abort-btn');
      const msgs     = document.getElementById('wa-messages');
      if (!msgs) return;
  
      const hasActive = WA.session.actions.some(a => a.status === 'active');
  
      if (hasActive && !existing) {
        const btn = document.createElement('button');
        btn.id        = 'wa-abort-btn';
        btn.className = 'wa-btn-abort';
        btn.textContent = '✕ Cancel action';
        btn.title     = 'Cancel current action';
        btn.onclick   = () => abortCurrentAction();
        msgs.appendChild(btn);
        scrollToBottom();
      } else if (!hasActive && existing) {
        existing.remove();
      }
    };
  
    function abortCurrentAction() {
      const activeAction = WA.session.actions.find(a => a.status === 'active');
      if (!activeAction) return;
  
      if (WA.formState.active) {
        if (WA.cancelFormFill) WA.cancelFormFill();
        return;
      }
  
      activeAction.status      = 'denied';
      activeAction.completedAt = Date.now();
      WA.saveSession();
      WA.setState('action', 'none');
      WA.updateAbortButton();
      WA.agentSay("Action cancelled. What would you like to do?");
      setTimeout(() => WA.reconnectBridge(), 600);
    }
  
    // ─── END SESSION & UPDATE SESSION BUTTON ──────────────────────────────────
    WA.endSession = function() {
      WA.log('Ending session');
  
      // Disconnect bridge first — intentional
      if (WA.bridge && WA.bridge.isConnected()) {
        WA.bridge.disconnect();
      }
  
      // Clear all session storage
      try { sessionStorage.removeItem(WA.SESSION_KEY); } catch(e) {}
      try { sessionStorage.removeItem(WA.PROMPTS_KEY); } catch(e) {}
  
      // Reset session object
      WA.session = { messages: [], actions: [], activeFormActionId: null, isOpen: false };
      
      // Reset form state
      if (WA.formState) {
        WA.formState.active = false;
        WA.formState.action = null;
      }
  
      // Reset state machine
      WA.State.connection   = 'offline';
      WA.State.conversation = 'idle';
      WA.State.action       = 'none';
      WA.State.session      = 'fresh';
  
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
  
      // Show greeting
      setTimeout(() => {
        if (msgs) {
          const el = document.createElement('div');
          el.className   = 'wa-msg wa-agent';
          el.textContent = 'Session ended. Open the chat to start a new conversation.';
          msgs.appendChild(el);
        }
      }, 300);
  
      WA.saveSession();
      if (WA.renderDebug) WA.renderDebug();
      WA.log('Session ended — fresh state restored');
    };
  
    WA.updateSessionButton = function() {
      const existing = document.getElementById('wa-end-session-btn');
      const panel    = document.getElementById('wa-panel');
      if (!panel) return;
  
      const hasSession = WA.session.messages.length > 0;
  
      if (hasSession && !existing) {
        const btn = document.createElement('button');
        btn.id        = 'wa-end-session-btn';
        btn.className = 'wa-btn-end-session';
        btn.textContent = 'End session';
        btn.title     = 'Clear conversation and start fresh';
        btn.onclick   = () => {
          if (confirm('End this session and clear the conversation?')) WA.endSession();
        };
        const inputRow = panel.querySelector('.wa-input-row');
        if (inputRow) panel.insertBefore(btn, inputRow);
        else panel.appendChild(btn);
      } else if (!hasSession && existing) {
        existing.remove();
      }
    };
  
    // ─── PANEL CONTROL ────────────────────────────────────────────────────────
    WA.openPanel = function() {
      const panel = document.getElementById('wa-panel');
      if (panel && !panel.classList.contains('wa-open')) {
        panel.classList.add('wa-open');
        WA.session.isOpen = true;
        WA.saveSession();
      }
    };
  
    WA.toggleChat = function() {
      const panel = document.getElementById('wa-panel');
      if (!panel) return;
      const isOpen = panel.classList.toggle('wa-open');
      WA.session.isOpen = isOpen;
      WA.saveSession();
  
      if (isOpen) {
        const badge = document.getElementById('wa-badge');
        if (badge) badge.classList.remove('wa-show');
        if (WA.bridge && !WA.bridge.isConnected() &&
            WA.State.connection !== 'connecting' && !WA.formState.active) {
          WA.reconnectBridge();
        }
      }
    };
  
    function scrollToBottom() {
      const msgs = document.getElementById('wa-messages');
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
    }
  
    // ─── BRIDGE CONTROL (helpers for actions) ────────────────────────────────
    async function disconnectBridge() {
      if (WA.bridge && WA.bridge.isConnected()) {
        await WA.bridge.disconnect();
      }
    }
  
    WA.bus.emit('ui:ready');
    WA.log('UI module loaded');
  
  })();
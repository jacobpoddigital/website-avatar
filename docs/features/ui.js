/**
 * features/ui.js — UI Rendering
 * All DOM manipulation, message rendering, cards, buttons, indicators
 * Reads state, emits events, but doesn't mutate global state
 */

(function () {

  const WA = window.WebsiteAvatar || (window.WebsiteAvatar = {});

  let typingEl      = null;
  let waitingHintEl = null;

  // ─── TYPING INDICATORS ────────────────────────────────────────────────────

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

  // ─── MESSAGES ─────────────────────────────────────────────────────────────

  function appendMessage(role, text, ts) {
    console.log('[DEBUG] appendMessage called:', { role, text, ts });
  
    const el = document.createElement('div');
    el.className = `wa-msg wa-${role}`;
  
    const textEl = document.createElement('span');
    textEl.className = 'wa-msg-text';
    textEl.textContent = text;
    el.appendChild(textEl);
  
    const timeEl = document.createElement('span');
    timeEl.className = 'wa-msg-ts';
    const date = ts ? new Date(ts) : new Date();
    timeEl.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.appendChild(timeEl);
  
    const msgs = document.getElementById('wa-messages');
    if (msgs) { 
      msgs.appendChild(el); 
      scrollToBottom(); 
    }
  }

  // ─── CARDS ────────────────────────────────────────────────────────────────

  function renderCard({ label, message, actionId, buttons }) {
    const card = document.createElement('div');
    card.className = 'wa-action-card';
    if (actionId) card.dataset.actionId = actionId;

    const btnsHtml = buttons.map((btn, i) => {
      const labelHtml = btn.label ? `<span class="wa-btn-label">${btn.label}</span>` : '';
      return `<button class="wa-btn wa-btn-${btn.style || 'confirm'}" data-btn-idx="${i}">
        ${labelHtml}${btn.text}
      </button>`;
    }).join('');

    // Convert line breaks to <br> for proper HTML display
    const formattedMessage = message.replace(/\n/g, '<br>');

    card.innerHTML = `
      <div class="wa-card-label">${label}</div>
      <p>${formattedMessage}</p>
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

  // ─── OPTIONS CARD ─────────────────────────────────────────────────────────

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

  // ─── PANEL ────────────────────────────────────────────────────────────────

  function toggleChat() {
    const panel = document.getElementById('wa-panel');
    const bubble = document.getElementById('wa-bubble');
    if (!panel) return;
    const isOpen = panel.classList.toggle('wa-open');

    if (isOpen) {
      const badge = document.getElementById('wa-badge');
      if (badge) badge.classList.remove('wa-show');
      
      // Swap bubble to close icon
      if (bubble) {
        bubble.innerHTML = '×<div class="wa-badge" id="wa-badge"></div>';
        bubble.classList.add('wa-close-mode');
      }
      
      // Trigger reconnect via WA.onPanelOpened if it exists
      if (typeof WA.onPanelOpened === 'function') WA.onPanelOpened();
    } else {
      // Swap bubble back to avatar
      if (bubble) {
        const avatarUrl = window.WA_CONFIG?.avatar_url || '';
        if (avatarUrl) {
          bubble.innerHTML = `<img src="${avatarUrl}" alt="Chat" class="wa-bubble-avatar" /><div class="wa-badge" id="wa-badge"></div>`;
        } else {
          bubble.innerHTML = '💬<div class="wa-badge" id="wa-badge"></div>';
        }
        bubble.classList.remove('wa-close-mode');
      }
    }

    return isOpen;
  }

  function openPanel() {
    const panel = document.getElementById('wa-panel');
    const bubble = document.getElementById('wa-bubble');
    if (panel && !panel.classList.contains('wa-open')) {
      panel.classList.add('wa-open');
      
      // Swap bubble to close icon
      if (bubble) {
        bubble.innerHTML = '×<div class="wa-badge" id="wa-badge"></div>';
        bubble.classList.add('wa-close-mode');
      }
    }
  }

  function openPanelDirect() {
    const panel = document.getElementById('wa-panel');
    if (panel && !panel.classList.contains('wa-open')) {
      panel.classList.add('wa-open');
    }
    scrollToBottom();
    if (typeof WA.updateSessionButton === 'function') WA.updateSessionButton();
  }

  function scrollToBottom() {
    const msgs = document.getElementById('wa-messages');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
  }

  // ─── BUTTONS ──────────────────────────────────────────────────────────────

  function updateAbortButton(hasActive) {
    const existing = document.getElementById('wa-abort-btn');
    const msgs     = document.getElementById('wa-messages');
    if (!msgs) return;

    if (hasActive && !existing) {
      const btn = document.createElement('button');
      btn.id        = 'wa-abort-btn';
      btn.className = 'wa-btn-abort';
      btn.textContent = '✕ Cancel action';
      btn.title     = 'Cancel current action';
      btn.onclick   = () => {
        if (typeof WA.abortCurrentAction === 'function') WA.abortCurrentAction();
      };
      msgs.appendChild(btn);
      scrollToBottom();
    } else if (!hasActive && existing) {
      existing.remove();
    }
  }

  function updateSessionButton(hasSession) {
    const existing = document.getElementById('wa-end-session-btn');
    const panel    = document.getElementById('wa-panel');
    if (!panel) return;

    if (hasSession && !existing) {
      const btn = document.createElement('button');
      btn.id        = 'wa-end-session-btn';
      btn.className = 'wa-btn-end-session';
      btn.textContent = 'End session';
      btn.title     = 'Clear conversation and start fresh';
      btn.onclick   = () => {
        if (confirm('End this session and clear the conversation?')) {
          if (typeof WA.endSession === 'function') WA.endSession();
        }
      };
      const inputRow = panel.querySelector('.wa-input-row');
      if (inputRow) panel.insertBefore(btn, inputRow);
      else panel.appendChild(btn);
    } else if (!hasSession && existing) {
      existing.remove();
    }
  }

  // ─── ACTION CARDS ─────────────────────────────────────────────────────────

  const ACTION_TYPE_LABELS = {
    navigate:          'Navigate',
    fill_form:         'Fill Form',
    navigate_then_fill:'Navigate',
    click_element:     'Click',
    scroll_to:         'Scroll'
  };

  function renderActionCard(action) {
    const actionTypeLabel = ACTION_TYPE_LABELS[action.type] || action.type;
    const messageParts = [action.description];
    if (action.payload?.targetLabel)  messageParts.push(`Destination: ${action.payload.targetLabel}`);
    else if (action.payload?.elementTitle) messageParts.push(`Section: ${action.payload.elementTitle}`);
    else if (action.payload?.elementText)  messageParts.push(`Element: ${action.payload.elementText}`);

    WA.renderCard({
      label:    'Proposed action',
      message:  messageParts.join('\n\n'),
      actionId: action.id,
      buttons: [
        { text: "Let's do it", label: actionTypeLabel, style: 'confirm', action: () => WA.confirmAction(action.id, WA.getSession()) },
        { text: 'No thanks', style: 'deny', action: () => WA.denyAction(action.id, WA.getSession()) }
      ]
    });
  }

  function renderMultiActionCard(actions) {
    const sorted = [...actions].sort((a, b) => (b.confidence || 0.8) - (a.confidence || 0.8));
    const buttons = sorted.map(action => {
      const label    = action.target_label || action.description || action.type;
      const conf     = action.confidence || 0.8;
      const indicator = conf < 0.7 ? ' (?)' : '';
      return {
        text:   label + indicator,
        label:  ACTION_TYPE_LABELS[action.type] || action.type,
        style:  'confirm',
        action: async () => { if (WA.executeDecidedAction) await WA.executeDecidedAction(action); }
      };
    });
    buttons.push({ text: 'No thanks', style: 'deny', action: () => { if (WA.setState) WA.setState('action', 'none'); } });
    WA.renderCard({ label: 'Choose an action', message: 'I found a few options for you:', buttons });
  }

  // ─── FIELD & FORM HELPERS ─────────────────────────────────────────────────

  function clearFieldHighlights() {
    document.querySelectorAll('.wa-filling').forEach(el => el.classList.remove('wa-filling'));
  }

  function highlightSubmitButton() {
    const btn = document.querySelector('.wpcf7-submit, [type="submit"], .btn-submit');
    if (btn) {
      btn.style.boxShadow = '0 0 0 3px rgba(200,75,47,0.5)';
      btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // ─── NAVIGATION TRANSITION ────────────────────────────────────────────────

  function showTransition(label) {
    const overlay  = document.getElementById('wa-transition');
    const navLabel = overlay ? overlay.querySelector('.wa-nav-label') : null;
    if (navLabel) navLabel.textContent = `Heading to ${label}…`;
    if (overlay)  overlay.classList.add('active');
  }

  // ─── RESET CHAT UI ────────────────────────────────────────────────────────

  function resetChatUI() {
    const msgs     = document.getElementById('wa-messages');
    const endBtn   = document.getElementById('wa-end-session-btn');
    const abortBtn = document.getElementById('wa-abort-btn');
    const panel    = document.getElementById('wa-panel');
    if (msgs)     msgs.innerHTML = '';
    if (endBtn)   endBtn.remove();
    if (abortBtn) abortBtn.remove();
    if (panel)    panel.classList.remove('wa-open');
  }

  // ─── DEBUG ────────────────────────────────────────────────────────────────

  function renderDebug() {
    const el = document.getElementById('wa-debug-output');
    if (!el || !WA.DEBUG) return;
    const session = WA.getSession ? WA.getSession() : {};
    el.textContent = JSON.stringify({
      state:   WA.State,
      page:    window.location.pathname,
      msgs:    session.messages?.length || 0,
      actions: (session.actions || []).map(a => ({ type: a.type, status: a.status })),
      pending: session.pendingOnArrival ? session.pendingOnArrival.page : null
    }, null, 2);
  }

  // ─── EXPOSE ───────────────────────────────────────────────────────────────

  WA.showTyping             = showTyping;
  WA.hideTyping             = hideTyping;
  WA.showWaitingHint        = showWaitingHint;
  WA.hideWaitingHint        = hideWaitingHint;
  WA.appendMessage          = appendMessage;
  WA.renderCard             = renderCard;
  WA.updateActionCardStatus = updateActionCardStatus;
  WA.renderOptionsCard      = renderOptionsCard;
  WA.renderActionCard       = renderActionCard;
  WA.renderMultiActionCard  = renderMultiActionCard;
  WA.toggleChat             = toggleChat;
  WA.openPanel              = openPanel;
  WA.openPanelDirect        = openPanelDirect;
  WA.scrollToBottom         = scrollToBottom;
  WA.updateAbortButton      = updateAbortButton;
  WA.updateSessionButton    = updateSessionButton;
  WA.clearFieldHighlights   = clearFieldHighlights;
  WA.highlightSubmitButton  = highlightSubmitButton;
  WA.showTransition         = showTransition;
  WA.resetChatUI            = resetChatUI;
  WA.renderDebug            = renderDebug;

})();
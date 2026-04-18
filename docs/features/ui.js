/**
 * features/ui.js — UI Rendering
 * All DOM manipulation, message rendering, cards, buttons, indicators
 * Reads state, emits events, but doesn't mutate global state
 */

(function () {

  const WA = window.WebsiteAvatar || (window.WebsiteAvatar = {});

  let typingEl          = null;
  let waitingHintEl     = null;
  let typingInterval    = null;
  let waitingHintActive = false;

  const LOADING_PHRASES = [
    'Thinking…',
    'Pulling that together…',
    'Reviewing your question…',
    'Checking the details…',
    'Connecting the dots…',
    'Gathering context…',
    'Working on it…',
    'Considering your options…',
    'Looking into that…',
    'One moment…',
  ];

  // ─── TYPING INDICATORS ────────────────────────────────────────────────────

  function showTyping() {
    if (typingEl) return;
    typingEl = document.createElement('div');
    const msgs = document.getElementById('wa-messages');

    const style = (window.WA_CONFIG && window.WA_CONFIG.loadingStyle) || 'dots';

    if (style === 'text') {
      typingEl.className = 'wa-typing wa-typing--text';
      const phrases = [...LOADING_PHRASES].sort(() => Math.random() - 0.5);
      let i = 0;
      typingEl.textContent = phrases[i];
      typingInterval = setInterval(() => {
        i = (i + 1) % phrases.length;
        if (typingEl) typingEl.textContent = phrases[i];
      }, 3000);
    } else {
      typingEl.className = 'wa-typing';
      typingEl.innerHTML = '<span></span><span></span><span></span>';
    }

    if (msgs) { msgs.appendChild(typingEl); scrollToBottom(); }
  }

  function hideTyping() {
    if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
    if (typingEl) { typingEl.remove(); typingEl = null; }
  }

  function showWaitingHint() {
    hideWaitingHint();
    const input = document.getElementById('wa-input');
    if (!input) return;
    input.dataset.hintPlaceholder = input.placeholder;
    input.placeholder = 'Type a message to start…';
    input.dataset.hint = 'true';
    waitingHintActive = true;
  }

  function hideWaitingHint() {
    if (waitingHintActive) {
      const input = document.getElementById('wa-input');
      if (input && input.dataset.hint) {
        input.placeholder = input.dataset.hintPlaceholder || 'Type a message…';
        delete input.dataset.hint;
        delete input.dataset.hintPlaceholder;
      }
      waitingHintActive = false;
    }
    if (waitingHintEl) { waitingHintEl.remove(); waitingHintEl = null; }
  }



  // ─── MESSAGE FORMATTING ───────────────────────────────────────────────────

  // ─── MESSAGES ─────────────────────────────────────────────────────────────

  function appendMessage(role, text, ts) {

    const el = document.createElement('div');
    el.className = `wa-msg wa-${role}`;

    const textEl = document.createElement('span');
    textEl.className = 'wa-msg-text';
    el.appendChild(textEl);

    const metaEl = document.createElement('span');
    metaEl.className = 'wa-msg-ts';
    const date = ts ? new Date(ts) : new Date();
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const senderLabel = role === 'agent'
      ? (window.WA_CONFIG?.agentName || 'Agent')
      : 'You';
    metaEl.textContent = `${senderLabel} · ${timeStr}`;
    el.appendChild(metaEl);

    const msgs = document.getElementById('wa-messages');
    if (msgs) {
      msgs.appendChild(el);
      // If an ecom action queued product images, render the strip directly after this bubble
      if (role === 'agent' && WA._pendingProductStrip?.length) {
        _renderProductStrip(WA._pendingProductStrip, el);
        WA._pendingProductStrip = null;
      }
      // If find_pages queued results while agent was answering, render card after this bubble
      if (role === 'agent' && WA._pendingContentResults?.length) {
        _renderContentResultsCard(WA._pendingContentResults);
        WA._pendingContentResults = null;
      }
      scrollToBottom();
    }

    // Trickle-in animation for agent messages only; user messages appear instantly.
    // Each message gets its own local interval — avoids shared-state collision when
    // multiple messages arrive in quick succession.
    if (role === 'agent') {
      const words = text.split(' ');
      let i = 0;
      let interval = null;

      const finish = () => {
        clearInterval(interval);
        textEl.textContent = text;
        el.removeEventListener('click', finish);
        const panel = document.getElementById('wa-panel');
        if (panel) panel.removeEventListener('click', finish);
        scrollToBottom();
      };

      el.addEventListener('click', finish);
      const panel = document.getElementById('wa-panel');
      if (panel) panel.addEventListener('click', finish);

      interval = setInterval(() => {
        i++;
        textEl.textContent = words.slice(0, i).join(' ');
        scrollToBottom();
        if (i >= words.length) finish();
      }, 40);
    } else {
      textEl.textContent = text;
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
        buttons[idx].action(btn);
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

  function _closePanelUI() {
    const panel  = document.getElementById('wa-panel');
    const bubble = document.getElementById('wa-bubble');
    if (panel) panel.classList.remove('wa-open');
    if (bubble) {
      const avatarUrl = window.WA_CONFIG?.avatar_url || '';
      bubble.innerHTML = avatarUrl
        ? `<img src="${avatarUrl}" alt="Chat" class="wa-bubble-avatar" />`
        : '💬';
      bubble.classList.remove('wa-close-mode');
    }
    _dismissCloseConfirm();
  }

  function _dismissCloseConfirm() {
    const bar = document.getElementById('wa-close-confirm');
    if (bar) bar.remove();
  }

  function _showCloseConfirm() {
    if (document.getElementById('wa-close-confirm')) return;
    const panel = document.getElementById('wa-panel');
    if (!panel) return;

    const bar = document.createElement('div');
    bar.id = 'wa-close-confirm';
    bar.className = 'wa-close-confirm';
    bar.innerHTML =
      '<span class="wa-close-confirm-label">Leave session running?</span>' +
      '<span class="wa-close-confirm-actions">' +
        '<button class="wa-close-confirm-btn wa-close-confirm-minimise">Minimise</button>' +
        '<button class="wa-close-confirm-btn wa-close-confirm-end">End &amp; close</button>' +
      '</span>';

    bar.querySelector('.wa-close-confirm-minimise').onclick = () => {
      // Just close the panel — session stays connected
      _closePanelUI();
    };
    bar.querySelector('.wa-close-confirm-end').onclick = () => {
      _closePanelUI();
      if (typeof WA.endSession === 'function') WA.endSession();
    };

    panel.appendChild(bar);
    // Auto-dismiss if user does nothing after 6 seconds
    setTimeout(() => _dismissCloseConfirm(), 6000);
  }

  function toggleChat() {
    const panel = document.getElementById('wa-panel');
    const bubble = document.getElementById('wa-bubble');
    if (!panel) return;

    const isCurrentlyOpen = panel.classList.contains('wa-open');

    if (!isCurrentlyOpen) {
      // Opening
      panel.classList.add('wa-open');
      const badge = document.getElementById('wa-badge');
      if (badge) badge.classList.remove('wa-show');
      if (bubble) {
        bubble.innerHTML = '×';
        bubble.classList.add('wa-close-mode');
      }
      if (typeof WA.onPanelOpened === 'function') WA.onPanelOpened();
      return true;
    } else {
      // Closing — intercept if a session is active
      _dismissCloseConfirm();
      const session = WA.getSession ? WA.getSession() : {};
      const hasActiveSession = session.messages?.length > 0 && WA.bridge?.isConnected?.();
      if (hasActiveSession) {
        _showCloseConfirm();
        return false;
      }
      _closePanelUI();
      return false;
    }
  }

  function openPanel() {
    const panel = document.getElementById('wa-panel');
    const bubble = document.getElementById('wa-bubble');
    if (panel && !panel.classList.contains('wa-open')) {
      panel.classList.add('wa-open');
      
      // Swap bubble to close icon
      if (bubble) {
        bubble.innerHTML = '×';
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

  // ─── PRODUCT STRIP ────────────────────────────────────────────────────────

  function _renderProductStrip(items, afterEl) {
    if (!items || !items.length) return;

    const strip = document.createElement('div');
    strip.className = 'wa-product-strip';

    items.forEach(item => {
      const card = document.createElement('div');
      card.className = 'wa-product-card';

      const hasImg = !!item.imageUrl;
      const priceStr = item.price ? `${item.currency || ''}${item.price}` : '';

      card.innerHTML = `
        <div class="wa-product-card-img-wrap">
          ${hasImg
            ? `<img src="${item.imageUrl}" alt="${item.name || ''}" loading="lazy"
                    onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />`
            : ''}
          <div class="wa-product-card-img-placeholder"${hasImg ? ' style="display:none"' : ''}></div>
          <button class="wa-product-card-expand" aria-label="Expand product">&#x2197;</button>
        </div>
        <div class="wa-product-card-body">
          <span class="wa-product-card-name">${item.name || ''}</span>
          <div class="wa-product-card-footer">
            ${priceStr ? `<span class="wa-product-card-price">${priceStr}</span>` : ''}
            ${item.qty ? `<span class="wa-product-card-qty">×${item.qty}</span>` : ''}
          </div>
        </div>
      `;

      card.querySelector('.wa-product-card-expand').addEventListener('click', (e) => {
        e.stopPropagation();
        _openProductLightbox(item);
      });
      card.querySelector('.wa-product-card-img-wrap').addEventListener('click', () => {
        _openProductLightbox(item);
      });

      strip.appendChild(card);
    });

    if (strip.children.length) {
      afterEl.after(strip);
    }
  }

  function _openProductLightbox(item) {
    const existing = document.getElementById('wa-product-lightbox');
    if (existing) existing.remove();

    const priceStr = item.price ? `${item.currency || ''}${item.price}` : '';
    const hasImg = !!item.imageUrl;

    const lb = document.createElement('div');
    lb.id = 'wa-product-lightbox';
    lb.className = 'wa-product-lightbox';
    lb.innerHTML = `
      <div class="wa-product-lightbox-card">
        <button class="wa-product-lightbox-close" aria-label="Close">×</button>
        <div class="wa-product-lightbox-img-wrap">
          ${hasImg
            ? `<img src="${item.imageUrl}" alt="${item.name || ''}" />`
            : `<div class="wa-product-lightbox-img-placeholder"></div>`}
        </div>
        <div class="wa-product-lightbox-body">
          <p class="wa-product-lightbox-name">${item.name || ''}</p>
          <div class="wa-product-lightbox-meta">
            ${priceStr ? `<span class="wa-product-lightbox-price">${priceStr}</span>` : ''}
            ${item.qty ? `<span class="wa-product-lightbox-qty">Qty: ${item.qty}</span>` : ''}
          </div>
          ${item.url ? `<a class="wa-product-lightbox-link" href="${item.url}" target="_blank" rel="noopener">View product ↗</a>` : ''}
        </div>
      </div>
    `;

    lb.addEventListener('click', (e) => { if (e.target === lb) lb.remove(); });
    lb.querySelector('.wa-product-lightbox-close').addEventListener('click', () => lb.remove());

    const panel = document.getElementById('wa-panel');
    if (panel) panel.appendChild(lb);
  }

  // ─── CONTENT RESULTS CARD ────────────────────────────────────────────────

  function _renderContentResultsCard(results) {
    if (!results || !results.length) return;

    // Remove any previous content results card — safety guard for repeated tool calls
    document.querySelectorAll('.wa-action-card[data-action-id="content-results"]').forEach(el => el.remove());

    const buttons = results.map(result => ({
      text:   result.title || result.url,
      label:  result.type || 'Page',
      style:  'confirm',
      action: () => { window.location.href = result.url; }
    }));

    buttons.push({
      text:   'No thanks',
      style:  'deny',
      action: (btn) => { btn.closest('.wa-action-card')?.remove(); }
    });

    WA.renderCard({
      actionId: 'content-results',
      label:    'Pages I found',
      message:  'Here are the most relevant pages — click one to go straight there:',
      buttons
    });
  }

  // ─── ECOM THINKING BUBBLE ────────────────────────────────────────────────
  // Ephemeral agent-style bubble shown while a client tool executes.
  // Created on the first intermediate agent phrase, updated in-place for
  // subsequent phrases, and removed before the real answer lands.

  function showEcomThinkingBubble(text) {
    // Remove any stale bubble first (safety guard)
    if (WA._ecomThinkingBubble) {
      WA._ecomThinkingBubble.remove();
      WA._ecomThinkingBubble = null;
    }
    const msgs = document.getElementById('wa-messages');
    if (!msgs) return;

    const el = document.createElement('div');
    el.className = 'wa-msg wa-agent wa-ecom-thinking';

    const textEl = document.createElement('span');
    textEl.className = 'wa-msg-text';
    textEl.textContent = text;
    el.appendChild(textEl);

    msgs.appendChild(el);
    WA._ecomThinkingBubble = el;
    scrollToBottom();
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
      if (inputRow) inputRow.insertAdjacentElement('afterend', btn);
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
    if (action.payload?.targetLabel)       messageParts.push(`Destination:<br><strong>${action.payload.targetLabel}</strong>`);
    else if (action.payload?.elementTitle) messageParts.push(`Section:<br><strong>${action.payload.elementTitle}</strong>`);
    else if (action.payload?.elementText)  messageParts.push(`Element:<br><strong>${action.payload.elementText}</strong>`);

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
    const bubble   = document.getElementById('wa-bubble');
    if (msgs)     msgs.innerHTML = '';
    if (endBtn)   endBtn.remove();
    if (abortBtn) abortBtn.remove();
    if (panel)    panel.classList.remove('wa-open');
    if (bubble) {
      const avatarUrl = window.WA_CONFIG?.avatar_url || '';
      bubble.innerHTML = avatarUrl
        ? `<img src="${avatarUrl}" alt="Chat" class="wa-bubble-avatar" />`
        : '💬';
      bubble.classList.remove('wa-close-mode');
    }
  }

  // ─── PAST CONVERSATIONS ───────────────────────────────────────────────────

  const PAST_SESSIONS_KEY = 'wa_past_sessions';

  function renderHistoryAuth() {
    const el = document.getElementById('wa-history-auth');
    if (!el) return;

    const user = WA.auth ? WA.auth.getCurrentUser() : null;

    if (user?.isAuthenticated) {
      el.innerHTML = `
        <div class="wa-history-auth-status">
          <div class="wa-history-auth-identity">
            <span class="wa-history-auth-label">Signed in as</span>
            <span class="wa-history-auth-email">${user.email}</span>
          </div>
          <button class="wa-history-auth-signout" id="wa-history-signout-btn">Sign out</button>
        </div>
      `;
      el.querySelector('#wa-history-signout-btn').addEventListener('click', () => {
        WA.auth.signOut();
        renderHistoryAuth();
      });
      return;
    }

    // Unauthenticated — show email sign-in form
    el.innerHTML = `
      <div class="wa-history-auth-form">
        <p class="wa-history-auth-hint">Sign in to save &amp; sync conversations across devices.</p>
        <div class="wa-history-auth-row">
          <input type="email" id="wa-history-auth-input" class="wa-history-auth-input"
            placeholder="your@email.com" autocomplete="email" />
          <button id="wa-history-auth-btn" class="wa-history-auth-btn">Send link</button>
        </div>
        <p id="wa-history-auth-msg" class="wa-history-auth-msg"></p>
      </div>
    `;

    const input  = el.querySelector('#wa-history-auth-input');
    const btn    = el.querySelector('#wa-history-auth-btn');
    const msg    = el.querySelector('#wa-history-auth-msg');

    async function submit() {
      const email = input.value.trim();
      if (!WA.auth?.isValidEmail(email)) {
        input.style.borderColor = '#c84b2f';
        input.focus();
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Sending…';
      const result = await WA.auth.requestMagicLink(email);
      if (result.success) {
        el.innerHTML = `
          <div class="wa-history-auth-status">
            <span class="wa-history-auth-label">Check your inbox</span>
            <span class="wa-history-auth-email">${email}</span>
          </div>
        `;
      } else {
        btn.disabled = false;
        btn.textContent = 'Send link';
        msg.textContent = result.error || 'Something went wrong — please try again.';
      }
    }

    btn.addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  }

  function openHistoryPanel() {
    const panel = document.getElementById('wa-history-panel');
    if (!panel) return;
    renderHistoryList();
    renderHistoryAuth();
    panel.classList.add('wa-history-visible');
    panel.setAttribute('aria-hidden', 'false');
  }

  function closeHistoryPanel() {
    const panel = document.getElementById('wa-history-panel');
    const view  = document.getElementById('wa-history-view');
    if (panel) {
      if (panel.contains(document.activeElement)) document.activeElement.blur();
      panel.classList.remove('wa-history-visible');
      panel.setAttribute('aria-hidden', 'true');
    }
    if (view)  { view.classList.remove('wa-history-visible');  view.setAttribute('aria-hidden', 'true'); }
  }

  function closeHistorySession() {
    const view = document.getElementById('wa-history-view');
    if (view) { view.classList.remove('wa-history-visible'); view.setAttribute('aria-hidden', 'true'); }
  }

  function openAdvicePanel() {
    const panel = document.getElementById('wa-advice-panel');
    if (!panel) return;
    panel.classList.add('wa-advice-visible');
    panel.setAttribute('aria-hidden', 'false');
  }

  function closeAdvicePanel() {
    const panel = document.getElementById('wa-advice-panel');
    if (panel) {
      if (panel.contains(document.activeElement)) document.activeElement.blur();
      panel.classList.remove('wa-advice-visible');
      panel.setAttribute('aria-hidden', 'true');
    }
  }

  // Groups sessions into conversations using actual message timestamps.
  // The gap is measured between the last message of one session and the first
  // message of the next — if under 20 mins they belong to the same conversation.
  // Messages are deduplicated by ts so repeated saves don't double up.
  function groupSessionsByGap(sessions, gapMs = 20 * 60 * 1000) {
    if (!sessions.length) return [];

    // Flatten to individual messages, each tagged with their source session
    const allMsgs = sessions.flatMap(s =>
      (s.messages || []).map(m => ({ ...m, _sessionId: s.id }))
    );

    // Deduplicate by ts (same message saved in multiple snapshots)
    const seen = new Set();
    const unique = allMsgs.filter(m => {
      const key = m.ts ? String(m.ts) : `${m.role}:${m.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort all unique messages chronologically
    unique.sort((a, b) => (a.ts || 0) - (b.ts || 0));

    if (!unique.length) return [];

    // Split into conversations wherever there is a gap > 20 mins between messages
    const conversations = [];
    let current = [unique[0]];

    for (let i = 1; i < unique.length; i++) {
      const gap = (unique[i].ts || 0) - (unique[i - 1].ts || 0);
      if (gap > gapMs) {
        conversations.push(current);
        current = [];
      }
      current.push(unique[i]);
    }
    conversations.push(current);

    // Return newest-first
    return conversations.reverse().map(msgs => {
      const firstUserMsg = msgs.find(m => m.role === 'user');
      return {
        startedAt:    msgs[0]?.ts || 0,
        messageCount: msgs.length,
        messages:     msgs,
        snippet:      firstUserMsg?.text || ''
      };
    });
  }

  function renderHistoryList() {
    const listEl = document.getElementById('wa-history-list');
    if (!listEl) return;

    let sessions = [];
    try { sessions = JSON.parse(localStorage.getItem(PAST_SESSIONS_KEY) || '[]'); } catch (e) {}

    if (!sessions.length) {
      listEl.innerHTML = '<p class="wa-history-empty">No past conversations yet.</p>';
      return;
    }

    const grouped = groupSessionsByGap(sessions);

    listEl.innerHTML = '';
    grouped.forEach(s => {
      const date    = new Date(s.startedAt);
      const dateStr = date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
      const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const snippet = s.snippet ? s.snippet.slice(0, 72) + (s.snippet.length > 72 ? '…' : '') : '';

      const item = document.createElement('button');
      item.className = 'wa-history-item';
      item.innerHTML = `
        <div class="wa-history-item-meta">
          <span class="wa-history-item-date">${dateStr} · ${timeStr}</span>
          <span class="wa-history-item-count">${s.messageCount} msgs</span>
        </div>
        ${snippet ? `<div class="wa-history-item-snippet">${snippet}</div>` : ''}
      `;
      item.onclick = () => renderHistorySession(s);
      listEl.appendChild(item);
    });
  }

  function renderHistorySession(sessionData) {
    const view   = document.getElementById('wa-history-view');
    const msgsEl = document.getElementById('wa-history-view-msgs');
    const dateEl = document.getElementById('wa-history-view-date');
    if (!view || !msgsEl) return;

    if (dateEl) {
      const date = new Date(sessionData.startedAt);
      dateEl.textContent = date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
    }

    msgsEl.innerHTML = '';
    (sessionData.messages || []).forEach(m => {
      const el = document.createElement('div');
      el.className = `wa-msg wa-${m.role}`;

      const textEl = document.createElement('span');
      textEl.className = 'wa-msg-text';
      textEl.textContent = m.text;
      el.appendChild(textEl);

      if (m.ts) {
        const tsEl = document.createElement('span');
        tsEl.className = 'wa-msg-ts';
        tsEl.textContent = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        el.appendChild(tsEl);
      }

      msgsEl.appendChild(el);
    });

    view.classList.add('wa-history-visible');
    view.setAttribute('aria-hidden', 'false');
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  // ─── MAGIC LINK PROMPT ────────────────────────────────────────────────────

  const MAGIC_PROMPT_ID = 'wa-magic-link-prompt';

  function showMagicLinkPrompt() {
    // Don't show if already visible or user is authenticated
    if (document.getElementById(MAGIC_PROMPT_ID)) return;
    if (WA.auth && WA.auth.getCurrentUser().isAuthenticated) return;

    const msgs = document.getElementById('wa-messages');
    if (!msgs) return;

    const card = document.createElement('div');
    card.id = MAGIC_PROMPT_ID;
    card.className = 'wa-action-card';
    card.innerHTML = `
      <div class="wa-card-label">Save your conversation</div>
      <p>Enter your email to pick up this chat on any device — no password needed.</p>
      <div class="wa-magic-input-row">
        <input type="email" class="wa-magic-email" placeholder="you@example.com" autocomplete="email" />
        <button class="wa-btn wa-btn-confirm wa-magic-submit">Send link</button>
      </div>
      <button class="wa-magic-dismiss">No thanks</button>
    `;

    const emailInput  = card.querySelector('.wa-magic-email');
    const submitBtn   = card.querySelector('.wa-magic-submit');
    const dismissBtn  = card.querySelector('.wa-magic-dismiss');

    submitBtn.addEventListener('click', () => handleMagicLinkSubmit(card, emailInput.value.trim()));
    emailInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleMagicLinkSubmit(card, emailInput.value.trim()); });
    dismissBtn.addEventListener('click', () => card.remove());

    msgs.appendChild(card);
    scrollToBottom();
    setTimeout(() => emailInput.focus(), 100);
  }

  async function handleMagicLinkSubmit(card, email) {
    if (!WA.auth || !WA.auth.isValidEmail(email)) {
      const input = card.querySelector('.wa-magic-email');
      if (input) { input.style.borderColor = '#c84b2f'; input.focus(); }
      return;
    }

    const submitBtn = card.querySelector('.wa-magic-submit');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Sending…'; }

    const result = await WA.auth.requestMagicLink(email);

    if (result.success) {
      card.innerHTML = `
        <div class="wa-card-label">Check your inbox</div>
        <p>We sent a sign-in link to <strong>${email}</strong>. Click it to save your conversation.</p>
      `;
    } else {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Send link'; }
      const row = card.querySelector('.wa-magic-input-row');
      if (row) {
        let err = row.querySelector('.wa-magic-error');
        if (!err) { err = document.createElement('p'); err.className = 'wa-magic-error'; row.appendChild(err); }
        err.textContent = result.error || 'Something went wrong. Please try again.';
      }
    }
    scrollToBottom();
  }

  function detectEmailInMessage(text) {
    if (!WA.auth) return;
    if (WA.auth.getCurrentUser().isAuthenticated) return;

    const email = WA.auth.extractEmail(text);
    if (!email) return;

    const msgs = document.getElementById('wa-messages');
    if (!msgs) return;
    if (document.getElementById(MAGIC_PROMPT_ID)) return;

    const card = document.createElement('div');
    card.id = MAGIC_PROMPT_ID;
    card.className = 'wa-action-card';
    card.innerHTML = `
      <div class="wa-card-label">Save your conversation</div>
      <p>Want us to send a sign-in link to <strong>${email}</strong> so you can continue this chat later?</p>
      <div class="wa-card-btns">
        <button class="wa-btn wa-btn-confirm wa-magic-confirm">Yes, send it</button>
        <button class="wa-btn wa-btn-deny wa-magic-deny">No thanks</button>
      </div>
    `;

    card.querySelector('.wa-magic-confirm').addEventListener('click', () => handleMagicLinkSubmit(card, email));
    card.querySelector('.wa-magic-deny').addEventListener('click', () => card.remove());

    msgs.appendChild(card);
    scrollToBottom();
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

  // ─── FULL SCREEN ──────────────────────────────────────────────────────────

  // Lucide Maximize2 / Minimize2
  const EXPAND_ICON   = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
  const COMPRESS_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>`;

  // Sound wave icon — used for both inactive and active states
  const VOICE_ICON     = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="14" x2="4" y2="10"/><line x1="8" y1="16" x2="8" y2="8"/><line x1="12" y1="18" x2="12" y2="6"/><line x1="16" y1="16" x2="16" y2="8"/><line x1="20" y1="14" x2="20" y2="10"/></svg>`;
  const VOICE_END_ICON = VOICE_ICON + `<span>End</span>`;

  let voiceModeActive = false;

  // ─── VOICE MODE ───────────────────────────────────────────────────────────────

  function _applyVoiceModeUI(active) {
    const panel = document.getElementById('wa-panel');
    const btn   = document.getElementById('wa-voice-toggle');
    const orb   = document.getElementById('wa-orb-panel');
    if (!panel || !btn) return;
    voiceModeActive = active;
    panel.classList.toggle('wa-voice-mode', active);
    btn.classList.toggle('wa-voice-active', active);
    btn.innerHTML = active ? VOICE_END_ICON : VOICE_ICON;
    btn.setAttribute('aria-label', active ? 'Switch to text' : 'Switch to voice');
    btn.setAttribute('title',      active ? 'Text conversation' : 'Voice conversation');
    if (orb) orb.setAttribute('aria-hidden', String(!active));
  }

  function toggleVoiceMode() {
    if (!voiceModeActive) {
      // Entering voice mode — disable actions (voice agent has no action capability)
      _applyVoiceModeUI(true);
      WA.actionsDisabled = true;
      if (WA.setOrbState) WA.setOrbState('idle');
      if (WA.bridge?.connectVoice) WA.bridge.connectVoice();
    } else {
      // Leaving voice mode — restore actions for text agent
      _applyVoiceModeUI(false);
      WA.actionsDisabled = false;
      if (WA.bridge?.disconnectVoice) WA.bridge.disconnectVoice();
    }
  }

  // Called from wa-dialogue.js if voice session drops unexpectedly
  function exitVoiceMode() {
    if (voiceModeActive) {
      _applyVoiceModeUI(false);
      WA.actionsDisabled = false;
    }
  }

  function setOrbState(state) {
    const orb = document.getElementById('wa-orb');
    const statusEl = document.getElementById('wa-voice-status');
    if (!orb) return;
    orb.className = `wa-orb wa-orb-${state}`;
    const labels = {
      idle:       'Listening…',
      listening:  'Listening…',
      processing: 'Thinking…',
      speaking:   'Speaking…'
    };
    if (statusEl) statusEl.textContent = labels[state] || '';
  }

  // ─── FULL SCREEN ──────────────────────────────────────────────────────────────

  function toggleFullscreen() {
    const panel = document.getElementById('wa-panel');
    const btn   = document.getElementById('wa-fullscreen-btn');
    if (!panel) return;

    const isFullscreen = panel.classList.toggle('wa-fullscreen');
    WA.actionsDisabled = isFullscreen;
    if (btn) btn.innerHTML = isFullscreen ? COMPRESS_ICON : EXPAND_ICON;
  }

  // ─── EXPOSE ───────────────────────────────────────────────────────────────

  WA.showTyping             = showTyping;
  WA.hideTyping             = hideTyping;
  WA.showWaitingHint        = showWaitingHint;
  WA.hideWaitingHint        = hideWaitingHint;
  WA.appendMessage          = appendMessage;
  WA.renderCard             = renderCard;
  WA.renderPendingContentCard = function () {
    if (WA._pendingContentResults?.length) {
      document.querySelectorAll('.wa-action-card[data-action-id="content-results"]').forEach(el => el.remove());
      _renderContentResultsCard(WA._pendingContentResults);
      WA._pendingContentResults = null;
    }
  };
  WA.updateActionCardStatus = updateActionCardStatus;
  WA.renderOptionsCard      = renderOptionsCard;
  WA.renderActionCard       = renderActionCard;
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
  WA.openHistoryPanel       = openHistoryPanel;
  WA.closeHistoryPanel      = closeHistoryPanel;
  WA.closeHistorySession    = closeHistorySession;
  WA.openAdvicePanel        = openAdvicePanel;
  WA.closeAdvicePanel       = closeAdvicePanel;
  WA.toggleFullscreen       = toggleFullscreen;
  WA.toggleVoiceMode        = toggleVoiceMode;
  WA.exitVoiceMode          = exitVoiceMode;
  WA.setOrbState            = setOrbState;
  WA.renderHistorySession   = renderHistorySession;
  WA.renderDebug            = renderDebug;
  WA.showMagicLinkPrompt    = showMagicLinkPrompt;
  WA.detectEmailInMessage   = detectEmailInMessage;
  WA.renderHistoryAuth      = renderHistoryAuth;
  WA.showEcomThinkingBubble = showEcomThinkingBubble;

})();
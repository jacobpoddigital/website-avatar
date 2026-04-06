/**
 * features/ui.js — UI Rendering
 * All DOM manipulation, message rendering, cards, buttons, indicators
 * Reads state, emits events, but doesn't mutate global state
 */

(function () {

  const WA = window.WebsiteAvatar || (window.WebsiteAvatar = {});

  let typingEl      = null;
  let waitingHintEl = null;
  let typingInterval = null;

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

  // ─── MESSAGE FORMATTING ───────────────────────────────────────────────────

  function formatMessage(text) {
    // Step 1: escape HTML to prevent XSS — content comes from an external source
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Step 2: apply formatting patterns in order
    const lines = escaped.split('\n');
    const output = [];
    let inList = false;
    let listTag = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const bulletMatch = line.match(/^-\s+(.+)/);
      const orderedMatch = line.match(/^(\d+)\.\s+(.+)/);

      if (bulletMatch) {
        if (!inList || listTag !== 'ul') {
          if (inList) output.push(`</${listTag}>`);
          output.push('<ul>');
          inList = true; listTag = 'ul';
        }
        output.push(`<li>${applyInline(bulletMatch[1])}</li>`);
      } else if (orderedMatch) {
        if (!inList || listTag !== 'ol') {
          if (inList) output.push(`</${listTag}>`);
          output.push('<ol>');
          inList = true; listTag = 'ol';
        }
        output.push(`<li>${applyInline(orderedMatch[2])}</li>`);
      } else {
        if (inList) { output.push(`</${listTag}>`); inList = false; listTag = ''; }
        if (line.trim() === '') {
          // Suppress <br> if the next non-empty line will open a list — avoids double gap
          const next = lines.slice(i + 1).find(l => l.trim() !== '');
          if (!next || (!next.match(/^-\s+/) && !next.match(/^\d+\.\s+/))) {
            output.push('<br>');
          }
        } else {
          output.push(applyInline(line));
        }
      }
    }

    if (inList) output.push(`</${listTag}>`);
    return output.join('\n');
  }

  function applyInline(text) {
    // **bold**
    return text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }

  // ─── MESSAGES ─────────────────────────────────────────────────────────────

  function appendMessage(role, text, ts) {

    const el = document.createElement('div');
    el.className = `wa-msg wa-${role}`;

    const textEl = document.createElement('span');
    textEl.className = 'wa-msg-text';
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

    // Trickle-in animation for agent messages only; user messages appear instantly.
    // Each message gets its own local interval — avoids shared-state collision when
    // multiple messages arrive in quick succession.
    if (role === 'agent') {
      const words = text.split(' ');
      let i = 0;
      let interval = null;

      const finish = () => {
        clearInterval(interval);
        textEl.innerHTML = formatMessage(text);
        el.removeEventListener('click', finish);
        const panel = document.getElementById('wa-panel');
        if (panel) panel.removeEventListener('click', finish);
      };

      el.addEventListener('click', finish);
      const panel = document.getElementById('wa-panel');
      if (panel) panel.addEventListener('click', finish);

      interval = setInterval(() => {
        i++;
        textEl.textContent = words.slice(0, i).join(' ');
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
    const bubble   = document.getElementById('wa-bubble');
    if (msgs)     msgs.innerHTML = '';
    if (endBtn)   endBtn.remove();
    if (abortBtn) abortBtn.remove();
    if (panel)    panel.classList.remove('wa-open');
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

  // ─── PAST CONVERSATIONS ───────────────────────────────────────────────────

  const PAST_SESSIONS_KEY = 'wa_past_sessions';

  function renderHistoryAuth() {
    const el = document.getElementById('wa-history-auth');
    if (!el) return;

    const user = WA.auth ? WA.auth.getCurrentUser() : null;

    if (user?.isAuthenticated) {
      el.innerHTML = `
        <div class="wa-history-auth-status">
          <span class="wa-history-auth-label">Signed in as</span>
          <span class="wa-history-auth-email">${user.email}</span>
        </div>
      `;
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

  const EXPAND_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`;
  const COMPRESS_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>`;

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
  WA.openHistoryPanel       = openHistoryPanel;
  WA.closeHistoryPanel      = closeHistoryPanel;
  WA.closeHistorySession    = closeHistorySession;
  WA.openAdvicePanel        = openAdvicePanel;
  WA.closeAdvicePanel       = closeAdvicePanel;
  WA.toggleFullscreen       = toggleFullscreen;
  WA.renderHistorySession   = renderHistorySession;
  WA.renderDebug            = renderDebug;
  WA.showMagicLinkPrompt    = showMagicLinkPrompt;
  WA.detectEmailInMessage   = detectEmailInMessage;
  WA.renderHistoryAuth      = renderHistoryAuth;

})();
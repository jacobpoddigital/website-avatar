/**
 * greeting.js — First-visit greeting widget for Website Avatar
 * Shows a welcome message on first visit, stores flag for 30 days
 */

(function() {
    'use strict';
  
    const STORAGE_KEY = 'wa_greeting_dismissed';
    const EXPIRY_DAYS = 30;
  
    window.WebsiteAvatarGreeting = {
      
      /**
       * Check if greeting should be shown.
       * Dev override: add ?wa_greeting=1 to the URL to bypass the dismissed flag.
       */
      shouldShow() {
        if (new URLSearchParams(window.location.search).get('wa_greeting')) return true;

        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored) return true;

        try {
          const data = JSON.parse(stored);
          const now = Date.now();
          // Check if 30 days have passed
          if (now > data.expiry) {
            localStorage.removeItem(STORAGE_KEY);
            return true;
          }
          return false;
        } catch(e) {
          localStorage.removeItem(STORAGE_KEY);
          return true;
        }
      },
  
      /**
       * Mark greeting as dismissed for 30 days
       */
      dismiss() {
        const now = Date.now();
        const expiry = now + (EXPIRY_DAYS * 24 * 60 * 60 * 1000);
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ expiry }));
      },
  
      getVariant() {
        const param = new URLSearchParams(window.location.search).get('wa_greeting');
        if (param === 'v2' || param === 'v3' || param === 'v4' || param === 'v5' || param === 'v6') return param;
        return 'control';
      },

      /**
       * Show the greeting widget with fade-in animation
       */
      show(delay = 1000) {
        if (!this.shouldShow()) return;

        const variant = this.getVariant();
        const greeting = document.getElementById('wa-greeting');
        const bubble = document.getElementById('wa-bubble');
        if (!greeting) return;

        greeting.classList.add(`wa-variant-${variant}`);

        if (variant === 'v5') this._buildV5Columns(greeting);
        if (variant === 'v6') this._buildV6Layout(greeting);

        setTimeout(() => {
          greeting.classList.add('wa-greeting-visible');
          if (bubble) bubble.classList.add('wa-hidden');
          if (variant !== 'control') {
            this._animateVariantEntry(greeting);
          }
        }, delay);
      },
  
      /**
       * Hide the greeting widget with fade-out
       */
      hide() {
        const greeting = document.getElementById('wa-greeting');
        const bubble = document.getElementById('wa-bubble');
        if (!greeting) return;
        
        greeting.classList.remove('wa-greeting-visible');
        
        // Show bubble after greeting is dismissed
        if (bubble) {
          setTimeout(() => {
            bubble.classList.remove('wa-hidden');
          }, 200);
        }
        
        // Remove from DOM after animation completes
        setTimeout(() => {
          greeting.style.display = 'none';
        }, 400);
      },
  
      /**
       * Handle "Chat" button - open main widget in text mode
       */
      handleStart() {
        this.dismiss();
        this.hide();

        setTimeout(() => {
          if (window.WebsiteAvatar && window.WebsiteAvatar.toggleChat) {
            window.WebsiteAvatar.toggleChat();
          } else if (window.WebsiteAvatar && window.WebsiteAvatar.openChat) {
            window.WebsiteAvatar.openChat();
          }
        }, 300);
      },

      /**
       * Handle "Speak" button - open main widget then activate voice mode
       */
      handleSpeak() {
        this.dismiss();
        this.hide();

        setTimeout(() => {
          const WA = window.WebsiteAvatar;
          if (!WA) return;
          if (WA.toggleChat) WA.toggleChat();
          else if (WA.openChat) WA.openChat();

          // Give the panel a moment to open before toggling voice
          setTimeout(() => {
            if (WA.toggleVoiceMode) WA.toggleVoiceMode();
          }, 200);
        }, 300);
      },

      /**
       * Handle "Accept" on consent block.
       * WA_acceptConsent records consent AND clears both the greeting block
       * and the widget banner in a single call.
       */
      handleAcceptConsent() {
        if (window.WA_acceptConsent) window.WA_acceptConsent();
      },

      /**
       * Handle "Close" button - just dismiss
       */
      handleClose() {
        this.dismiss();
        this.hide();
      },
  
      /**
       * Initialize - called from main widget
       */
      init() {
        // Hide bubble initially if greeting will show
        if (this.shouldShow()) {
          const bubble = document.getElementById('wa-bubble');
          if (bubble) {
            bubble.classList.add('wa-hidden');
          }
        }
        
        this.attachEventListeners();
        this.show();
      },
  
      _buildV6Layout(greeting) {
        const container = greeting.querySelector('.wa-greeting-container');
        if (!container) return;

        const cfg         = window.WA_CONFIG || {};
        const avatarSrc   = cfg.avatar_url || container.querySelector('.wa-greeting-orb img')?.src || '';
        const agentName   = cfg.agentName   || 'Your Assistant';
        const headline    = cfg.greetingHeadline || "I'm here to help!";
        const bubbleText  = container.querySelector('.wa-greeting-bubble p')?.textContent || '';
        const bulletsEl   = container.querySelector('.wa-greeting-bullets');
        const actionsEl   = container.querySelector('.wa-greeting-actions');
        const consentEl   = container.querySelector('.wa-greeting-consent-block');

        // ── Avatar column ──────────────────────────────────────────────────
        const avatarCol = document.createElement('div');
        avatarCol.className = 'wa-v6-avatar-col';

        const speech = document.createElement('div');
        speech.className = 'wa-v6-speech';
        const speechP = document.createElement('p');
        speechP.textContent = bubbleText;
        speech.appendChild(speechP);

        if (avatarSrc) {
          const img = document.createElement('img');
          img.className = 'wa-v6-avatar-img';
          img.src = avatarSrc;
          img.alt = agentName;
          avatarCol.appendChild(speech);
          avatarCol.appendChild(img);
        } else {
          const orbEl = container.querySelector('.wa-greeting-orb');
          if (orbEl) avatarCol.appendChild(orbEl);
          avatarCol.appendChild(speech);
        }

        // ── Content column ─────────────────────────────────────────────────
        const contentCol = document.createElement('div');
        contentCol.className = 'wa-v6-content-col';

        const headlineEl = document.createElement('h2');
        headlineEl.className = 'wa-v6-headline';
        headlineEl.textContent = headline;

        const sigEl = document.createElement('div');
        sigEl.className = 'wa-v6-signature';
        sigEl.textContent = agentName;

        contentCol.appendChild(headlineEl);
        contentCol.appendChild(sigEl);
        if (consentEl) contentCol.appendChild(consentEl);
        if (actionsEl) contentCol.appendChild(actionsEl);

        // ── Bullets column ─────────────────────────────────────────────────
        const bulletsCol = document.createElement('div');
        bulletsCol.className = 'wa-v6-bullets-col';
        if (bulletsEl) bulletsCol.appendChild(bulletsEl);

        // ── Credit badge ───────────────────────────────────────────────────
        const credit = document.createElement('div');
        credit.className = 'wa-v6-credit';
        credit.innerHTML = `<span>${agentName}</span><span class="wa-v6-ai-badge">AI</span>`;

        // ── Assemble bar ───────────────────────────────────────────────────
        const bar = document.createElement('div');
        bar.className = 'wa-v6-bar';
        bar.appendChild(avatarCol);
        bar.appendChild(contentCol);
        bar.appendChild(bulletsCol);
        bar.appendChild(credit);

        container.remove();
        greeting.appendChild(bar);
      },

      _buildV5Columns(greeting) {
        const container = greeting.querySelector('.wa-greeting-container');
        if (!container) return;

        const left  = document.createElement('div');
        left.className  = 'wa-greeting-left';
        const right = document.createElement('div');
        right.className = 'wa-greeting-right';

        ['wa-greeting-bubble', 'wa-greeting-orb', 'wa-greeting-name'].forEach(cls => {
          const el = container.querySelector('.' + cls);
          if (el) left.appendChild(el);
        });

        Array.from(container.children).forEach(el => right.appendChild(el));

        container.appendChild(left);
        container.appendChild(right);
      },

      _typeText(el, onComplete) {
        const text = el.textContent.trim();
        el.textContent = '';

        const cursor = document.createElement('span');
        cursor.className = 'wa-typing-cursor';
        el.appendChild(cursor);

        let i = 0;
        const tick = () => {
          if (i < text.length) {
            cursor.insertAdjacentText('beforebegin', text[i]);
            i++;
            setTimeout(tick, 28 + Math.random() * 22);
          } else {
            setTimeout(() => {
              cursor.remove();
              if (onComplete) onComplete();
            }, 400);
          }
        };
        setTimeout(tick, 150);
      },

      _animateVariantEntry(greeting) {
        const bubbleP = greeting.querySelector('.wa-greeting-bubble p') || greeting.querySelector('.wa-v6-speech p');
        const bullets = greeting.querySelectorAll('.wa-greeting-bullets-list li');
        const actionsEl = document.getElementById('wa-greeting-actions');
        const consentGiven = !!localStorage.getItem('wa_gdpr_consent');

        if (!bubbleP) return;

        bullets.forEach(li => {
          li.style.opacity = '0';
          li.style.transform = 'translateY(8px)';
        });

        if (actionsEl && consentGiven) {
          actionsEl.style.opacity = '0';
          actionsEl.style.transform = 'translateY(8px)';
        }

        this._typeText(bubbleP, () => {
          bullets.forEach((li, i) => {
            setTimeout(() => {
              li.style.transition = 'opacity 0.35s ease, transform 0.35s ease';
              li.style.opacity = '1';
              li.style.transform = 'translateY(0)';
            }, i * 160);
          });

          const actionsDelay = bullets.length * 160 + 80;
          if (actionsEl && consentGiven) {
            setTimeout(() => {
              actionsEl.style.transition = 'opacity 0.35s ease, transform 0.35s ease';
              actionsEl.style.opacity = '1';
              actionsEl.style.transform = 'translateY(0)';
            }, actionsDelay);
          }
        });
      },

      /**
       * Attach click handlers to greeting buttons
       */
      attachEventListeners() {
        const greeting = document.getElementById('wa-greeting');
        if (!greeting) return;
  
        const speakBtn       = greeting.querySelector('[data-action="speak"]');
        const startBtn       = greeting.querySelector('[data-action="start"]');
        const closeBtns      = greeting.querySelectorAll('[data-action="close"]');
        const acceptBtn      = greeting.querySelector('[data-action="accept-consent"]');

        if (speakBtn) {
          if (!window.WA_CONFIG?.voiceAgentId) {
            speakBtn.style.display = 'none';
          } else {
            speakBtn.onclick = (e) => { e.preventDefault(); this.handleSpeak(); };
          }
        }

        if (startBtn) {
          startBtn.onclick = (e) => { e.preventDefault(); this.handleStart(); };
        }

        closeBtns.forEach(btn => {
          btn.onclick = (e) => { e.preventDefault(); this.handleClose(); };
        });

        if (acceptBtn) {
          acceptBtn.onclick = (e) => { e.preventDefault(); this.handleAcceptConsent(); };
        }
  
        // Close on overlay click
        const overlay = greeting.querySelector('.wa-greeting-overlay');
        if (overlay) {
          overlay.onclick = (e) => {
            if (e.target === overlay) {
              this.handleClose();
            }
          };
        }
      }
    };
  
  })();
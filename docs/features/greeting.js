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
        if (new URLSearchParams(window.location.search).get('wa_greeting') === '1') return true;

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
  
      /**
       * Show the greeting widget with fade-in animation
       */
      show(delay = 1000) {
        if (!this.shouldShow()) return;
        
        const greeting = document.getElementById('wa-greeting');
        const bubble = document.getElementById('wa-bubble');
        if (!greeting) return;
  
        setTimeout(() => {
          greeting.classList.add('wa-greeting-visible');
          // Hide bubble while greeting is showing
          if (bubble) {
            bubble.classList.add('wa-hidden');
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